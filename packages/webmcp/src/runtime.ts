import { ApprovalManager, type PendingAction } from "./approval.ts";
import { AuditBus, deepFreeze, now, type AuditEvent } from "./audit.ts";
import {
  availableCapabilities,
  evaluateAvailability,
} from "./availability.ts";
import {
  CapabilityUnavailableError,
  defineCapability,
  unavailable,
  type AppContext,
  type Capability,
  type CapabilityName,
  type Change,
  type ExecutionContext,
  type RiskLevel,
  type Unavailability,
} from "./capability.ts";
import { CapabilityCatalog } from "./catalog.ts";
import { decidePolicy, riskBasedPolicy, type PolicyEngine } from "./policy.ts";
import { defaultValidator, type Validator } from "./validation.ts";
import {
  PresentationBus,
  resolvePresentation,
  type PresentationListener,
  type PresentationPhase,
} from "./presentation.ts";
import {
  PlanStore,
  highestRisk,
  isHumanActor,
  parseActor,
  type Actor,
  type HumanActor,
  type OperationOutcome,
  type OperationPlan,
  type PlannedOperation,
  type VerificationResult,
} from "./plan.ts";
import { ReceiptStore, type ReceiptQuery, type StoredReceipt } from "./receipts.ts";
import { isRouteError, rankCapabilities, routeCapability } from "./router.ts";
import {
  approvalRequired,
  capabilityUnavailable,
  errorResult,
  executionCancelled,
  idempotencyCapacity,
  idempotencyConflict,
  isReceiptEnvelope,
  policyDenied,
  previewUnavailable,
  toToolResult,
  validationFailed,
  type ToolResult,
} from "./results.ts";
import { ToolSurfaceManager } from "./tool-surface.ts";
import {
  assertSafeOrigins,
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
  /** Live size of the bounded idempotency store. */
  idempotencyEntries: number;
  actor?: Actor;
  plans: OperationPlan[];
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
  /**
   * Transient UI choreography (navigate, reveal, narrate). Optional: the
   * WebMCP result is authoritative whether or not anyone subscribes.
   */
  subscribePresentation: (listener: PresentationListener) => () => void;
  /**
   * Streams audit events as they happen, for export to an external
   * observability backend. A throwing listener cannot affect execution.
   */
  subscribeAudit: (listener: (event: AuditEvent) => void) => () => void;
  invoke: (name: string, input?: Record<string, unknown>) => Promise<ToolResult>;
  /**
   * `by` must be a human. A consequential action's approval record exists to
   * say which person authorized it, and the ambient actor is the agent.
   */
  approve: (actionId: string, by?: Actor) => Promise<ToolResult>;
  reject: (actionId: string, by?: Actor) => ToolResult;

  /** Records who is acting on subsequent operations. */
  setActor: (actor: Actor | undefined) => void;

  /**
   * Builds a reviewable, versioned plan. Nothing executes until
   * `approvePlan` then `commitPlan`, and commit refuses if the application
   * revision moved since the plan was prepared.
   */
  prepare: (request: {
    operations: Array<{ capability: string; input?: Record<string, unknown> }>;
    summary?: string;
  }) => Promise<OperationPlan>;
  /** Refuses unless the resolved approver is a human. */
  approvePlan: (
    planId: string,
    by?: Actor,
  ) => { ok: true; plan: OperationPlan } | { ok: false; reason: string };
  rejectPlan: (
    planId: string,
  ) => { ok: true; plan: OperationPlan } | { ok: false; reason: string };
  commitPlan: (
    planId: string,
  ) => Promise<
    | { ok: true; plan: OperationPlan }
    | { ok: false; reason: string; plan?: OperationPlan }
  >;
  getPlan: (planId: string) => OperationPlan | undefined;
  listPlans: () => OperationPlan[];

  /** Queryable history of what actually changed, with verification. */
  queryReceipts: (filter?: ReceiptQuery) => StoredReceipt[];
  /** Records that a human looked at a receipt. */
  markReviewed: (
    receiptId: string,
    by?: Actor,
  ) => { ok: true } | { ok: false; reason: string };
  /**
   * Optional. Reports unsupported rather than pretending every app undoes.
   *
   * The receipt is claimed synchronously, so concurrent calls run the
   * compensating action once. A capability that declares `verify` is
   * re-verified first, and anything other than VERIFIED refuses as a
   * conflict rather than overwriting a later change.
   *
   * A capability with no verifier gets no such protection. The runtime
   * cannot detect drift it has no way to read, so the rollback proceeds
   * and may overwrite state that moved after the receipt.
   */
  rollback: (
    receiptId: string,
  ) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;
};

