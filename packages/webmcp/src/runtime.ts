import { ApprovalManager, type PendingAction } from "./approval.ts";
import { AuditBus, now, type AuditEvent } from "./audit.ts";
import { availableCapabilities } from "./availability.ts";
import {
  CapabilityUnavailableError,
  defineCapability,
  unavailable,
  type AppContext,
  type Capability,
  type CapabilityName,
  type RiskLevel,
  type Unavailability,
} from "./capability.ts";
import { CapabilityCatalog } from "./catalog.ts";
import { decidePolicy } from "./policy.ts";
import { isRouteError, rankCapabilities, routeCapability } from "./router.ts";
import {
  approvalRequired,
  capabilityUnavailable,
  errorResult,
  toToolResult,
  type ToolResult,
} from "./results.ts";
import { ToolSurfaceManager } from "./tool-surface.ts";
import {
  createWebMcpAdapter,
  type RegisterToolFn,
  type WebMcpAdapter,
} from "./webmcp-adapter.ts";

const FIND_CAPABILITIES = "find_capabilities";
const INVOKE_CAPABILITY = "invoke_capability";
const GET_CONTEXT = "get_context";
const GET_ACTION_STATUS = "get_action_status";

const BUILTIN_NAMES = new Set([
  FIND_CAPABILITIES,
  INVOKE_CAPABILITY,
  GET_CONTEXT,
  GET_ACTION_STATUS,
]);

export type Exposure = "routed" | "flat";

export type RoutedMatch = {
  name: string;
  title?: string;
  description: string;
  risk: RiskLevel;
  score: number;
  available: boolean;
  requiresApproval: boolean;
  reasonCode?: string;
  reason?: string;
  suggestedCapability?: string;
};

export type RoutingReport = {
  query: string;
  matches: RoutedMatch[];
  activated: string[];
  at: number;
};

export type RuntimeSnapshot = {
  started: boolean;
  supported: boolean;
  route: string;
  exposure: Exposure;
  catalogSize: number;
  nativeTools: string[];
  tombstones: string[];
  routedTools: string[];
  available: CapabilityName[];
  pending: PendingAction[];
  lastRouting: RoutingReport | null;
  schemaBytes: number;
  audit: readonly AuditEvent[];
};

export type AgentDeskRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setContext: (ctx: AppContext) => Promise<void>;
  setExposure: (exposure: Exposure) => Promise<void>;
  routeTask: (query: string) => Promise<Record<string, unknown>>;
  reset: () => Promise<void>;
  getSnapshot: () => RuntimeSnapshot;
  subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void;
  invoke: (name: string, input?: Record<string, unknown>) => Promise<ToolResult>;
  approve: (actionId: string) => Promise<ToolResult>;
  reject: (actionId: string) => ToolResult;
};

