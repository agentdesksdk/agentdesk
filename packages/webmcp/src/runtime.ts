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
} from "./capability.ts";
import { CapabilityCatalog } from "./catalog.ts";
import {
  decidePolicy,
  riskBasedPolicy,
  type PolicyDecision,
  type PolicyEngine,
} from "./policy.ts";
import type {
  Evidence,
  Refusal,
  Repair,
  Settled,
  Situation,
} from "./protocol.ts";
import type { Grant, GrantRequest } from "./grants.ts";
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
import {
  ReceiptStore,
  type ReceiptQuery,
  type ReconciliationOutcome,
  type StoredReceipt,
} from "./receipts.ts";
import { compareNames, isRouteError, rankCapabilities, routeCapability } from "./router.ts";
import {
  approvalRequired,
  capabilityUnavailable,
  completed,
  errorResult,
  executionCancelled,
  executionIndeterminate,
  idempotencyCapacity,
  idempotencyConflict,
  isReceiptEnvelope,
  isToolResult,
  policyDenied,
  previewUnavailable,
  toolRetired,
  toToolResult,
  validationFailed,
  type ToolResult,
} from "./results.ts";
import {
  buildStageHandler,
  parseResolution,
  StagedCommitIndeterminate,
  StagedProposalStore,
  UnreconciledStore,
  type StagedProposal,
  type StagedResolution,
  type StagingAdapter,
  type Unreconciled,
} from "./staging.ts";
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

/**
 * Why a rollback may or may not be recorded, kept separate from the
 * `VerificationResult` it carries.
 *
 * Collapsing these onto the status was the earlier bug. `UNSUPPORTED` meant
 * both "a declared verifier could not check" and "the capability accepts the
 * handler's word", and only the second one is evidence.
 */
type RollbackProof =
  | { kind: "proven"; verification: VerificationResult }
  | { kind: "accepted"; verification: VerificationResult }
  | { kind: "unreconciled"; verification: VerificationResult; detail: string };

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
  /** The author's repair, kept only when the agent can call it right now. */
  repair?: Repair;
  /** Derived from `repair.capability`; kept one release for readers of the old name. */
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
  /** Every grant issued this session, in every state, detached. */
  grants: Grant[];
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

  /**
   * Staged outcomes nobody can call settled: a commit that threw after it
   * may already have written, and a disposal that failed and left the
   * artifact open. Both need a person to say what happened.
   */
  listUnreconciled: () => Unreconciled[];
  /**
   * Records what a human found. `target` is an approval id or the record's
   * own id, and `by` must be a human, because nobody else can go and look.
   */
  reconcile: (
    target: string,
    resolution: StagedResolution,
    by?: Actor,
  ) => { ok: true } | { ok: false; reason: string };

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
   * A person approves a bounded mandate once. The issuer must be a human
   * and goes through the same parsing as the ambient actor, so a malformed
   * or agent identity throws rather than minting authority. Request-shape
   * problems, an unknown capability, a non-positive use count, or an
   * expiry already passed, refuse with a reason.
   */
  grant: (
    request: GrantRequest,
    by?: Actor,
  ) => { ok: true; grant: Grant } | { ok: false; reason: string };
  /** Immediate. The next use refuses; an execution already committed is untouched. */
  revokeGrant: (
    grantId: string,
    by?: Actor,
  ) => { ok: true; grant: Grant } | { ok: false; reason: string };
  listGrants: () => Grant[];
  getGrant: (grantId: string) => Grant | undefined;

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
   *
   * Success is not the handler's to declare. Where a verifier exists it runs
   * again afterwards, and finding the original change still in place means
   * nothing was undone, so the receipt goes to INDETERMINATE rather than
   * ROLLED_BACK. A handler that throws after dispatch also lands there, and
   * only `reconcileRollback` leaves it.
   */
  rollback: (
    receiptId: string,
  ) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;

  /**
   * Settles a rollback the runtime could not. The caller has established
   * whether the compensating write landed, by reading the application rather
   * than by inference, and says which. `compensated` spends the receipt,
   * `untouched` makes undo available again.
   */
  reconcileRollback: (
    receiptId: string,
    outcome: ReconciliationOutcome,
    by?: Actor,
  ) => { ok: true; receipt: StoredReceipt } | { ok: false; reason: string };
};