export function createAgentDeskRuntime(options: {
  capabilities?: readonly Capability[];
  registerTool?: RegisterToolFn | null;
  adapter?: WebMcpAdapter;
  exposure?: Exposure;
  describeContext?: (ctx: AppContext) => Record<string, unknown>;
  /** Replace the risk-based default with your own decisions. */
  policy?: PolicyEngine;
  /** Replace the built-in schema checker with Ajv, Zod, or similar. */
  validate?: Validator;
  /** Origins allowed to see registered tools (spec: `exposedTo`). */
  exposedTo?: string[];
  /**
   * Current application revision. Captured when a plan is prepared and
   * compared again at commit, so a human cannot approve a plan built
   * against state that has since moved.
   */
  revision?: (ctx: AppContext) => string;
  /** Who is acting. Recorded on audit events, receipts, and presentation. */
  actor?: Actor;
}): AgentDeskRuntime {
  const audit = new AuditBus();
  const approvals = new ApprovalManager();
  const presentation = new PresentationBus();
  const plans = new PlanStore();
  const receipts = new ReceiptStore();
  // Detached and frozen on the way in, so a caller mutating the object it
  // handed over cannot retroactively rewrite provenance already recorded,
  // and so a getter-backed property is read exactly once. The clone failure
  // is returned rather than thrown because the paths that record a
  // caller-supplied identity have to refuse before they change any state.
  const ownActor = (
    next: Actor,
  ): { ok: true; actor: Actor } | { ok: false; reason: string } => {
    try {
      return { ok: true, actor: deepFreeze(structuredClone(next)) };
    } catch {
      return {
        ok: false,
        reason:
          "the supplied identity could not be recorded because it carries a value that cannot be cloned, such as a function",
      };
    }
  };

  /**
   * Throws rather than refusing, because an ambient identity is set by the
   * application at configuration time. There is no caller to hand a reason
   * to, and a runtime that kept running would attribute every later write
   * to an identity nobody can resolve.
   */
  function adoptActor(next: Actor | undefined): Actor | undefined {
    if (next === undefined) {
      return undefined;
    }
    const owned = ownActor(next);
    if (!owned.ok) {
      throw new TypeError(owned.reason);
    }
    const parsed = parseActor(owned.actor);
    if (!parsed.ok) {
      throw new TypeError(parsed.reason);
    }
    return parsed.actor;
  }

  /**
   * The single read of a caller-supplied identity on the two paths that
   * record a human decision. Snapshotting before the `kind` check is what
   * makes the check meaningful. A getter that answers `"human"` once and
   * `"agent"` afterwards is caught here rather than approved on one read
   * and recorded on another.
   *
   * Parsing sits between the snapshot and the `kind` check. The parameter
   * says `Actor`, but a JavaScript caller can hand over anything, and an
   * approval recorded against an identity carrying no `id` names nobody.
   */
  function resolveHumanActor(
    supplied: Actor | undefined,
    refusal: string,
  ): { ok: true; actor: HumanActor } | { ok: false; reason: string } {
    if (supplied === undefined) {
      return { ok: false, reason: refusal };
    }
    const owned = ownActor(supplied);
    if (!owned.ok) {
      return owned;
    }
    const parsed = parseActor(owned.actor);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `the supplied identity is malformed: ${parsed.reason}`,
      };
    }
    if (!isHumanActor(parsed.actor)) {
      return { ok: false, reason: refusal };
    }
    return { ok: true, actor: deepFreeze(parsed.actor) };
  }

  let actor: Actor | undefined = adoptActor(options.actor);
  const adapter =
    options.adapter ??
    createWebMcpAdapter(
      options.registerTool !== undefined
        ? { registerTool: options.registerTool }
        : undefined,
    );

  if (options.exposedTo) {
    assertSafeOrigins(options.exposedTo);
  }
  const policy = options.policy ?? riskBasedPolicy;
  const validate = options.validate ?? defaultValidator;
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

  /**
   * Incremented by stop() and reset(). An execution that resolves after
   * its epoch ended cannot write to audit or approval state, so a slow
   * handler can never repopulate a runtime the operator just cleared.
   */
  let epoch = 0;
  let epochController = new AbortController();
  let executionCounter = 0;

  /**
   * Keyed by capability and key so the same key in two capabilities is two
   * operations. Holds the in-flight promise, not just the settled result,
   * so concurrent retries join the first execution instead of starting a
   * second one. Bounded and evicted oldest-first; this is process memory,
   * not durable storage.
   */
  type IdempotencyEntry = {
    fingerprint: string;
    inFlight: Promise<ToolResult>;
    settled: boolean;
  };
  const IDEMPOTENCY_LIMIT = 512;
  const idempotency = new Map<string, IdempotencyEntry>();

  /**
   * Makes room for one more key by evicting settled entries oldest-first.
   * In-flight entries are never evicted, since dropping one would let a
   * retry start the duplicate execution this store exists to prevent.
   * Returns false when the bound cannot be honoured, so the caller can
   * refuse rather than let the store grow without limit.
   */
  function reserveIdempotencySlot(): boolean {
    for (const [candidate, held] of idempotency) {
      if (idempotency.size < IDEMPOTENCY_LIMIT) {
        break;
      }
      if (held.settled) {
        idempotency.delete(candidate);
      }
    }
    return idempotency.size < IDEMPOTENCY_LIMIT;
  }

  /** Stable across property insertion order, so `{a,b}` matches `{b,a}`. */
  function fingerprintInput(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(fingerprintInput).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${fingerprintInput(v)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }

  function endEpoch(): void {
    epoch += 1;
    epochController.abort();
    epochController = new AbortController();
  }

  /**
   * An operation's right to write into the current session. stop() and
   * reset() end the epoch, so work still in flight loses that right rather
   * than repopulating a runtime the operator just cleared. Every async path
   * that mutates runtime state claims one and rechecks it after each await,
   * including after application callbacks like verify and previewChanges.
   */
  function claimSession(): { expired: () => boolean } {
    const claimed = epoch;
    return { expired: () => claimed !== epoch };
  }

  /**
   * A plan whose session ended mid-commit. Leaving it COMMITTING made it
   * unretryable after a restart, because the transition out of that state
   * only ever happened on the path the interruption cut short. If reset
   * removed the plan there is nothing to settle, and writing it back would
   * resurrect it in a session the operator cleared.
   */
  function settleInterrupted(
    planId: string,
    claimed: OperationPlan,
    outcomes: OperationOutcome[],
  ): { ok: false; reason: string; plan: OperationPlan } {
    if (plans.get(planId) !== undefined) {
      plans.resolve(planId, {
        status: "INTERRUPTED",
        outcomes,
        resolvedAt: now(),
      });
    }
    return {
      ok: false,
      reason: `plan ${planId} was interrupted by a reset or stop and did not finish`,
      plan: plans.get(planId) ?? claimed,
    };
  }

  const surface = new ToolSurfaceManager(
    adapter,
    audit,
    (capability, input, signal) =>
      runCapability(capability, input, "native", signal),
    () => emit(),
    options.exposedTo,
  );

  function appOnly(capability: Capability): boolean {
    return !BUILTIN_NAMES.has(capability.name);
  }

  function present(
    capability: Capability,
    phase: PresentationPhase,
    input: Record<string, unknown>,
    actingActor: Actor | undefined,
    execution?: { executionId: string; humanInitiated: boolean },
  ): void {
    const event = resolvePresentation(
      capability,
      phase,
      input,
      context,
      now(),
      actingActor,
    );
    if (execution) {
      event.executionId = execution.executionId;
      event.humanInitiated = execution.humanInitiated;
    }
    presentation.emit(event);
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
      idempotencyEntries: idempotency.size,
      plans: plans.list(),
      ...(actor !== undefined ? { actor } : {}),
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
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<ToolResult> {
    // Resolved at the invocation boundary, before anything can observe the
    // invocation. Presentation listeners dispatch synchronously, so a
    // listener reacting to `capability_started` can call `setActor` and
    // would otherwise split one invocation across two actors.
    const invocationActor = actor;

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
    const availability = evaluateAvailability(capability, context);
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
    const validation = validate(capability.inputSchema, input);
    if (!validation.valid) {
      audit.append({
        kind: "capability_unavailable",
        capability: capability.name,
        reasonCode: "VALIDATION_FAILED",
        at: now(),
      });
      emit();
      return validationFailed(capability.name, validation.issues);
    }

    const decision = policy({ capability, input, context });
    if (decision.kind === "deny") {
      audit.append({
        kind: "policy_denied",
        capability: capability.name,
        reason: decision.reason,
        at: now(),
      });
      emit();
      return policyDenied(capability.name, decision.reason);
    }

    present(capability, "capability_started", input, invocationActor);
    if (decision.kind === "require_approval") {
      const summary =
        capability.describeApproval?.(input, context) ??
        capability.title ??
        capability.name;
      const preview = safePreview(capability, input, context);
      if (!preview.ok && capability.risk === "CONSEQUENTIAL") {
        audit.append({
          kind: "capability_unavailable",
          capability: capability.name,
          reasonCode: "PREVIEW_UNAVAILABLE",
          at: now(),
        });
        emit();
        return previewUnavailable(capability.name, preview.error);
      }
      const action = approvals.request(
        capability.name,
        input,
        capability.risk,
        summary,
        preview.changes,
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
      present(capability, "approval_requested", input, invocationActor);
      emit();
      return approvalRequired(
        capability.name,
        action.id,
        capability.risk,
        summary,
        action.preview,
        capability.approvalEvidence,
      );
    }
    const outcome = await executeNow(capability, input, {
      actor: invocationActor,
      signal,
      idempotencyKey,
    });
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
      return await runCapability(
        routed,
        readRecord(input.input),
        "invoke",
        undefined,
        readString(input, "idempotency_key"),
      );
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * `executionId` is absent only where no execution was attempted, which
   * is the idempotency short-circuits in `executeNow`.
   */
  type ExecutionOutcome =
    | {
        ok: true;
        executionId?: string;
        value: unknown;
        result: ToolResult;
        verification?: VerificationResult;
      }
    | { ok: false; executionId?: string; result: ToolResult };

  type ExecutionOptions = {
    /**
     * The acting identity, resolved by the caller at the boundary that
     * begins the invocation. Required rather than optional so every entry
     * point is forced to resolve it once, at its earliest point, instead of
     * reading the mutable binding after a listener or a suspended handler
     * could have moved it.
     */
    actor: Actor | undefined;
    signal?: AbortSignal | undefined;
    idempotencyKey?: string | undefined;
    planId?: string | undefined;
    /**
     * Only `approve` sets this. A UI may hand keyboard focus to an
     * execution a human authorized and to no other, so an agent working in
     * the background must never be able to reach focus.
     */
    humanInitiated?: boolean | undefined;
  };

  /**
   * A broken verifier must not turn a completed write into a failure, so a
   * throw is reported as an unverifiable outcome rather than propagated.
   */
  async function runVerification(
    capability: Capability,
    input: Record<string, unknown>,
    changes: readonly Change[],
  ): Promise<VerificationResult> {
    if (!capability.verify) {
      return { status: "UNSUPPORTED" };
    }
    try {
      return await capability.verify(input, context, changes);
    } catch (err) {
      return {
        status: "PARTIAL",
        unverified: changes.map((change) => change.field),
        note: `verifier failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function executeNow(
    capability: Capability,
    input: Record<string, unknown>,
    opts: ExecutionOptions,
  ): Promise<ExecutionOutcome> {
    const { idempotencyKey } = opts;
    if (idempotencyKey !== undefined) {
      const slot = `${capability.name}:${idempotencyKey}`;
      const fingerprint = fingerprintInput(input);
      const previous = idempotency.get(slot);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return {
            ok: false,
            result: idempotencyConflict(capability.name, idempotencyKey),
          };
        }
        return { ok: true, value: undefined, result: await previous.inFlight };
      }
      if (!reserveIdempotencySlot()) {
        return {
          ok: false,
          result: idempotencyCapacity(capability.name, IDEMPOTENCY_LIMIT),
        };
      }
      let settle: (result: ToolResult) => void = () => {};
      const entry: IdempotencyEntry = {
        fingerprint,
        inFlight: new Promise<ToolResult>((resolve) => {
          settle = resolve;
        }),
        settled: false,
      };
      idempotency.set(slot, entry);
      const outcome = await runExecution(capability, input, opts);
      entry.settled = true;
      settle(outcome.result);
      return outcome;
    }
    return runExecution(capability, input, opts);
  }

  async function runExecution(
    capability: Capability,
    caller: Record<string, unknown>,
    opts: ExecutionOptions,
  ): Promise<ExecutionOutcome> {
    const {
      signal,
      idempotencyKey,
      planId,
      humanInitiated = false,
      actor: actingActor,
    } = opts;
    const executionId = `EXE-${++executionCounter}`;
    const session = claimSession();
    // The execution owns its input from here. Cloning only to prove the input
    // was recordable and then continuing with the caller's object left the
    // handler, the verifier, and the receipt each reading it again, so a
    // value that changed between reads was executed under one shape and
    // recorded under another, or refused after the write had landed.
    let input: Record<string, unknown>;
    try {
      input = structuredClone(caller);
    } catch (err) {
      return {
        ok: false,
        executionId,
        result: errorResult(
          `${capability.name} was called with input the runtime cannot record: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      };
    }
    const linked = linkSignals(signal, epochController.signal);
    const execContext: ExecutionContext = {
      route: context.route,
      state: context.state,
      signal: linked.signal,
      executionId,
    };
    if (idempotencyKey !== undefined) {
      execContext.idempotencyKey = idempotencyKey;
    }

    audit.append({
      kind: "execution_started",
      capability: capability.name,
      executionId,
      ...(actingActor !== undefined ? { actor: actingActor } : {}),
      at: now(),
    });
    try {
      const value = await capability.execute(input, execContext);
      if (session.expired()) {
        return {
          ok: false,
          executionId,
          result: executionCancelled(capability.name),
        };
      }
      const event: Extract<AuditEvent, { kind: "execution_completed" }> = {
        kind: "execution_completed",
        capability: capability.name,
        executionId,
        ...(actingActor !== undefined ? { actor: actingActor } : {}),
        at: now(),
      };
      let verification: VerificationResult = { status: "UNSUPPORTED" };
      if (isReceiptEnvelope(value)) {
        event.receipt = value.receipt;
        verification = await runVerification(
          capability,
          input,
          value.receipt.changes,
        );
      }
      // Verification is an application callback and can outlive the session
      // it started in, so the claim is rechecked here as well as after the
      // handler. Nothing has been written yet at this point.
      if (session.expired()) {
        return {
          ok: false,
          executionId,
          result: executionCancelled(capability.name),
        };
      }
      // Everything that can fail is built before anything is committed. A
      // receipt the store cannot hold and a result that will not serialize
      // are both failures of this execution, not of the bookkeeping after
      // it, so they belong on the failure path while it is still reachable.
      let toolResult: ToolResult;
      let pending: Parameters<typeof receipts.record>[0] | undefined;
      try {
        toolResult = toToolResult(value);
        if (isReceiptEnvelope(value)) {
          pending = structuredClone({
            capability: capability.name,
            executionId,
            input,
            receipt: value.receipt,
            verification,
            at: now(),
            ...(planId !== undefined ? { planId } : {}),
            ...(actingActor !== undefined ? { executedBy: actingActor } : {}),
          });
        }
      } catch (err) {
        throw new Error(
          `${capability.name} produced a result the runtime cannot record: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // One terminal outcome, committed together. Presentation runs after the
      // governance evidence is durable and cannot change it.
      audit.append(event);
      if (pending) {
        receipts.record(pending);
      }
      try {
        present(capability, "capability_completed", input, actingActor, {
          executionId,
          humanInitiated,
        });
      } catch (err) {
        console.error(
          `agentdesk presentation after ${executionId} completed threw`,
          err,
        );
      }
      emit();
      return {
        ok: true,
        executionId,
        value,
        result: toolResult,
        verification,
      };
    } catch (err) {
      if (session.expired()) {
        return {
          ok: false,
          executionId,
          result: executionCancelled(capability.name),
        };
      }
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
          executionId,
          result: capabilityUnavailable(capability.name, err.unavailability),
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      audit.append({
        kind: "execution_failed",
        capability: capability.name,
        executionId,
        error: message,
        ...(actingActor !== undefined ? { actor: actingActor } : {}),
        at: now(),
      });
      present(capability, "capability_failed", input, actingActor, {
        executionId,
        humanInitiated,
      });
      emit();
      return { ok: false, executionId, result: errorResult(message) };
    } finally {
      linked.dispose();
    }
  }

  /**
   * Runs one approved operation through the same gates a single approval
   * uses, minus the approval itself, which the plan already carries. The
   * executor is handed down from the commit rather than resolved here, so
   * every operation in one commit names the same one.
   */
  async function commitOperation(
    planId: string,
    operation: PlannedOperation,
    executor: Actor | undefined,
  ): Promise<OperationOutcome> {
    const routed = routeCapability(catalog, operation.capability);
    if (isRouteError(routed)) {
      return {
        capability: operation.capability,
        status: "FAILED",
        detail: `unknown capability: ${operation.capability}`,
        verification: { status: "UNSUPPORTED" },
      };
    }

    const blocked = (detail: string): OperationOutcome => ({
      capability: operation.capability,
      status: "SKIPPED",
      detail,
      verification: { status: "UNSUPPORTED" },
    });

    try {
      const decision = policy({
        capability: routed,
        input: operation.input,
        context,
      });
      if (decision.kind === "deny") {
        return blocked(decision.reason);
      }
      const availability = evaluateAvailability(routed, context);
      if (!availability.available) {
        return blocked(`${availability.reasonCode}: ${availability.reason}`);
      }
      const inputCheck = routed.checkInput?.(operation.input, context);
      if (inputCheck && !inputCheck.available) {
        return blocked(`${inputCheck.reasonCode}: ${inputCheck.reason}`);
      }
      const validation = validate(routed.inputSchema, operation.input);
      if (!validation.valid) {
        return blocked(
          validation.issues.map((issue) => issue.message).join("; "),
        );
      }

      const outcome = await executeNow(routed, operation.input, {
        planId,
        actor: executor,
      });
      const correlation =
        outcome.executionId !== undefined
          ? { executionId: outcome.executionId }
          : {};
      if (!outcome.ok) {
        return {
          capability: operation.capability,
          ...correlation,
          status: "FAILED",
          detail: firstText(outcome.result),
          verification: { status: "UNSUPPORTED" },
        };
      }
      return {
        capability: operation.capability,
        ...correlation,
        status: "COMPLETED",
        verification: outcome.verification ?? { status: "UNSUPPORTED" },
      };
    } catch (err) {
      return {
        capability: operation.capability,
        status: "FAILED",
        detail: err instanceof Error ? err.message : String(err),
        verification: { status: "UNSUPPORTED" },
      };
    }
  }

  function describePlan(operations: readonly PlannedOperation[]): string {
    return operations.length === 1
      ? `Run ${operations[0]!.capability}`
      : `Run ${operations.length} operations: ${operations
          .map((operation) => operation.capability)
          .join(", ")}`;
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
        .filter((capability) => evaluateAvailability(capability, context).available)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 5)
        .map((capability) => ({ capability, score: 0 }));
    }
    const matches: RoutedMatch[] = ranked.map(({ capability, score }) => {
      const availability = evaluateAvailability(capability, context);
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
    presentation.emit({
      phase: "intent_routed",
      capability: FIND_CAPABILITIES,
      message: query
        ? `Routing "${query}" against ${appCaps.length} capabilities`
        : `Routing against ${appCaps.length} capabilities`,
      at: now(),
    });
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
      if (capability && evaluateAvailability(capability, context).available) {
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
      endEpoch();
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
      endEpoch();
      approvals.clear();
      idempotency.clear();
      plans.clear();
      receipts.clear();
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
    subscribePresentation(listener) {
      return presentation.subscribe(listener);
    },
    subscribeAudit(listener) {
      return audit.subscribe(listener);
    },

    setActor(next) {
      actor = adoptActor(next);
      emit();
    },

    async prepare(request) {
      // previewChanges and revision are application callbacks and can end the
      // session before the plan is created. Without a claim the plan landed
      // in the cleared runtime and reset's audit clear then removed its
      // plan_prepared event, leaving a plan with no record of its own origin.
      const session = claimSession();
      // `previewChanges` is application code called synchronously below, so
      // the requester is resolved before it runs rather than after.
      const requester = actor;
      const operations: PlannedOperation[] = [];
      for (const requested of request.operations) {
        const routed = routeCapability(catalog, requested.capability);
        if (isRouteError(routed)) {
          throw new Error(`unknown capability: ${requested.capability}`);
        }
        const input = requested.input ?? {};
        const preview = safePreview(routed, input, context);
        if (!preview.ok && routed.risk === "CONSEQUENTIAL") {
          throw new Error(
            `${routed.name} declares a change preview and it failed: ${preview.error}`,
          );
        }
        operations.push({
          capability: routed.name,
          input: structuredClone(input),
          preview: preview.changes,
        });
      }

      const risk = highestRisk(
        operations.map(
          (operation) => catalog.get(operation.capability)?.risk ?? "CONSEQUENTIAL",
        ),
      );
      const revision = options.revision?.(context);
      if (session.expired()) {
        throw new Error(
          "the runtime was reset while this plan was being prepared, so it was not created",
        );
      }
      const plan = plans.create({
        operations,
        summary: request.summary ?? describePlan(operations),
        risk,
        createdAt: now(),
        ...(revision !== undefined ? { expectedRevision: revision } : {}),
        ...(requester !== undefined ? { requestedBy: requester } : {}),
      });
      audit.append({
        kind: "plan_prepared",
        planId: plan.id,
        operations: operations.map((operation) => operation.capability),
        risk,
        at: now(),
      });
      emit();
      return plan;
    },

    approvePlan(planId, by) {
      // An approval is the record that a person authorized this plan.
      // Falling back to the ambient actor would let the requesting agent
      // sign off on its own plan, which is the one claim it exists to make.
      // Snapshotted and checked before the transition is claimed, so
      // neither a refusal nor an unrecordable identity can strand the plan
      // in APPROVED, and the plan and the audit event carry one value the
      // caller can no longer influence.
      const approver = resolveHumanActor(
        by ?? actor,
        "a plan approval must name a human authorizer; pass one to approvePlan rather than relying on the acting actor",
      );
      if (!approver.ok) {
        return approver;
      }
      const claimed = plans.transition(planId, "DRAFT", "APPROVED");
      if (!claimed) {
        return { ok: false, reason: `plan ${planId} is not awaiting approval` };
      }
      plans.resolve(planId, { approvedBy: approver.actor });
      audit.append({
        kind: "plan_approved",
        planId,
        actor: approver.actor,
        at: now(),
      });
      emit();
      return { ok: true, plan: plans.get(planId)! };
    },

    rejectPlan(planId) {
      const plan = plans.transition(planId, "DRAFT", "REJECTED");
      if (!plan) {
        return { ok: false, reason: `plan ${planId} is not awaiting approval` };
      }
      plans.resolve(planId, { resolvedAt: now() });
      audit.append({ kind: "plan_rejected", planId, at: now() });
      emit();
      return { ok: true, plan };
    },

    async commitPlan(planId) {
      const session = claimSession();
      const claimed = plans.transition(planId, "APPROVED", "COMMITTING");
      if (!claimed) {
        const existing = plans.get(planId);
        return {
          ok: false,
          reason: existing
            ? `plan ${planId} is ${existing.status}, not APPROVED`
            : `unknown plan: ${planId}`,
        };
      }

      // One commit has one executor, resolved the moment the plan claims
      // COMMITTING. Resolving per operation would let a setActor during a
      // suspended earlier operation give one commit's receipts two
      // different executors.
      const executor = actor;

      // The human approved a plan describing a specific state. If the
      // application moved since, that approval no longer covers what would
      // happen, so nothing runs.
      const observedRevision = options.revision?.(context);
      if (
        claimed.expectedRevision !== undefined &&
        observedRevision !== claimed.expectedRevision
      ) {
        plans.resolve(planId, {
          status: "DRIFTED",
          resolvedAt: now(),
          ...(observedRevision !== undefined ? { observedRevision } : {}),
        });
        audit.append({
          kind: "plan_drifted",
          planId,
          expectedRevision: claimed.expectedRevision,
          observedRevision: observedRevision ?? "unknown",
          at: now(),
        });
        emit();
        return {
          ok: false,
          reason: "the application changed after this plan was reviewed",
          plan: plans.get(planId)!,
        };
      }

      const outcomes: OperationOutcome[] = [];
      for (const operation of claimed.operations) {
        // Before each operation, not after all of them. Checking only at the
        // end let the operation after an interrupted one start, and it then
        // claimed the new session and committed into it.
        if (session.expired()) {
          return settleInterrupted(planId, claimed, outcomes);
        }
        outcomes.push(await commitOperation(planId, operation, executor));
      }
      if (session.expired()) {
        return settleInterrupted(planId, claimed, outcomes);
      }

      // COMMITTED is a claim that the work happened. An operation that
      // never ran, or one a verifier disproved, does not earn it.
      const broken = outcomes.filter((outcome) => outcome.status === "FAILED");
      const skipped = outcomes.filter((outcome) => outcome.status === "SKIPPED");
      const mismatched = outcomes.filter(
        (outcome) => outcome.verification.status === "MISMATCH",
      );
      const status =
        broken.length > 0
          ? "FAILED"
          : skipped.length === 0 && mismatched.length === 0
            ? "COMMITTED"
            : "PARTIAL";

      plans.resolve(planId, {
        status,
        outcomes,
        resolvedAt: now(),
        ...(observedRevision !== undefined ? { observedRevision } : {}),
      });
      audit.append({
        kind:
          status === "FAILED"
            ? "plan_failed"
            : status === "PARTIAL"
              ? "plan_partial"
              : "plan_committed",
        planId,
        outcomes: outcomes.map((outcome) => ({
          capability: outcome.capability,
          status: outcome.status,
          verification: outcome.verification.status,
        })),
        at: now(),
      });
      emit();
      const settled = plans.get(planId)!;
      if (status === "FAILED") {
        return {
          ok: false,
          reason: `${broken.length} of ${outcomes.length} operations failed: ${broken
            .map((outcome) => `${outcome.capability} (${outcome.detail ?? "no detail"})`)
            .join("; ")}`,
          plan: settled,
        };
      }
      if (status === "PARTIAL") {
        const parts: string[] = [];
        if (skipped.length > 0) {
          parts.push(
            `skipped ${skipped
              .map(
                (outcome) =>
                  `${outcome.capability} (${outcome.detail ?? "no detail"})`,
              )
              .join("; ")}`,
          );
        }
        if (mismatched.length > 0) {
          parts.push(
            `verification disproved ${mismatched
              .map((outcome) => outcome.capability)
              .join(", ")}`,
          );
        }
        return {
          ok: false,
          reason: `${outcomes.length} operations did not fully commit. The runtime ${parts.join(", and ")}.`,
          plan: settled,
        };
      }
      return { ok: true, plan: settled };
    },

    getPlan(planId) {
      return plans.get(planId);
    },

    listPlans() {
      return plans.list();
    },

    queryReceipts(filter) {
      return receipts.query(filter);
    },

    markReviewed(receiptId, by) {
      const stored = receipts.get(receiptId);
      if (!stored) {
        return { ok: false, reason: `unknown receipt: ${receiptId}` };
      }
      if (stored.reviewedAt !== undefined) {
        return { ok: false, reason: `${receiptId} was already reviewed` };
      }
      // A review is the record that a person looked. Falling back to the
      // ambient actor would let an agent silently sign off on its own work,
      // which is the one claim this record exists to make. Snapshotted
      // before the check and before the receipt is touched, for the same
      // reason `approvePlan` does it.
      const reviewer = resolveHumanActor(
        by ?? actor,
        "a review must name a human reviewer; pass one to markReviewed rather than relying on the acting actor",
      );
      if (!reviewer.ok) {
        return reviewer;
      }
      receipts.markReviewed(receiptId, now(), reviewer.actor);
      audit.append({
        kind: "receipt_reviewed",
        capability: stored.capability,
        receiptId,
        actor: reviewer.actor,
        at: now(),
      });
      emit();
      return { ok: true };
    },

    async rollback(receiptId) {
      const stored = receipts.get(receiptId);
      if (!stored) {
        return { ok: false, reason: `unknown receipt: ${receiptId}` };
      }
      const routed = routeCapability(catalog, stored.capability);
      if (isRouteError(routed) || !routed.rollback) {
        return {
          ok: false,
          reason: `${stored.capability} does not support rollback`,
        };
      }
      // Claimed synchronously, before the first await, so two concurrent
      // undos cannot both reach the compensating action.
      const session = claimSession();
      if (!receipts.claimRollback(receiptId)) {
        return {
          ok: false,
          reason:
            receipts.get(receiptId)?.rollbackState === "ROLLED_BACK"
              ? `${receiptId} was already rolled back`
              : `${receiptId} is already being rolled back`,
        };
      }
      // Same capture rule as an execution: the undo belongs to whoever
      // claimed it, not to whoever happens to be acting when it finishes.
      const actingActor = actor;
      if (routed.verify) {
        const drift = await runVerification(
          routed,
          stored.input,
          stored.receipt.changes,
        );
        if (session.expired()) {
          receipts.releaseRollback(receiptId);
          return {
            ok: false,
            reason: `${receiptId} belongs to a session that ended before the undo was dispatched`,
          };
        }
        if (drift.status !== "VERIFIED") {
          receipts.releaseRollback(receiptId);
          return {
            ok: false,
            reason: `rollback conflict on ${receiptId}: the application state no longer matches what the receipt described, so undoing it would overwrite a later change`,
          };
        }
      }
      try {
        const result = await routed.rollback(
          stored.input,
          context,
          stored.receipt.changes,
        );
        // The compensating action completed. Returning without settling the
        // receipt left it ROLLING_BACK, and stop() keeps receipts, so every
        // later undo of it was refused as already running.
        receipts.markRolledBack(receiptId, now());
        if (session.expired()) {
          return {
            ok: false,
            reason: `${receiptId} belongs to a session that ended while the undo was running`,
          };
        }
        audit.append({
          kind: "rollback_performed",
          capability: stored.capability,
          receiptId,
          ...(actingActor !== undefined ? { actor: actingActor } : {}),
          at: now(),
        });
        emit();
        return { ok: true, result };
      } catch (err) {
        receipts.releaseRollback(receiptId);
        if (session.expired()) {
          return {
            ok: false,
            reason: `${receiptId} belongs to a session that ended while the undo was running`,
          };
        }
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
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
    async approve(actionId, by) {
      const session = claimSession();
      const authorizer = resolveHumanActor(
        by ?? actor,
        "an approval must name a human; pass one explicitly rather than relying on the acting actor",
      );
      if (!authorizer.ok) {
        return errorResult(authorizer.reason);
      }
      // Same boundary rule as `runCapability`. The execution this releases
      // belongs to whoever was acting when the approval was claimed, not to
      // whoever happens to be acting once the re-checks below finish.
      const actingActor = actor;
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
      try {
      // Policy is re-evaluated here, not just at request time: a rule that
      // started denying while the action sat pending must block it.
      const decision = policy({
        capability: routed,
        input: action.input,
        context,
      });
      if (decision.kind === "deny") {
        approvals.resolve(actionId, {
          status: "FAILED",
          action,
          error: decision.reason,
          resolvedAt: now(),
        });
        audit.append({
          kind: "policy_denied",
          capability: action.capability,
          reason: decision.reason,
          at: now(),
        });
        emit();
        return policyDenied(action.capability, decision.reason);
      }

      const availability = evaluateAvailability(routed, context);
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
        approvedBy: authorizer.actor,
        at: now(),
      });
      const outcome = await executeNow(routed, action.input, {
        actor: actingActor,
        humanInitiated: true,
      });
      // approvals.resolve inserts, so resolving after a reset put the cleared
      // action back into the fresh session. Nothing here belongs to it.
      if (session.expired()) {
        return executionCancelled(action.capability);
      }
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
      } catch (err) {
        // The action is already claimed, so a throw anywhere in these
        // checks would otherwise strand it in EXECUTING with no retry.
        const message = err instanceof Error ? err.message : String(err);
        approvals.resolve(actionId, {
          status: "FAILED",
          action,
          error: message,
          resolvedAt: now(),
        });
        audit.append({
          kind: "execution_failed",
          capability: action.capability,
          executionId: `${actionId}-approval-check`,
          error: message,
          at: now(),
        });
        emit();
        return errorResult(message);
      }
    },
    reject(actionId, by) {
      const authorizer = resolveHumanActor(
        by ?? actor,
        "a rejection must name a human; pass one explicitly rather than relying on the acting actor",
      );
      if (!authorizer.ok) {
        return errorResult(authorizer.reason);
      }
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
        rejectedBy: authorizer.actor,
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
          idempotency_key: {
            type: "string",
            description:
              "Optional. Retrying with the same key returns the first result instead of executing again.",
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

/**
 * Combines the client's execution signal with the runtime lifecycle
 * signal. Hand-rolled rather than AbortSignal.any so the package works on
 * Node 18, and disposed in a finally block so long-lived runtime signals
 * do not accumulate listeners.
 */
function linkSignals(
  ...signals: Array<AbortSignal | undefined>
): { signal: AbortSignal; dispose: () => void } {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  const controller = new AbortController();
  const already = present.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const s of present) {
    s.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const s of present) {
        s.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * A capability that declares no preview is fine. One that declares a
 * preview and throws is not: for a consequential action the caller would
 * be approving blind, so the failure is reported rather than swallowed.
 */
function safePreview(
  capability: Capability,
  input: Record<string, unknown>,
  ctx: AppContext,
): { ok: true; changes: Change[] } | { ok: false; error: string; changes: Change[] } {
  if (!capability.previewChanges) {
    return { ok: true, changes: [] };
  }
  try {
    return { ok: true, changes: capability.previewChanges(input, ctx) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      changes: [],
    };
  }
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