export function createAgentDeskRuntime(options: {
  capabilities?: readonly Capability[];
  registerTool?: RegisterToolFn | null;
  adapter?: WebMcpAdapter;
  exposure?: Exposure;
  describeContext?: (ctx: AppContext) => Record<string, unknown>;
}): AgentDeskRuntime {
  const audit = new AuditBus();
  const approvals = new ApprovalManager();
  const adapter =
    options.adapter ??
    createWebMcpAdapter(
      options.registerTool !== undefined
        ? { registerTool: options.registerTool }
        : undefined,
    );

  const appCapabilities = options.capabilities ?? [];
  const catalog = new CapabilityCatalog([
    ...builtinCapabilities(),
    ...appCapabilities,
  ]);

  let context: AppContext = { route: "/", state: {} };
  let exposure: Exposure = options.exposure ?? "routed";
  let started = false;
  let routedNames = new Set<string>();
  let lastRouting: RoutingReport | null = null;
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();

  const surface = new ToolSurfaceManager(
    adapter,
    audit,
    (capability, input) => runCapability(capability, input, "native"),
    () => emit(),
  );

  function appOnly(capability: Capability): boolean {
    return !BUILTIN_NAMES.has(capability.name);
  }

  function snapshot(): RuntimeSnapshot {
    return {
      started,
      supported: adapter.supported,
      route: context.route,
      exposure,
      catalogSize: appCapabilities.length,
      nativeTools: surface.nativeNames(),
      tombstones: surface.tombstoneNames(),
      routedTools: [...routedNames].sort(),
      available: availableCapabilities(catalog, context)
        .filter(appOnly)
        .map((c) => c.name),
      pending: approvals.pending(),
      lastRouting,
      schemaBytes: surface.schemaBytes(),
      audit: audit.list(),
    };
  }

  function emit(): void {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (err) {
        // An observer must never change an operation's outcome.
        console.error("agentdesk snapshot listener threw", err);
      }
    }
  }

  function desiredNative(): Capability[] {
    const available = availableCapabilities(catalog, context);
    if (exposure === "flat") {
      return available;
    }
    return available.filter(
      (capability) =>
        BUILTIN_NAMES.has(capability.name) ||
        capability.surface === "native" ||
        routedNames.has(capability.name),
    );
  }

  async function reconcile(): Promise<void> {
    await surface.reconcile(desiredNative());
    emit();
  }

  async function runCapability(
    capability: Capability,
    input: Record<string, unknown>,
    via: "native" | "invoke",
  ): Promise<ToolResult> {
    if (capability.name === FIND_CAPABILITIES) {
      const raw = readString(input, "query") ?? readString(input, "task") ?? "";
      // Bound what enters routing, lastRouting, and the audit log.
      return toToolResult(await findCapabilities(raw.slice(0, 400)));
    }
    if (capability.name === INVOKE_CAPABILITY) {
      return dispatchInvoke(input);
    }
    if (capability.name === GET_CONTEXT) {
      return toToolResult(contextPayload());
    }
    if (capability.name === GET_ACTION_STATUS) {
      return actionStatus(input);
    }

    audit.append({
      kind: "capability_invoked",
      capability: capability.name,
      risk: capability.risk,
      via,
      at: now(),
    });
    const availability = capability.availability(context);
    if (!availability.available) {
      audit.append({
        kind: "capability_unavailable",
        capability: capability.name,
        reasonCode: availability.reasonCode,
        at: now(),
      });
      emit();
      return capabilityUnavailable(capability.name, availability);
    }
    const inputCheck = capability.checkInput?.(input, context);
    if (inputCheck && !inputCheck.available) {
      audit.append({
        kind: "capability_unavailable",
        capability: capability.name,
        reasonCode: inputCheck.reasonCode,
        at: now(),
      });
      emit();
      return capabilityUnavailable(capability.name, inputCheck);
    }
    if (decidePolicy(capability) === "approval_required") {
      const summary =
        capability.describeApproval?.(input, context) ??
        capability.title ??
        capability.name;
      const action = approvals.request(
        capability.name,
        input,
        capability.risk,
        summary,
        now(),
      );
      audit.append({
        kind: "approval_requested",
        capability: capability.name,
        actionId: action.id,
        risk: capability.risk,
        summary,
        at: now(),
      });
      emit();
      return approvalRequired(
        capability.name,
        action.id,
        capability.risk,
        summary,
      );
    }
    const outcome = await executeNow(capability, input);
    return outcome.result;
  }

  async function dispatchInvoke(
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name =
      readString(input, "name") ?? readString(input, "capability");
    if (name === undefined) {
      return errorResult("name is required");
    }
    if (name === FIND_CAPABILITIES || name === INVOKE_CAPABILITY) {
      return errorResult(
        "cannot invoke a surface tool through invoke_capability",
      );
    }
    const routed = routeCapability(catalog, name);
    if (isRouteError(routed)) {
      return errorResult(`unknown capability: ${name}`);
    }
    try {
      return await runCapability(routed, readRecord(input.input), "invoke");
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  type ExecutionOutcome =
    | { ok: true; value: unknown; result: ToolResult }
    | { ok: false; result: ToolResult };

  async function executeNow(
    capability: Capability,
    input: Record<string, unknown>,
  ): Promise<ExecutionOutcome> {
    audit.append({
      kind: "execution_started",
      capability: capability.name,
      at: now(),
    });
    try {
      const value = await capability.execute(input, context);
      audit.append({
        kind: "execution_completed",
        capability: capability.name,
        at: now(),
      });
      emit();
      return { ok: true, value, result: toToolResult(value) };
    } catch (err) {
      if (err instanceof CapabilityUnavailableError) {
        audit.append({
          kind: "capability_unavailable",
          capability: capability.name,
          reasonCode: err.unavailability.reasonCode,
          at: now(),
        });
        emit();
        return {
          ok: false,
          result: capabilityUnavailable(capability.name, err.unavailability),
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      audit.append({
        kind: "execution_failed",
        capability: capability.name,
        error: message,
        at: now(),
      });
      emit();
      return { ok: false, result: errorResult(message) };
    }
  }

  async function findCapabilities(
    query: string,
  ): Promise<Record<string, unknown>> {
    const appCaps = catalog.all().filter(appOnly);
    let ranked = rankCapabilities(appCaps, context, query);
    let fallback = false;
    if (ranked.length === 0) {
      fallback = true;
      ranked = appCaps
        .filter((capability) => capability.availability(context).available)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 5)
        .map((capability) => ({ capability, score: 0 }));
    }
    const matches: RoutedMatch[] = ranked.map(({ capability, score }) => {
      const availability = capability.availability(context);
      const match: RoutedMatch = {
        name: capability.name,
        description: capability.description,
        risk: capability.risk,
        score,
        available: availability.available,
        requiresApproval: decidePolicy(capability) === "approval_required",
      };
      if (capability.title !== undefined) {
        match.title = capability.title;
      }
      if (!availability.available) {
        match.reasonCode = availability.reasonCode;
        match.reason = availability.reason;
        if (availability.suggestedCapability !== undefined) {
          match.suggestedCapability = availability.suggestedCapability;
        }
      }
      return match;
    });

    if (exposure === "routed" && !fallback) {
      routedNames = new Set(
        matches.filter((match) => match.available).map((match) => match.name),
      );
    }
    await surface.clearTombstones();
    await surface.reconcile(desiredNative());

    const activated = surface
      .nativeNames()
      .filter((name) => !BUILTIN_NAMES.has(name));
    lastRouting = { query, matches, activated, at: now() };
    audit.append({
      kind: "capability_routed",
      query,
      matched: matches.map((match) => match.name),
      activated,
      catalogSize: appCaps.length,
      at: now(),
    });
    emit();

    return {
      catalog_size: appCaps.length,
      query,
      matches: matches.map((match) => {
        const out: Record<string, unknown> = {
          name: match.name,
          description: match.description,
          risk: match.risk,
          available: match.available,
          requires_approval: match.requiresApproval,
        };
        if (match.title !== undefined) {
          out.title = match.title;
        }
        if (match.reasonCode !== undefined) {
          out.reasonCode = match.reasonCode;
          out.reason = match.reason;
        }
        if (match.suggestedCapability !== undefined) {
          out.suggestedCapability = match.suggestedCapability;
        }
        return out;
      }),
      activated_tools: activated,
      limit: 5,
      instruction:
        "Up to 5 of the most relevant capabilities are active WebMCP tools; refine the query to surface others. Prefer the native typed tools. If your client has not refreshed its tool list, call invoke_capability with the capability name.",
    };
  }

  function contextPayload(): Record<string, unknown> {
    return {
      route: context.route,
      exposure,
      catalog_size: appCapabilities.length,
      active_tools: surface.nativeNames(),
      routed_tools: [...routedNames].sort(),
      pending_approvals: approvals.pending().map((action) => ({
        approval_id: action.id,
        capability: action.capability,
        risk: action.risk,
        summary: action.summary,
      })),
      state: options.describeContext
        ? options.describeContext(context)
        : context.state,
    };
  }

  function actionStatus(input: Record<string, unknown>): ToolResult {
    const id =
      readString(input, "approval_id") ??
      readString(input, "actionId") ??
      readString(input, "id");
    if (id === undefined) {
      return errorResult("approval_id is required");
    }
    const record = approvals.get(id);
    if (!record) {
      return errorResult(`unknown approval id: ${id}`);
    }
    const base: Record<string, unknown> = {
      approval_id: id,
      capability: record.action.capability,
      status: record.status,
    };
    if (record.status === "APPROVED_EXECUTED") {
      base.result = record.result;
    }
    if (record.status === "FAILED") {
      base.error = record.error;
    }
    if (record.status === "FAILED_UNAVAILABLE") {
      base.reasonCode = record.reasonCode;
      base.reason = record.reason;
    }
    return toToolResult(base);
  }

  function pruneRouted(): void {
    const next = new Set<string>();
    for (const name of routedNames) {
      const capability = catalog.get(name);
      if (capability && capability.availability(context).available) {
        next.add(name);
      }
    }
    routedNames = next;
  }

  return {
    async start() {
      if (started) {
        return;
      }
      await surface.reconcile(desiredNative());
      started = true;
      emit();
    },
    async stop() {
      started = false;
      approvals.clear();
      await surface.clear();
      emit();
    },
    async setContext(next) {
      context = next;
      pruneRouted();
      audit.append({
        kind: "context_changed",
        route: context.route,
        exposure,
        at: now(),
      });
      if (started) {
        await reconcile();
      } else {
        emit();
      }
    },
    async setExposure(next) {
      if (next === exposure) {
        return;
      }
      exposure = next;
      audit.append({
        kind: "context_changed",
        route: context.route,
        exposure,
        at: now(),
      });
      if (started) {
        await surface.reconcile(desiredNative());
        // A mode switch is an explicit operator action, not context drift;
        // keeping 78 tombstones would defeat the small-surface premise.
        await surface.clearTombstones();
        emit();
      } else {
        emit();
      }
    },
    async routeTask(query) {
      return findCapabilities(query);
    },
    async reset() {
      approvals.clear();
      routedNames = new Set();
      lastRouting = null;
      if (started) {
        await surface.reconcile(desiredNative());
      }
      await surface.clearTombstones();
      audit.clear();
      emit();
    },
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(snapshot());
      } catch (err) {
        console.error("agentdesk snapshot listener threw", err);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async invoke(name, input = {}) {
      if (!started) {
        return errorResult("runtime is not started");
      }
      if (name === INVOKE_CAPABILITY) {
        return dispatchInvoke(input);
      }
      const routed = routeCapability(catalog, name);
      if (isRouteError(routed)) {
        return errorResult(`unknown capability: ${name}`);
      }
      return runCapability(routed, input, "invoke");
    },
    async approve(actionId) {
      const action = approvals.claim(actionId);
      if (!action) {
        const record = approvals.get(actionId);
        if (!record) {
          return errorResult(`unknown pending action: ${actionId}`);
        }
        return toToolResult({
          status: record.status,
          approval_id: actionId,
          capability: record.action.capability,
          note: "This approval was already claimed or resolved; the action did not run again.",
        });
      }
      const routed = routeCapability(catalog, action.capability);
      if (isRouteError(routed)) {
        approvals.resolve(actionId, {
          status: "FAILED",
          action,
          error: `unknown capability: ${action.capability}`,
          resolvedAt: now(),
        });
        return errorResult(`unknown capability: ${action.capability}`);
      }
      const availability = routed.availability(context);
      const inputCheck = availability.available
        ? routed.checkInput?.(action.input, context)
        : undefined;
      const blocker = !availability.available
        ? availability
        : inputCheck && !inputCheck.available
          ? inputCheck
          : null;
      if (blocker) {
        approvals.resolve(actionId, {
          status: "FAILED_UNAVAILABLE",
          action,
          reasonCode: blocker.reasonCode,
          reason: blocker.reason,
          resolvedAt: now(),
        });
        audit.append({
          kind: "capability_unavailable",
          capability: action.capability,
          reasonCode: blocker.reasonCode,
          at: now(),
        });
        emit();
        return capabilityUnavailable(action.capability, blocker);
      }
      audit.append({
        kind: "approval_approved",
        actionId,
        capability: action.capability,
        at: now(),
      });
      const outcome = await executeNow(routed, action.input);
      if (outcome.ok) {
        approvals.resolve(actionId, {
          status: "APPROVED_EXECUTED",
          action,
          result: outcome.value,
          resolvedAt: now(),
        });
      } else {
        approvals.resolve(actionId, {
          status: "FAILED",
          action,
          error: firstText(outcome.result),
          resolvedAt: now(),
        });
      }
      emit();
      return outcome.result;
    },
    reject(actionId) {
      const action = approvals.pendingAction(actionId);
      if (!action) {
        return errorResult(`unknown pending action: ${actionId}`);
      }
      approvals.resolve(actionId, {
        status: "REJECTED",
        action,
        resolvedAt: now(),
      });
      audit.append({
        kind: "approval_rejected",
        actionId,
        capability: action.capability,
        at: now(),
      });
      emit();
      return toToolResult({
        status: "REJECTED",
        approval_id: actionId,
        capability: action.capability,
      });
    },
  };
}

function builtinCapabilities(): Capability[] {
  const unreachable = (name: string) => () => {
    throw new Error(`${name} is handled by the runtime dispatcher`);
  };
  return [
    defineCapability({
      name: FIND_CAPABILITIES,
      title: "Find capabilities",
      description:
        "Describe the task you want to perform. Returns the most relevant application capabilities for the current context, activates them as native WebMCP tools, and explains any that are unavailable. Call this before calling a domain capability.",
      surface: "native",
      readOnlyHint: true,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The task or intent in plain words, e.g. 'refund shipping for an unshipped order'",
          },
        },
      },
      execute: unreachable(FIND_CAPABILITIES),
    }),
    defineCapability({
      name: INVOKE_CAPABILITY,
      title: "Invoke capability",
      description:
        "Invoke a named application capability. Use find_capabilities first. Works even if your tool list is stale. Can execute write capabilities; consequential capabilities return APPROVAL_REQUIRED instead of mutating state.",
      surface: "native",
      readOnlyHint: false,
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Capability name returned by find_capabilities",
          },
          input: {
            type: "object",
            description: "Arguments for the capability",
          },
        },
      },
      execute: unreachable(INVOKE_CAPABILITY),
    }),
    defineCapability({
      name: GET_CONTEXT,
      title: "Get context",
      description:
        "Current application context: route, focused entities, active WebMCP tools, catalog size, and pending human approvals.",
      surface: "native",
      readOnlyHint: true,
      inputSchema: { type: "object", properties: {} },
      execute: unreachable(GET_CONTEXT),
    }),
    defineCapability({
      name: GET_ACTION_STATUS,
      title: "Get action status",
      description:
        "Check the status of a pending human approval by approval_id. Returns PENDING, APPROVED_EXECUTED with the result, REJECTED, or a failure reason.",
      surface: "native",
      readOnlyHint: true,
      inputSchema: {
        type: "object",
        required: ["approval_id"],
        properties: {
          approval_id: {
            type: "string",
            description: "The approval_id returned with APPROVAL_REQUIRED",
          },
        },
      },
      execute: unreachable(GET_ACTION_STATUS),
    }),
  ];
}

function firstText(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

function readString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("input must be an object");
  }
  const record: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    record[key] = nested;
  }
  return record;
}