export function createAgentDeskRuntime<S = unknown>(options: {
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
  /**
   * How this application forks, describes, and lands its own state.
   *
   * Bound here rather than on each capability, so the code that describes a
   * change and the code that performs it are not both supplied by whoever
   * declared the operation. Required before any staged capability can run.
   */
  staging?: StagingAdapter<S>;
  /** Who is acting. Recorded on audit events, receipts, and presentation. */
  actor?: Actor;
}): AgentDeskRuntime {
  const audit = new AuditBus();
  const approvals = new ApprovalManager();
  const presentation = new PresentationBus();
  const plans = new PlanStore();
  const receipts = new ReceiptStore();
  // Staged proposals live here, keyed by the runtime identity that owns
  // each one, never by business input. Disposal is this store's job on
  // every path that resolves an owner without committing it.
  const proposals = new StagedProposalStore();
  // Staged outcomes nobody can call settled: a commit that threw after it may
  // have written, and a disposal that failed and left the artifact open.
  const unreconciled = new UnreconciledStore();
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
        .sort(([a], [b]) => compareNames(a, b))
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
    (name) =>
      toolRetired(
        name,
        refusal(catalog.get(name), { capability: FIND_CAPABILITIES }),
      ),
  );

  function appOnly(capability: Capability): boolean {
    return !BUILTIN_NAMES.has(capability.name);
  }

  /**
   * Whether policy lets routing offer a capability at all. This is the one
   * eligibility check: `find_capabilities`, the native surface, and the
   * `nowPossible` and `blockedCapabilities` lists on every result all read
   * it, so none of them can name a capability the others would not.
   *
   * Routing has no input, so policy is asked with none. A policy that
   * denies on missing input hides the capability from routing, which is the
   * safe direction, and a throwing policy denies for the same reason.
   *
   * Denied means invisible: absent from a routing report, from the native
   * surface, from both lists, and never named as a repair. That is the line
   * between denied and unavailable, which stays visible with its reason.
   * Bootstrap tools are always offered.
   */
  function routable(capability: Capability): boolean {
    return offering(capability).kind !== "deny";
  }

  /** The decision behind `routable`, kept so a refusal can carry its reason. */
  function offering(capability: Capability): PolicyDecision {
    if (BUILTIN_NAMES.has(capability.name)) {
      return { kind: "allow" };
    }
    try {
      return policy({ capability, input: {}, context });
    } catch (err) {
      return {
        kind: "deny",
        reason: `the policy threw while deciding whether ${capability.name} may be offered: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /** Routable and available right now: what the agent can call. */
  function callable(capability: Capability): boolean {
    return (
      routable(capability) && evaluateAvailability(capability, context).available
    );
  }

  /**
   * The author's repair, checked. A repair is kept only when it names a
   * capability the agent can call right now, so it is always an
   * instruction the agent can follow, and a denied capability is never
   * repeated back. An unknown or unavailable one is dropped rather than
   * offered as a fix that would refuse.
   */
  function visibleRepair(repair: Repair | undefined): Repair | undefined {
    if (repair === undefined) {
      return undefined;
    }
    const target = catalog.get(repair.capability);
    return target !== undefined && callable(target) ? repair : undefined;
  }

  /**
   * What is possible and what is blocked, seen from one capability.
   *
   * The neighbourhood is the capability, its author's repair, one hop of
   * the relationship graph in both directions, and what the last routing
   * offered. That is where "what now" lives: the step this one needed, the
   * step it just unblocked, the alternative its author named, and the
   * working set the agent already holds. It is bounded by the routing
   * budget plus a capability's declared edges, so a result never becomes a
   * catalog dump.
   *
   * The author's repair enters unfiltered so an unavailable one is listed
   * as blocked; `partition` is what keeps a denied one out.
   */
  function situationFor(
    subject: Capability | undefined,
    repair: Repair | undefined,
    evidence: readonly Evidence[],
  ): Situation {
    const names = new Set<string>();
    if (subject !== undefined) {
      names.add(subject.name);
      for (const name of subject.relationships.requires) {
        names.add(name);
      }
      for (const name of subject.relationships.related) {
        names.add(name);
      }
      for (const other of catalog.all()) {
        if (
          other.relationships.requires.includes(subject.name) ||
          other.relationships.related.includes(subject.name)
        ) {
          names.add(other.name);
        }
      }
    }
    if (repair !== undefined) {
      names.add(repair.capability);
    }
    for (const match of lastRouting?.matches ?? []) {
      names.add(match.name);
    }
    return partition([...names], evidence);
  }

  /**
   * Splits names into the two lists through the same `routable` check
   * routing uses. A denied name is in neither. Bootstrap tools are in
   * neither either, because they are the constant surface rather than a
   * situation. Codepoint order, so equal situations serialize identically.
   */
  function partition(
    names: readonly string[],
    evidence: readonly Evidence[],
  ): Situation {
    const nowPossible: string[] = [];
    const blockedCapabilities: string[] = [];
    for (const name of [...new Set(names)].sort(compareNames)) {
      const capability = catalog.get(name);
      if (
        capability === undefined ||
        !appOnly(capability) ||
        !routable(capability)
      ) {
        continue;
      }
      if (evaluateAvailability(capability, context).available) {
        nowPossible.push(name);
      } else {
        blockedCapabilities.push(name);
      }
    }
    return {
      nowPossible,
      blockedCapabilities,
      evidence: evidence.map((item) => ({ ...item })),
    };
  }

  /** What a refusal is built from. The repair on it is the author's, checked. */
  function refusal(
    subject: Capability | undefined,
    repair?: Repair,
    evidence: readonly Evidence[] = [],
  ): Refusal {
    const situation = situationFor(subject, repair, evidence);
    const visible = visibleRepair(repair);
    return visible === undefined ? situation : { ...situation, repair: visible };
  }

  /** What a completed, pending, or indeterminate result is built from. */
  function settled(
    subject: Capability,
    evidence: readonly Evidence[] = [],
  ): Settled {
    return situationFor(subject, undefined, evidence);
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
      grants: [],
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
    // A denied capability is registered on no path. Registering it would
    // publish its name, description, and schema through `getTools()`.
    const available = availableCapabilities(catalog, context).filter(routable);
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
    // What routing would not offer, invocation does not describe. Checked
    // ahead of availability so a caller who guessed a denied capability's
    // name learns nothing about its state. The input-bearing policy check
    // still runs after validation, where the input it reads is known good.
    const offered = offering(capability);
    if (offered.kind === "deny") {
      audit.append({
        kind: "policy_denied",
        capability: capability.name,
        reason: offered.reason,
        at: now(),
      });
      emit();
      return policyDenied(capability.name, offered.reason, refusal(capability));
    }
    const availability = evaluateAvailability(capability, context);
    if (!availability.available) {
      audit.append({
        kind: "capability_unavailable",
        capability: capability.name,
        reasonCode: availability.reasonCode,
        at: now(),
      });
      emit();
      return capabilityUnavailable(
        capability.name,
        availability,
        refusal(capability, availability.repair),
      );
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
      return capabilityUnavailable(
        capability.name,
        inputCheck,
        refusal(capability, inputCheck.repair),
      );
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
      // The repair is the same capability with the arguments fixed.
      return validationFailed(
        capability.name,
        validation.issues,
        refusal(capability, { capability: capability.name }),
      );
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
      return policyDenied(capability.name, decision.reason, refusal(capability));
    }

    present(capability, "capability_started", input, invocationActor);
    if (decision.kind === "require_approval") {
      const summary =
        capability.describeApproval?.(input, context) ??
        capability.title ??
        capability.name;
      const staged = stageFor(capability, input, signal);
      if (!staged.ok) {
        audit.append({
          kind: "capability_unavailable",
          capability: capability.name,
          reasonCode: "PREVIEW_UNAVAILABLE",
          at: now(),
        });
        emit();
        return previewUnavailable(
          capability.name,
          staged.error,
          refusal(capability),
        );
      }
      const preview = staged.proposal
        ? { ok: true as const, changes: [...staged.proposal.changes] }
        : safePreview(capability, input, context);
      if (!preview.ok && capability.risk === "CONSEQUENTIAL") {
        staged.proposal?.discard();
        audit.append({
          kind: "capability_unavailable",
          capability: capability.name,
          reasonCode: "PREVIEW_UNAVAILABLE",
          at: now(),
        });
        emit();
        return previewUnavailable(
          capability.name,
          preview.error,
          refusal(capability),
        );
      }
      let action;
      try {
        action = approvals.request(
          capability.name,
          input,
          capability.risk,
          summary,
          preview.changes,
          now(),
        );
      } catch (err) {
        // Nothing owns the proposal yet, so a failure to record the pending
        // action would otherwise strand the fork with no way to reach it.
        staged.proposal?.discard();
        throw err;
      }
      if (staged.proposal) {
        // An identical pending request returns the action that already
        // exists, whose preview came from the proposal held for it.
        // Replacing that artifact would let a human approve one diff and
        // land another, so the newer staging is thrown away instead.
        if (proposals.has(action.id)) {
          staged.proposal.discard();
        } else {
          proposals.put(action.id, staged.proposal);
        }
      }
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
        settled(capability, [{ kind: "approval", id: action.id }]),
      );
    }
    // A previous call of this exact operation may already have written. A
    // repeat would apply it twice, so it is refused until a human has said
    // what happened. This guards the unapproved path, which is the one a
    // caller can reach without anyone looking.
    const unresolved = unreconciled.forOperation(
      operationKey(capability.name, input),
    );
    if (unresolved) {
      emit();
      return executionIndeterminate(
        capability.name,
        unresolved.id,
        unresolved.detail,
        unresolved.changes,
        settled(capability, [{ kind: "record", id: unresolved.id }]),
      );
    }

    // Ownership of the idempotency slot is settled before anything is
    // staged. A replay or a refusal that staged first would leave behind a
    // proposal that neither commits nor is discarded, because only the
    // winner reaches the disposal paths below.
    const claim = claimIdempotency(capability, input, idempotencyKey);
    if (claim.kind === "refused") {
      return claim.result;
    }
    if (claim.kind === "replay") {
      return await claim.result;
    }
    const settle = (result: ToolResult): ToolResult => {
      if (claim.kind === "won") {
        claim.settle(result);
      }
      return result;
    };

    // A staged capability has no runnable handler. On the unapproved path
    // it stages and lands in one step, so the same artifact still produces
    // both the change and the record of it.
    const direct = stageFor(capability, input, signal);
    if (!direct.ok) {
      audit.append({
        kind: "capability_unavailable",
        capability: capability.name,
        reasonCode: "PREVIEW_UNAVAILABLE",
        at: now(),
      });
      emit();
      return settle(
        previewUnavailable(capability.name, direct.error, refusal(capability)),
      );
    }
    const outcome = await executeNow(capability, input, {
      actor: invocationActor,
      signal,
      idempotencyKey,
      claim,
      ...(direct.proposal ? { commit: direct.proposal.commit } : {}),
    });
    if (!outcome.ok) {
      direct.proposal?.discard();
    }
    return outcome.result;
  }

  /**
   * Produces the staged proposal for a capability that declares one. A
   * capability with no `stage` returns no proposal and keeps whatever
   * preview it declared.
   */
  /**
   * Identity of one call. Two invocations that agree on capability and input
   * are the same operation, which is what makes a repeat detectable.
   */
  function operationKey(
    capability: string,
    input: Record<string, unknown>,
  ): string {
    return `${capability}:${fingerprintInput(input)}`;
  }

  function stageFor(
    capability: Capability,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ):
    | { ok: true; proposal?: StagedProposal }
    | { ok: false; error: string } {
    if (!capability.stagedOperation) {
      return { ok: true };
    }
    if (!options.staging) {
      return {
        ok: false,
        error: `${capability.name} stages its write and the runtime has no staging adapter, so nothing can derive or land it`,
      };
    }
    const stage = buildStageHandler(
      capability.stagedOperation,
      options.staging,
      {
        cleanupFailed: (failure) => {
          // Attempting a hook that throws disposes nothing, so the artifact
          // is still open in the application and has to stay findable.
          const record = unreconciled.record(
            {
              capability: capability.name,
              kind: "cleanup_failed",
              detail: failure.detail,
              changes: [],
              at: now(),
            },
            failure.artifact,
          );
          audit.append({
            kind: "staged_cleanup_failed",
            capability: capability.name,
            recordId: record.id,
            detail: failure.detail,
            at: now(),
          });
        },
      },
    );
    const linked = linkSignals(signal, epochController.signal);
    try {
      const proposal = stage(input);
      return { ok: true, proposal };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      linked.dispose();
    }
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
    | {
        ok: false;
        executionId?: string;
        /** Set when the commit threw after it may already have written. */
        indeterminate?: {
          detail: string;
          recordId: string;
          changes: readonly Change[];
        };
        result: ToolResult;
      };

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
     * An idempotency slot the caller already claimed. Present when the
     * caller had to know it owned this execution before doing work that
     * needs disposing, which staging does.
     */
    claim?: IdempotencyClaim | undefined;
    /**
     * Lands an already-staged proposal instead of calling the capability's
     * handler. A staged capability has no runnable handler, so this is the
     * only way its write reaches live state.
     */
    commit?: (() => unknown) | undefined;
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

  /**
   * How well an undo was proven, which is a different question from whether
   * the original write is still visible.
   *
   * `verifyRollback` answers it directly and is authoritative. `verify` only
   * detects a no-op, because its MISMATCH says state moved without saying
   * where to, and an undo landing on a third value is not a rollback. A
   * verifier that failed proves nothing at all, so PARTIAL is not a pass.
   */
  async function proveRollback(
    capability: Capability,
    input: Record<string, unknown>,
    changes: readonly Change[],
  ): Promise<RollbackProof> {
    if (capability.verifyRollback) {
      let result: VerificationResult;
      try {
        result = await capability.verifyRollback(input, context, changes);
      } catch (err) {
        result = {
          status: "PARTIAL",
          unverified: changes.map((change) => change.field),
          note: `rollback verifier failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // Only VERIFIED. A declared verifier answering UNSUPPORTED is saying it
      // could not check, which is not the same fact as a capability declaring
      // that the handler's word is the evidence.
      return result.status === "VERIFIED"
        ? { kind: "proven", verification: result }
        : {
            kind: "unreconciled",
            verification: result,
            detail:
              "the rollback verifier did not confirm the recorded before-state is back",
          };
    }
    // No rollback verifier. `verify` still detects the one failure it can
    // see, a handler that returned while its change is untouched, and that
    // is a disproof rather than a proof, so it outranks the opt-out.
    if (capability.verify) {
      const seen = await runVerification(capability, input, changes);
      if (seen.status === "VERIFIED") {
        return {
          kind: "unreconciled",
          verification: {
            status: "MISMATCH",
            field: changes[0]?.field ?? "",
            expected: changes[0]?.before,
            observed: changes[0]?.after,
          },
          detail:
            "the handler reported success while the original change was still in place",
        };
      }
    }
    if (capability.rollbackEvidence === "handler") {
      return {
        kind: "accepted",
        verification: { status: "UNSUPPORTED" },
      };
    }
    return {
      kind: "unreconciled",
      verification: {
        status: "PARTIAL",
        unverified: changes.map((change) => change.field),
        note: "no rollback evidence",
      },
      detail:
        "nothing proves the recorded before-state is back. Declare verifyRollback, or rollbackEvidence: \"handler\" to accept the handler's word",
    };
  }

  /**
   * Who owns this execution of an idempotency key.
   *
   * Resolved synchronously, before anything else happens, because staging
   * comes after it. A duplicate that staged first and then discovered it had
   * lost would have built a proposal nobody commits or discards.
   */
  type IdempotencyClaim =
    | { kind: "none" }
    | { kind: "won"; settle: (result: ToolResult) => void }
    | { kind: "replay"; result: Promise<ToolResult> }
    | { kind: "refused"; result: ToolResult };

  /**
   * Claims or joins the slot for `idempotencyKey`. Synchronous, so a
   * duplicate arriving in the same tick sees the winner's entry rather than
   * racing it.
   */
  function claimIdempotency(
    capability: Capability,
    input: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): IdempotencyClaim {
    if (idempotencyKey === undefined) {
      return { kind: "none" };
    }
    const slot = `${capability.name}:${idempotencyKey}`;
    const fingerprint = fingerprintInput(input);
    const previous = idempotency.get(slot);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return {
          kind: "refused",
          result: idempotencyConflict(
            capability.name,
            idempotencyKey,
            refusal(capability),
          ),
        };
      }
      return { kind: "replay", result: previous.inFlight };
    }
    if (!reserveIdempotencySlot()) {
      return {
        kind: "refused",
        result: idempotencyCapacity(
          capability.name,
          IDEMPOTENCY_LIMIT,
          refusal(capability),
        ),
      };
    }
    let resolve: (result: ToolResult) => void = () => {};
    const entry: IdempotencyEntry = {
      fingerprint,
      inFlight: new Promise<ToolResult>((settled) => {
        resolve = settled;
      }),
      settled: false,
    };
    idempotency.set(slot, entry);
    return {
      kind: "won",
      settle: (result) => {
        if (entry.settled) {
          return;
        }
        entry.settled = true;
        resolve(result);
      },
    };
  }

  async function executeNow(
    capability: Capability,
    input: Record<string, unknown>,
    opts: ExecutionOptions,
  ): Promise<ExecutionOutcome> {
    const claim = opts.claim ?? claimIdempotency(capability, input, opts.idempotencyKey);
    if (claim.kind === "refused") {
      return { ok: false, result: claim.result };
    }
    if (claim.kind === "replay") {
      return { ok: true, value: undefined, result: await claim.result };
    }
    const outcome = await runExecution(capability, input, opts);
    if (claim.kind === "won") {
      claim.settle(outcome.result);
    }
    return outcome;
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
      const value = opts.commit
        ? opts.commit()
        : await capability.execute(input, execContext);
      if (session.expired()) {
        return {
          ok: false,
          executionId,
          result: executionCancelled(capability.name, refusal(capability)),
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
          result: executionCancelled(capability.name, refusal(capability)),
        };
      }
      // Everything that can fail is built before anything is committed. A
      // receipt the store cannot hold and a result that will not serialize
      // are both failures of this execution, not of the bookkeeping after
      // it, so they belong on the failure path while it is still reachable.
      //
      // The result itself is assembled after the commit, because it names
      // the receipt the store assigns. That is safe only because the value
      // is reduced to plain data here, once, so the assembly below cannot
      // throw and cannot read a handler's getter a second time.
      let recordable: unknown;
      let pending: Parameters<typeof receipts.record>[0] | undefined;
      try {
        if (isToolResult(value)) {
          recordable = value;
        } else {
          const raw = isReceiptEnvelope(value) ? value.value : value;
          const json = JSON.stringify(raw === undefined ? null : raw);
          recordable = json === undefined ? null : JSON.parse(json);
        }
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
      const stored = pending ? receipts.record(pending) : undefined;
      const evidence: Evidence[] = [
        ...(stored ? [{ kind: "receipt" as const, id: stored.id }] : []),
        { kind: "execution", id: executionId },
      ];
      const toolResult = completed(recordable, pending?.receipt, {
        ...settled(capability, evidence),
        changes: pending?.receipt.changes ?? [],
      });
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
      const attempted: Evidence[] = [{ kind: "execution", id: executionId }];
      if (session.expired()) {
        return {
          ok: false,
          executionId,
          result: executionCancelled(
            capability.name,
            refusal(capability, undefined, attempted),
          ),
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
          result: capabilityUnavailable(
            capability.name,
            err.unavailability,
            refusal(capability, err.unavailability.repair, attempted),
          ),
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      // A commit that threw may already have written. Recording that as a
      // clean failure would invite a retry that applies the change twice.
      if (err instanceof StagedCommitIndeterminate) {
        const record = unreconciled.record(
          {
            capability: capability.name,
            operationKey: operationKey(capability.name, input),
            kind: "commit_indeterminate",
            detail: message,
            changes: err.changes,
            ...(planId !== undefined ? { planId } : {}),
            at: now(),
          },
          err.artifact,
        );
        audit.append({
          kind: "execution_indeterminate",
          capability: capability.name,
          executionId,
          recordId: record.id,
          detail: message,
          ...(actingActor !== undefined ? { actor: actingActor } : {}),
          at: now(),
        });
        present(capability, "capability_failed", input, actingActor, {
          executionId,
          humanInitiated,
        });
        emit();
        return {
          ok: false,
          executionId,
          indeterminate: {
            detail: message,
            recordId: record.id,
            changes: err.changes,
          },
          result: executionIndeterminate(
            capability.name,
            record.id,
            message,
            err.changes,
            settled(capability, [{ kind: "record", id: record.id }, ...attempted]),
          ),
        };
      }
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
    index: number,
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

      const proposal = proposals.take(
        StagedProposalStore.planKey(planId, index),
      );
      if (routed.stagedOperation && !proposal) {
        return blocked(
          "STAGED_PROPOSAL_MISSING: the staged change reviewed for this operation is no longer held by the runtime",
        );
      }
      const outcome = await executeNow(routed, operation.input, {
        planId,
        actor: executor,
        ...(proposal ? { commit: proposal.commit } : {}),
      });
      if (!outcome.ok && !outcome.indeterminate) {
        proposal?.discard();
      }
      const correlation =
        outcome.executionId !== undefined
          ? { executionId: outcome.executionId }
          : {};
      if (!outcome.ok) {
        if (outcome.indeterminate) {
          // The artifact is retained, not discarded, and the record is bound
          // to this operation so a human can tell which one it belongs to.
          unreconciled.attach(outcome.indeterminate.recordId, {
            planId,
            operationIndex: index,
          });
          return {
            capability: operation.capability,
            ...correlation,
            status: "INDETERMINATE",
            recordId: outcome.indeterminate.recordId,
            detail: outcome.indeterminate.detail,
            verification: { status: "UNSUPPORTED" },
          };
        }
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
    // Routing offers what policy lets it offer, and nothing else is ranked,
    // annotated, or counted. A denied capability is absent from the report.
    const appCaps = catalog.all().filter(appOnly).filter(routable);
    let ranked = rankCapabilities(appCaps, context, query);
    let fallback = false;
    if (ranked.length === 0) {
      fallback = true;
      ranked = appCaps
        .filter((capability) => evaluateAvailability(capability, context).available)
        .sort((a, b) => compareNames(a.name, b.name))
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
        const repair = visibleRepair(availability.repair);
        if (repair !== undefined) {
          match.repair = repair;
          match.suggestedCapability = repair.capability;
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

    // The report's situation is what it offered plus the repairs those
    // offers named, through the same partition every other result uses.
    const situation = partition(
      matches.flatMap((match) =>
        match.repair ? [match.name, match.repair.capability] : [match.name],
      ),
      [],
    );
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
        if (match.repair !== undefined) {
          out.repair = match.repair;
          out.suggestedCapability = match.repair.capability;
        }
        return out;
      }),
      ...situation,
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
    if (record.status === "INDETERMINATE") {
      base.detail = record.detail;
      base.record_id = record.recordId;
      base.changes = unreconciled
        .list()
        .find((entry) => entry.id === record.recordId)?.changes;
      base.hint =
        "The commit threw after it may already have written. Check the application, then call reconcile with what you found. Do not retry.";
    }
    return toToolResult(base);
  }

  function pruneRouted(): void {
    const next = new Set<string>();
    for (const name of routedNames) {
      const capability = catalog.get(name);
      if (capability && callable(capability)) {
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
      // Checked once, here, rather than at each staged invocation. A staged
      // capability with no adapter has no way to derive or land its change,
      // and finding that out at approval time would mean an operator saw a
      // card for something that could never run.
      const unbacked = catalog
        .all()
        .filter((capability: Capability) => capability.stagedOperation !== undefined);
      if (unbacked.length > 0 && !options.staging) {
        throw new Error(
          `${unbacked
            .map((capability: Capability) => capability.name)
            .join(", ")} stage their writes and no staging adapter is bound; pass one to createAgentDeskRuntime`,
        );
      }
      if (options.staging) {
        for (const hook of [
          "scope",
          "fork",
          "diff",
          "commit",
          "release",
          "reconcile",
        ] as const) {
          if (typeof options.staging[hook] !== "function") {
            throw new Error(
              `the staging adapter is missing ${hook}, so a staged change could not be handled`,
            );
          }
        }
        // A capability naming an operation the adapter has not got would fail
        // at approval time, after an operator was already shown a card for a
        // change that could never run.
        const known = new Set(options.staging.operations ?? []);
        const missing = unbacked.filter(
          (capability: Capability) => !known.has(capability.stagedOperation!),
        );
        if (missing.length > 0) {
          throw new Error(
            `the staging adapter owns no operation named ${missing
              .map((capability: Capability) => capability.stagedOperation)
              .join(", ")}, named by ${missing
              .map((capability: Capability) => capability.name)
              .join(", ")}`,
          );
        }
      }
      await surface.reconcile(desiredNative());
      started = true;
      emit();
    },
    async stop() {
      started = false;
      endEpoch();
      proposals.discardAll();
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
      // Unreconciled records survive. A reset clears the runtime's own
      // bookkeeping; it cannot clear an artifact still open in the
      // application, and deleting the record would lose the only thing that
      // could still find it. A disposal that fails during this discardAll
      // records itself and stays for the same reason.
      proposals.discardAll();
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
      const staged: Array<StagedProposal | undefined> = [];
      const routedOperations = request.operations.map((requested) => {
        const routed = routeCapability(catalog, requested.capability);
        if (isRouteError(routed)) {
          throw new Error(`unknown capability: ${requested.capability}`);
        }
        return { routed, input: requested.input ?? {} };
      });
      // Every operation derives inside one scope, so operation two sees what
      // operation one staged. Without it the human reviews previews computed
      // against a state the earlier operations are about to change.
      if (
        routedOperations.some(({ routed }) => routed.stagedOperation) &&
        !options.staging
      ) {
        throw new Error(
          "this plan contains a staged capability and the runtime has no staging adapter, so its operations would each preview against live state rather than against their predecessors",
        );
      }
      const scope = options.staging
        ? options.staging.scope
        : <T,>(run: () => T): T => run();
      try {
        scope(() => {
          for (const { routed, input } of routedOperations) {
            const proposal = stageFor(routed, input);
            if (!proposal.ok) {
              throw new Error(
                `${routed.name} could not stage its change: ${proposal.error}`,
              );
            }
            staged.push(proposal.proposal);
            const preview = proposal.proposal
              ? { ok: true as const, changes: [...proposal.proposal.changes] }
              : safePreview(routed, input, context);
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
        });
      } catch (err) {
        for (const proposal of staged) {
          proposal?.discard();
        }
        throw err;
      }

      const risk = highestRisk(
        operations.map(
          (operation) => catalog.get(operation.capability)?.risk ?? "CONSEQUENTIAL",
        ),
      );
      const revision = options.revision?.(context);
      if (session.expired()) {
        for (const proposal of staged) {
          proposal?.discard();
        }
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
      staged.forEach((proposal, index) => {
        if (proposal) {
          proposals.put(StagedProposalStore.planKey(plan.id, index), proposal);
        }
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
      // Claimed first. Discarding before the transition let a refused
      // rejection destroy the artifacts an approved plan still needs, so a
      // command that reports failure changed state anyway.
      const plan = plans.transition(planId, "DRAFT", "REJECTED");
      if (!plan) {
        return { ok: false, reason: `plan ${planId} is not awaiting approval` };
      }
      proposals.discardPlan(planId);
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
        // Terminal, so the staged changes can never be committed. Released
        // here rather than left reachable, because every terminal path
        // either commits its artifacts or disposes them.
        proposals.discardPlan(planId);
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

      // Checked for the whole plan before the first operation runs. A plan
      // that would lose a staged artifact halfway leaves the application
      // half-changed against a review that covered all of it.
      const missing = claimed.operations
        .map((operation, index) => ({ operation, index }))
        .filter(({ operation, index }) => {
          const routed = routeCapability(catalog, operation.capability);
          return (
            !isRouteError(routed) &&
            routed.stagedOperation &&
            !proposals.has(StagedProposalStore.planKey(planId, index))
          );
        });
      if (missing.length > 0) {
        proposals.discardPlan(planId);
        const reason = `the staged changes behind ${missing
          .map(({ operation }) => operation.capability)
          .join(", ")} are no longer held by the runtime, so nothing was committed`;
        plans.resolve(planId, {
          status: "FAILED",
          resolvedAt: now(),
          ...(observedRevision !== undefined ? { observedRevision } : {}),
        });
        audit.append({
          kind: "plan_failed",
          planId,
          outcomes: missing.map(({ operation }) => ({
            capability: operation.capability,
            status: "SKIPPED" as const,
            verification: "UNSUPPORTED" as const,
          })),
          at: now(),
        });
        emit();
        return { ok: false, reason, plan: plans.get(planId)! };
      }

      const outcomes: OperationOutcome[] = [];
      for (const [index, operation] of claimed.operations.entries()) {
        // Before each operation, not after all of them. Checking only at the
        // end let the operation after an interrupted one start, and it then
        // claimed the new session and committed into it.
        if (session.expired()) {
          proposals.discardPlan(planId);
          return settleInterrupted(planId, claimed, outcomes);
        }
        const outcome = await commitOperation(planId, operation, index, executor);
        outcomes.push(outcome);
        // A later operation would write on top of a change nobody can
        // confirm, so the plan stops here and the rest are skipped.
        if (outcome.status === "INDETERMINATE") {
          for (const skipped of claimed.operations.slice(index + 1)) {
            outcomes.push({
              capability: skipped.capability,
              status: "SKIPPED",
              detail: `not attempted: ${operation.capability} left an unknown result`,
              verification: { status: "UNSUPPORTED" },
            });
          }
          break;
        }
      }
      proposals.discardPlan(planId);
      if (session.expired()) {
        proposals.discardPlan(planId);
        return settleInterrupted(planId, claimed, outcomes);
      }

      // COMMITTED is a claim that the work happened. An operation that
      // never ran, or one a verifier disproved, does not earn it.
      const unknown = outcomes.filter(
        (outcome) => outcome.status === "INDETERMINATE",
      );
      const broken = outcomes.filter((outcome) => outcome.status === "FAILED");
      const skipped = outcomes.filter((outcome) => outcome.status === "SKIPPED");
      const mismatched = outcomes.filter(
        (outcome) => outcome.verification.status === "MISMATCH",
      );
      const status =
        unknown.length > 0
          ? "INDETERMINATE"
          : broken.length > 0
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
          status === "INDETERMINATE"
            ? "plan_indeterminate"
            : status === "FAILED"
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
      if (status === "INDETERMINATE") {
        return {
          ok: false,
          reason: `${unknown
            .map(
              (outcome) =>
                `${outcome.capability} (${outcome.detail ?? "no detail"})`,
            )
            .join("; ")}. The outcome is unknown, so do not retry: check the application, then reconcile ${unknown
            .map((outcome) => outcome.recordId)
            .join(", ")}.`,
          plan: settled,
        };
      }
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
        const state = receipts.get(receiptId)?.rollbackState;
        return {
          ok: false,
          reason:
            state === "ROLLED_BACK"
              ? `${receiptId} was already rolled back`
              : state === "INDETERMINATE"
                ? `rollback of ${receiptId} is indeterminate and will not be retried automatically, because a compensating action that failed after dispatch may already have changed the application`
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
        const restored = await proveRollback(
          routed,
          stored.input,
          stored.receipt.changes,
        );
        // The session ended while the undo was running, so nothing can be
        // written into it. The receipt must not claim an outcome the audit
        // cannot support, and the compensating action was already
        // dispatched, so unreconciled is the only honest state.
        if (session.expired()) {
          receipts.markIndeterminate(
            receiptId,
            now(),
            "the session ended while the compensating action was running",
          );
          return {
            ok: false,
            reason: `${receiptId} belongs to a session that ended while the undo was running, so it is unreconciled rather than rolled back`,
          };
        }
        // A rollback is recorded when it was proven, or when the capability
        // deliberately declared that the handler word is the evidence.
        // Anything else is an unreconciled receipt rather than a claim
        // nobody checked.
        if (restored.kind === "unreconciled") {
          receipts.markIndeterminate(receiptId, now(), restored.detail);
          audit.append({
            kind: "rollback_indeterminate",
            capability: stored.capability,
            receiptId,
            at: now(),
          });
          emit();
          return {
            ok: false,
            reason: `rollback of ${receiptId} is unreconciled: ${restored.detail}`,
          };
        }
        receipts.markRolledBack(receiptId, now(), restored.verification);
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
        const detail = err instanceof Error ? err.message : String(err);
        // Dispatched and then threw, so it may have written. Nothing the
        // runtime can observe settles that, so it does not guess.
        receipts.markIndeterminate(
          receiptId,
          now(),
          session.expired()
            ? `${detail} (the session ended while the undo was running)`
            : detail,
        );
        if (session.expired()) {
          return {
            ok: false,
            reason: `${receiptId} belongs to a session that ended while the undo was running, so it is unreconciled rather than retryable`,
          };
        }
        audit.append({
          kind: "rollback_indeterminate",
          capability: stored.capability,
          receiptId,
          at: now(),
        });
        emit();
        return {
          ok: false,
          reason: `rollback of ${receiptId} is indeterminate: the compensating action failed after dispatch, so whether it changed anything is unknown until someone reconciles it with reconcileRollback. Original failure: ${detail}`,
        };
      }
    },

    reconcileRollback(receiptId, outcome, by) {
      const stored = receipts.get(receiptId);
      if (!stored) {
        return { ok: false, reason: `unknown receipt: ${receiptId}` };
      }
      // Anything unrecognised must not fall through to `untouched`, which is
      // the value that makes the compensating action runnable again.
      if (outcome !== "compensated" && outcome !== "untouched") {
        return {
          ok: false,
          reason: `unknown reconciliation outcome: ${String(outcome)}. Pass "compensated" or "untouched"`,
        };
      }
      // Reconciling is a claim about what someone went and observed. The
      // ambient actor is usually the agent whose compensation failed, and
      // letting it clear its own indeterminate receipt is the one thing this
      // record exists to prevent. Same snapshot-parse-then-check path as an
      // approval or a review, so all three refuse an unrecordable identity
      // identically rather than each inventing its own rule.
      const owned = resolveHumanActor(
        by,
        "reconciling a rollback must name a human who checked the application; pass one to reconcileRollback rather than relying on the acting actor",
      );
      if (!owned.ok) {
        return { ok: false, reason: owned.reason };
      }
      const reconciler = owned.actor;
      if (!receipts.reconcile(receiptId, outcome, now(), reconciler)) {
        return {
          ok: false,
          reason: `${receiptId} is ${stored.rollbackState}, and only an indeterminate rollback can be reconciled`,
        };
      }
      audit.append({
        kind: "rollback_reconciled",
        capability: stored.capability,
        receiptId,
        outcome,
        actor: reconciler,
        at: now(),
      });
      emit();
      return { ok: true, receipt: receipts.get(receiptId)! };
    },
    grant() {
      return { ok: false, reason: "grants are not implemented" };
    },
    revokeGrant() {
      return { ok: false, reason: "grants are not implemented" };
    },
    listGrants() {
      return [];
    },
    getGrant() {
      return undefined;
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
        proposals.discard(actionId);
        approvals.resolve(actionId, {
          status: "FAILED",
          action,
          error: `unknown capability: ${action.capability}`,
          resolvedAt: now(),
        });
        return errorResult(`unknown capability: ${action.capability}`);
      }
      try {
      // Every refusal from here names the approval it refused as evidence.
      const claimed: Evidence[] = [{ kind: "approval", id: actionId }];
      // Policy is re-evaluated here, not just at request time: a rule that
      // started denying while the action sat pending must block it.
      const decision = policy({
        capability: routed,
        input: action.input,
        context,
      });
      if (decision.kind === "deny") {
        proposals.discard(actionId);
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
        return policyDenied(
          action.capability,
          decision.reason,
          refusal(routed, undefined, claimed),
        );
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
        proposals.discard(actionId);
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
        return capabilityUnavailable(
          action.capability,
          blocker,
          refusal(routed, blocker.repair, claimed),
        );
      }
      // The staged artifact is the only thing that may land for a staged
      // capability. Missing it is a fail-closed refusal, never a fallback
      // to running the handler outside the fork the human reviewed.
      const proposal = proposals.take(actionId);
      if (routed.stagedOperation && !proposal) {
        // The repair is the same request again, with the input the human
        // already saw, so a new proposal is staged for a new approval.
        const missing = unavailable(
          "STAGED_PROPOSAL_MISSING",
          `The staged change behind ${actionId} is no longer held by the runtime, so approving it would run a write nobody reviewed. Request the action again.`,
          { capability: routed.name, input: action.input },
        );
        approvals.resolve(actionId, {
          status: "FAILED_UNAVAILABLE",
          action,
          reasonCode: missing.reasonCode,
          reason: missing.reason,
          resolvedAt: now(),
        });
        audit.append({
          kind: "capability_unavailable",
          capability: action.capability,
          reasonCode: missing.reasonCode,
          at: now(),
        });
        emit();
        return capabilityUnavailable(
          action.capability,
          missing,
          refusal(routed, missing.repair, claimed),
        );
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
        ...(proposal ? { commit: proposal.commit } : {}),
      });
      // approvals.resolve inserts, so resolving after a reset put the cleared
      // action back into the fresh session. Nothing here belongs to it.
      if (session.expired()) {
        proposal?.discard();
        return executionCancelled(
          action.capability,
          refusal(routed, undefined, claimed),
        );
      }
      if (outcome.ok) {
        approvals.resolve(actionId, {
          status: "APPROVED_EXECUTED",
          action,
          result: outcome.value,
          resolvedAt: now(),
        });
      } else if (outcome.indeterminate) {
        // The artifact is deliberately not discarded. It is the evidence a
        // human reconciles against, and nothing here proves it did not land.
        unreconciled.attach(outcome.indeterminate.recordId, { actionId });
        approvals.resolve(actionId, {
          status: "INDETERMINATE",
          action,
          detail: outcome.indeterminate.detail,
          recordId: outcome.indeterminate.recordId,
          resolvedAt: now(),
        });
      } else {
        proposal?.discard();
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
        proposals.discard(actionId);
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
    listUnreconciled() {
      return unreconciled.list();
    },

    reconcile(target, resolution, by) {
      const authorizer = resolveHumanActor(
        by ?? actor,
        "reconciling a staged outcome must name a human; nobody else can go and find out what happened",
      );
      if (!authorizer.ok) {
        return { ok: false, reason: authorizer.reason };
      }
      if (!options.staging) {
        return { ok: false, reason: "no staging adapter is bound" };
      }
      const byAction = unreconciled.forAction(target);
      const found = unreconciled.open(byAction?.id ?? target);
      if (!found) {
        return { ok: false, reason: `nothing unreconciled for ${target}` };
      }
      // Checked before the adapter is touched. Settling an unknown write by
      // claiming a cleanup was disposed answers a question nobody asked and
      // then deletes the only record of the write.
      const parsed = parseResolution(found.record.kind, resolution);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      // Only the adapter can make the artifact terminal, and only a
      // successful return says it did. A throw leaves the record and its
      // evidence exactly where they were.
      try {
        // The artifact came from this adapter's own `fork`, so handing it
        // back is the one place the erased type is reconstituted.
        (options.staging as StagingAdapter<unknown>).reconcile(
          found.artifact,
          parsed.resolution,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        audit.append({
          kind: "staged_reconcile_failed",
          capability: found.record.capability,
          recordId: found.record.id,
          detail,
          at: now(),
        });
        emit();
        return {
          ok: false,
          reason: `${found.record.id} could not be settled: ${detail}`,
        };
      }
      unreconciled.settle(found.record.id);
      audit.append({
        kind: "staged_reconciled",
        capability: found.record.capability,
        recordId: found.record.id,
        resolution: parsed.resolution.kind,
        actor: authorizer.actor,
        at: now(),
      });
      emit();
      return { ok: true };
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
      proposals.discard(actionId);
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
