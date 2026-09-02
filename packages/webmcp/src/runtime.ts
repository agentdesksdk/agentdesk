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
  type AgentView,
  type AppContext,
  type Capability,
  type CapabilityName,
  type Change,
  type ExecutionContext,
  type RiskLevel,
} from "./capability.ts";
import { CapabilityCatalog } from "./catalog.ts";
import {
  catalogHierarchy,
  rankWithin,
  viewOf,
  type CatalogDomain,
  type CatalogHierarchy,
} from "./hierarchy.ts";
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
import {
  GrantStore,
  parseGrantRequest,
  type ConsideredGrant,
  type Grant,
  type GrantRequest,
  type LiveGrant,
} from "./grants.ts";
import { defaultValidator, type Validator } from "./validation.ts";
import {
  PresentationBus,
  resolvePresentation,
  type FocusPolicy,
  type PresentationEvent,
  type PresentationListener,
  type PresentationPhase,
} from "./presentation.ts";

/**
 * A reveal target is an opaque id the application registered on one of its
 * own elements. Constraining the token here is what keeps a selector out
 * of a replayed reveal, whatever a page passes.
 */
const REVEAL_TOKEN = /^[a-z0-9][a-z0-9-]*$/i;
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
import type { EvidenceLink, Receipt } from "./results.ts";
import {
  sealOf,
  verifyRecord,
  type PersistedArtifact,
  type PersistedRecord,
  type PersistenceAdapter,
} from "./persistence.ts";
import {
  GestureStore,
  isApprovalGesture,
  type ApprovalGesture,
  type GestureBinding,
} from "./gesture.ts";
import {
  ReceiptStore,
  type ReceiptQuery,
  type ReconciliationOutcome,
  type StoredReceipt,
} from "./receipts.ts";
import {
  compareNames,
  DEFAULT_ROUTED,
  isRouteError,
  rankCapabilities,
  routeCapability,
  type RankedCapability,
} from "./router.ts";
import {
  approvalRequired,
  approvalStale,
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
  viewUnavailable,
  type ToolResult,
} from "./results.ts";
import {
  buildStageHandler,
  isThenable,
  parseResolution,
  StagedCommitIndeterminate,
  StagedProposalStore,
  stateDigest,
  UnreconciledStore,
  type StagedProposal,
  type StagedResolution,
  type StagingAdapter,
  type Unreconciled,
} from "./staging.ts";
import { ToolSurfaceManager } from "./tool-surface.ts";
import type { CapabilityProvider } from "./provider.ts";
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

/**
 * What a page may ask the runtime to present: the navigate and reveal
 * shape the runtime already emits for a completed write, without the
 * fields only an execution can supply.
 */
export type PresentationRequest = {
  capability: string;
  route?: string;
  reveal?: string;
  message?: string;
  focus?: FocusPolicy;
};

export type RoutingReport = {
  query: string;
  /** The domain or `domain/subdomain` the call narrowed to, when it did. */
  domain?: string;
  /** The catalog tree a first-level call returned, for an inspector to show. */
  domains?: CatalogDomain[];
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
   * Replays a presentation event on demand, so a page can navigate to and
   * reveal an evidence link through the same consumer the runtime drives.
   * A presentation event, not an execution: it changes no state, needs no
   * actor beyond the page, is not reachable through any WebMCP tool, and
   * never enters a result.
   */
  present: (event: PresentationRequest) => void;
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
  approve: (actionId: string, by?: Actor | ApprovalGesture) => Promise<ToolResult>;
  reject: (actionId: string, by?: Actor) => ToolResult;
  /**
   * Mints a single-use token on a human click. Called by page code from
   * its click handler and handed to `approve` or `approvePlan` in place of
   * an asserted identity. The issuer must be a human; an agent cannot mint
   * one, and the runtime throws where it throws for any non-human issuer.
   */
  issueApprovalGesture: (binding: GestureBinding, by?: Actor) => ApprovalGesture;

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
    by?: Actor | ApprovalGesture,
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
  /**
   * Where the capabilities come from and how they are published. Replaces
   * `capabilities`, `registerTool`, and `adapter`, which the native
   * provider wraps; passing both is refused.
   */
  provider?: CapabilityProvider;
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
  /**
   * The projection of application state the agent may see. Applied by the
   * runtime to everything that crosses to the agent: tool results, the
   * routing report, approval previews, receipts on results, get_context.
   * The human-facing snapshot and audit are not projected. A capability's
   * own `agentView` narrows this further and never widens it.
   */
  agentView?: AgentView;
  /**
   * Whether an approval must carry a gesture token. `optional` accepts an
   * asserted human identity as before, so existing callers keep working
   * while page code migrates to minting tokens; `required` refuses an
   * approval that does not carry a valid token.
   */
  approvalGesture?: "optional" | "required";
  /**
   * How the runtime knows a user activation is in progress when a token is
   * minted. Defaults to `navigator.userActivation.isActive`, and refuses
   * when there is no navigator; Node and jsdom tests inject one.
   */
  gesture?: { userActivation?: () => boolean };
  /**
   * Where unreconciled records and idempotency claims survive a restart.
   * Absent means in memory, which is exactly what the runtime did before.
   */
  persistence?: PersistenceAdapter;
}): AgentDeskRuntime {
  const audit = new AuditBus();
  const approvals = new ApprovalManager();
  const presentation = new PresentationBus();
  const plans = new PlanStore();
  const receipts = new ReceiptStore();
  // Bounded mandates a person issued. Consulted only where policy would ask
  // for an approval, so a grant can narrow what needs a human and never
  // widen what policy allows.
  const grants = new GrantStore();
  // Tokens minted on a human click and consumed at approve time. A token
  // stands for a gesture the runtime can verify, where an asserted
  // identity was a claim it had to take on trust.
  const gestures = new GestureStore();
  const gestureMode: "optional" | "required" = options.approvalGesture ?? "optional";
  /**
   * Whether a person is interacting right now. A token minted outside a
   * user activation proves nothing a plain identity did not, so minting
   * asks this first. The default reads the browser's own answer and says
   * no wherever there is none; a seam that throws counts as no.
   */
  const userActivation: () => boolean = options.gesture?.userActivation ?? (() => {
    const host = globalThis as { navigator?: { userActivation?: { isActive?: unknown } } };
    return host.navigator?.userActivation?.isActive === true;
  });
  /**
   * Flagged reads, in order. Each approval remembers the tick it was
   * requested at, and at approve time only the reads after that tick count,
   * so a note read this morning does not mark an approval requested this
   * afternoon, and two pending approvals each answer for their own window.
   */
  let untrustedTick = 0;
  const untrustedReads: Array<{ name: string; tick: number }> = [];
  const requestedAtTick = new Map<string, number>();
  const UNTRUSTED_READS_LIMIT = 200;

  function untrustedSince(key: string): string[] {
    const since = requestedAtTick.get(key) ?? Number.POSITIVE_INFINITY;
    const names = new Set<string>();
    for (const read of untrustedReads) {
      if (read.tick > since) {
        names.add(read.name);
      }
    }
    return [...names].sort(compareNames);
  }
  // Staged proposals live here, keyed by the runtime identity that owns
  // each one, never by business input. Disposal is this store's job on
  // every path that resolves an owner without committing it.
  const proposals = new StagedProposalStore();
  // Staged outcomes nobody can call settled: a commit that threw after it may
  // have written, and a disposal that failed and left the artifact open.
  const unreconciled = new UnreconciledStore();
  /**
   * Where records and claims outlive this process. Absent means in memory
   * and nothing below runs, so a runtime that declares none is what it was.
   * Saves are queued in order and never awaited by the path that made the
   * record: a persistence adapter that throws cannot change an outcome,
   * only lose its own copy, and says so on the console.
   */
  const persistence: PersistenceAdapter | undefined = options.persistence;
  let persisting: Promise<void> = Promise.resolve();
  let persistsInFlight = 0;
  function persist(work: () => void | Promise<void>): void {
    if (persistence === undefined) {
      return;
    }
    // Started at once when nothing is in flight, so a synchronous adapter
    // has taken effect by the time the caller returns, and chained behind
    // an asynchronous one still running, so saves land in order.
    const start = (): Promise<void> => {
      persistsInFlight += 1;
      let settled: Promise<void>;
      try {
        settled = Promise.resolve(work()).then(() => undefined);
      } catch (err) {
        settled = Promise.reject(err);
      }
      return settled
        .catch((err) => {
          console.error("agentdesk persistence adapter threw", err);
        })
        .finally(() => {
          persistsInFlight -= 1;
        });
    };
    persisting = persistsInFlight === 0 ? start() : persisting.then(start);
  }
  /**
   * A loaded artifact that is not the live object: the persisted
   * description, kept until `reconcile` asks the adapter to rebuild it.
   */
  const PERSISTED = Symbol.for("agentdesk.persisted-artifact");
  type PersistedHolder = { [PERSISTED]: PersistedRecord };
  function isPersistedHolder(value: unknown): value is PersistedHolder {
    return typeof value === "object" && value !== null && PERSISTED in value;
  }
  /**
   * Idempotency keys claimed before a restart, by slot: the input they were
   * claimed for, and the receipt the write recorded when it recorded one.
   * The result is gone; the receipt is what a refusal can point at.
   */
  const restoredClaims = new Map<string, { fingerprint: string; receiptId?: string }>();

  /**
   * How an artifact is written down. The object itself when it clones; the
   * staging adapter's durable key when it does not; `lost` when it has
   * neither. A lost artifact still surfaces and still guards, and only a
   * resolver that can rebuild from the record alone can close it.
   */
  function describeArtifact(artifact: unknown): PersistedArtifact {
    try {
      return { kind: "value", value: structuredClone(artifact) };
    } catch {
      const identify = (options.staging as StagingAdapter<unknown> | undefined)?.identify;
      if (identify !== undefined) {
        try {
          return { kind: "reference", reference: structuredClone(identify(artifact)) };
        } catch {
          return { kind: "lost" };
        }
      }
      return { kind: "lost" };
    }
  }

  /** Writes an open record down, with everything the runtime knows about it. */
  function persistOpen(id: string): void {
    if (persistence === undefined) {
      return;
    }
    const found = unreconciled.open(id);
    if (found === undefined) {
      return;
    }
    const artifact = isPersistedHolder(found.artifact)
      ? found.artifact[PERSISTED].artifact
      : describeArtifact(found.artifact);
    // The live record's own field order is kept, so the record that comes
    // back serializes byte for byte as the one listed before the restart.
    const unsealed: Omit<PersistedRecord, "seal"> = {
      version: 1,
      ...found.record,
      changes: [...found.record.changes],
      artifact,
    };
    const record: PersistedRecord = { ...unsealed, seal: sealOf(unsealed) };
    persist(() => persistence.saveRecord(record));
  }

  /**
   * Puts back what the adapter kept. A record that fails verification is
   * refused and audited rather than trusted; a claim is remembered by slot
   * so the same key is refused rather than replayed.
   */
  async function rehydrate(): Promise<void> {
    if (persistence === undefined) {
      return;
    }
    const loaded = await persistence.loadOpenRecords();
    for (const candidate of loaded) {
      const verified = verifyRecord(candidate);
      if (!verified.ok) {
        const id =
          typeof candidate === "object" && candidate !== null && "id" in candidate
            ? String((candidate as { id: unknown }).id)
            : "unknown";
        audit.append({
          kind: "staged_reconcile_failed",
          capability:
            typeof candidate === "object" && candidate !== null && "capability" in candidate
              ? String((candidate as { capability: unknown }).capability)
              : "unknown",
          recordId: id,
          detail: `refused at load: ${verified.reason}`,
          at: now(),
        });
        continue;
      }
      const { version: _version, seal: _seal, artifact, ...fields } = verified.record;
      const record: Unreconciled = { ...fields, changes: [...fields.changes] };
      const holder: unknown =
        artifact.kind === "value" ? artifact.value : { [PERSISTED]: verified.record };
      unreconciled.hydrate(record, holder);
    }
    for (const claim of await persistence.loadIdempotencyClaims()) {
      if (claim.version === 1 && typeof claim.slot === "string") {
        restoredClaims.set(claim.slot, {
          fingerprint: claim.fingerprint,
          ...(typeof claim.receiptId === "string" ? { receiptId: claim.receiptId } : {}),
        });
      }
    }
  }
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

  /**
   * The identity that mints or revokes authority. It goes through the same
   * parse as the ambient actor and throws the same `TypeError` on a
   * malformed shape, and throws again when the parsed actor is not a
   * person. An agent asking for a mandate is not a caller to hand a reason
   * to; it is the thing a grant exists to keep from happening.
   */
  function adoptHumanActor(next: Actor | undefined, refusal: string): HumanActor {
    const adopted = adoptActor(next);
    if (adopted === undefined || !isHumanActor(adopted)) {
      throw new TypeError(refusal);
    }
    return adopted;
  }

  /**
   * Who is approving, and how the runtime knows. A gesture token is
   * verified and consumed here and yields the human who minted it; an
   * asserted identity is parsed as before, or refused outright when the
   * runtime requires a gesture. This is the seam a WebAuthn assertion
   * plugs into: a second gesture kind, a second verifier, the same callers.
   */
  function resolveApprover(
    supplied: Actor | ApprovalGesture | undefined,
    binding: GestureBinding,
    refusal: string,
  ):
    | { ok: true; actor: HumanActor; gestureId?: string }
    | { ok: false; reason: string } {
    if (isApprovalGesture(supplied)) {
      const verdict = gestures.consume(supplied, binding, now());
      if (!verdict.ok) {
        return verdict;
      }
      return { ok: true, actor: deepFreeze(verdict.by), gestureId: verdict.id };
    }
    if (gestureMode === "required") {
      return {
        ok: false,
        reason:
          "an approval must carry a token issued on a human click through issueApprovalGesture; an asserted identity is not accepted by this runtime",
      };
    }
    return resolveHumanActor(supplied, refusal);
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
  // The catalog is fixed for the life of the runtime, so its tree is
  // tokenized once; each call pays only the routable filter and a count.
  let hierarchy: CatalogHierarchy<Capability> | undefined;
  const tree = (): CatalogHierarchy<Capability> => {
    hierarchy ??= catalogHierarchy(catalog.all().filter(appOnly));
    return hierarchy;
  };
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
   * Keys claimed at an approval request, by action id, so the execution
   * the approval releases settles the same claim and records its receipt,
   * and a rejection settles it with the rejection.
   */
  const approvalClaims = new Map<string, Extract<IdempotencyClaim, { kind: "won" }>>();

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
      crossing(
        toolRetired(
          name,
          refusal(catalog.get(name), { capability: FIND_CAPABILITIES }),
        ),
        catalog.get(name),
        name,
        actor,
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
    // A capability a person has already granted authority over is a live
    // option whatever the graph says, so a refusal can point at it.
    for (const name of grants.liveCapabilities(now())) {
      names.add(name);
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

  /**
   * The agent view, applied on the runtime's side of the boundary.
   *
   * The runtime's view runs first and the capability's second, on what the
   * runtime's let through, so a capability can only narrow it. It is applied
   * to every plain record at every depth of a value that crosses, and to
   * every element of an array, so a handler that nests state does not slip
   * it past a view written for the root. That is also why a view has to be
   * a subtraction over whatever it is handed: the runtime hands it every
   * record that crosses, not only the root state, and a view that keeps a
   * fixed set of keys would empty a handler's result.
   *
   * A throwing view is a refusal, never the raw value. The throw is wrapped
   * so the paths that catch it can tell it from the application's own
   * errors and answer VIEW_UNAVAILABLE.
   */
  class AgentViewFailed extends Error {
    constructor(cause: unknown) {
      super(
        `the agent view projection threw: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      this.name = "AgentViewFailed";
    }
  }

  const runtimeView: AgentView | undefined = options.agentView;

  function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function throughView(
    value: unknown,
    capability: Capability | undefined,
    viewer: Actor | undefined,
  ): unknown {
    // The runtime's view is the outer bound: it runs before the capability's,
    // so the capability's sees only what it let through, and again after, so
    // a capability's view that puts a key back does not get it across.
    const views: AgentView[] = [];
    if (runtimeView !== undefined) {
      views.push(runtimeView);
    }
    if (capability?.agentView !== undefined) {
      views.push(capability.agentView);
      if (runtimeView !== undefined) {
        views.push(runtimeView);
      }
    }
    if (views.length === 0) {
      return value;
    }
    const project = (node: unknown): unknown => {
      if (Array.isArray(node)) {
        return node.map(project);
      }
      if (!isPlainRecord(node)) {
        return node;
      }
      let seen: Record<string, unknown> = node;
      for (const view of views) {
        let next: unknown;
        try {
          next = view({ state: seen, ...(viewer !== undefined ? { actor: viewer } : {}) });
        } catch (err) {
          throw new AgentViewFailed(err);
        }
        if (!isPlainRecord(next)) {
          throw new AgentViewFailed(
            new Error("the view returned something other than a plain object"),
          );
        }
        seen = next;
      }
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(seen)) {
        out[key] = project(nested);
      }
      return out;
    };
    return project(value);
  }

  /**
   * A change crosses only if the field it names would cross. Each change is
   * rebuilt as the one-field state it describes and passed through the
   * view; a field the view removes takes its change with it, before and
   * after, so a preview or a receipt cannot name a value the state view
   * hides.
   */
  function changesThroughView(
    changes: readonly Change[],
    capability: Capability | undefined,
    viewer: Actor | undefined,
  ): Change[] {
    const kept: Change[] = [];
    for (const change of changes) {
      const before = throughView({ [change.field]: change.before }, capability, viewer);
      if (!isPlainRecord(before) || !(change.field in before)) {
        continue;
      }
      const after = throughView({ [change.field]: change.after }, capability, viewer);
      kept.push({
        ...change,
        before: before[change.field],
        after: isPlainRecord(after) ? after[change.field] : undefined,
      });
    }
    return kept;
  }

  /**
   * Exception text crossing to the agent. An exception message is written
   * by whoever threw, and it can carry a field the view excludes, so when a
   * view is declared the text stays on the human side and the agent gets
   * the fact and the execution to ask about. With no view declared the
   * runtime is what it was.
   */
  function agentText(text: string): string {
    return runtimeView === undefined
      ? text
      : "The error text is withheld from the agent view; a person can read it in the audit record.";
  }

  /**
   * The values the view hides, by example. The current state is projected
   * and every string that was in it and is not in what came back is a
   * hidden value. A key view cannot see a handler that copies a hidden
   * value under another name or writes it into a sentence, so on the way
   * out every result is checked for these values, in any key and in any
   * text, and each occurrence is withheld. This is what makes "never
   * appears" true rather than "not under that key".
   *
   * Only strings are matched. A hidden number or boolean is too short and
   * too common to withhold by value without withholding the rest of the
   * result, so a secret has to be a string to get this protection.
   */
  function hiddenStrings(
    capability: Capability | undefined,
    viewer: Actor | undefined,
  ): string[] {
    const shown = throughView(context.state, capability, viewer);
    const visible = new Set<string>();
    collectStrings(shown, visible);
    const raw = new Set<string>();
    collectStrings(context.state, raw);
    return [...raw]
      .filter((text) => text.length > 0 && !visible.has(text))
      .sort((a, b) => b.length - a.length);
  }

  function collectStrings(value: unknown, into: Set<string>): void {
    if (typeof value === "string") {
      into.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        collectStrings(item, into);
      }
    } else if (isPlainRecord(value)) {
      for (const item of Object.values(value)) {
        collectStrings(item, into);
      }
    }
  }

  const WITHHELD = "[withheld]";

  /**
   * Below this length a hidden value is protected structurally and by
   * whole value, not inside free text. A shorter value is too common a
   * substring: a hidden "US" would tear STATUS and "USB-C Dock", a hidden
   * "ok" would mangle "token". An author who needs a short value protected
   * inside sentences must not write it into sentences.
   */
  const IN_TEXT_MIN_LENGTH = 8;

  /**
   * Two tiers. Every hidden string is withheld by whole-value equality, at
   * any depth under any key, which keeps the re-label case closed for a
   * value of any length. Inside free text only a hidden string of at least
   * `IN_TEXT_MIN_LENGTH` characters is matched, longest first.
   */
  function withhold(value: unknown, hidden: readonly string[]): unknown {
    if (typeof value === "string") {
      if (hidden.includes(value)) {
        return WITHHELD;
      }
      let text = value;
      for (const secret of hidden) {
        if (secret.length >= IN_TEXT_MIN_LENGTH && text.includes(secret)) {
          text = text.split(secret).join(WITHHELD);
        }
      }
      return text;
    }
    if (Array.isArray(value)) {
      return value.map((item) => withhold(item, hidden));
    }
    if (isPlainRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = withhold(item, hidden);
      }
      return out;
    }
    return value;
  }

  /**
   * The one seam every result crosses on its way to the agent. A result
   * that is already a failed view carries nothing projected and passes as
   * is; anything else is checked for hidden values. A view that throws
   * here refuses the whole result, saying whether the write completed so
   * the agent does not retry it.
   */
  function crossing(
    result: ToolResult,
    capability: Capability | undefined,
    name: string,
    viewer: Actor | undefined,
  ): ToolResult {
    if (
      (runtimeView === undefined && capability?.agentView === undefined) ||
      result.code === "VIEW_UNAVAILABLE"
    ) {
      return result;
    }
    let hidden: string[];
    try {
      hidden = hiddenStrings(capability, viewer);
    } catch (err) {
      if (err instanceof AgentViewFailed) {
        return viewFailed(capability, name, result.data?.status === "COMPLETED");
      }
      throw err;
    }
    if (hidden.length === 0) {
      return result;
    }
    return {
      ...result,
      content: result.content.map((item) => ({
        ...item,
        text: withhold(item.text, hidden) as string,
      })),
      ...(result.data !== undefined
        ? { data: withhold(result.data, hidden) as Record<string, unknown> }
        : {}),
    };
  }

  /**
   * Where the proof of a write can be seen when the author did not say. A
   * capability's `presentation.route` and `reveal` already name the page
   * and the anchor the demo navigates to for the write, so they are the
   * derivation, with the receipt's entity as the label. Nothing is guessed
   * from the entity text or the field names: a capability with no route
   * declared has no derived link, and its receipt says so with an empty
   * list rather than a link that goes nowhere.
   */
  function deriveEvidence(
    capability: Capability,
    input: Record<string, unknown>,
    entity: string,
  ): EvidenceLink[] {
    const spec = capability.presentation;
    if (spec?.route === undefined) {
      return [];
    }
    let route: string | undefined;
    try {
      route = spec.route(input, context);
    } catch {
      return [];
    }
    if (typeof route !== "string" || !route.startsWith("/")) {
      return [];
    }
    return [
      {
        label: entity,
        route,
        ...(spec.reveal !== undefined ? { reveal: spec.reveal } : {}),
        source: "derived",
      },
    ];
  }

  /**
   * Stamps the source on what an author wrote. The runtime sets it and
   * nothing the author put there survives, so `source` always says who
   * knew where the proof lives.
   */
  function authored(links: readonly EvidenceLink[]): EvidenceLink[] {
    return links.map((link) => ({
      label: link.label,
      route: link.route,
      ...(link.reveal !== undefined ? { reveal: link.reveal } : {}),
      source: "authored",
    }));
  }

  /**
   * A link crosses only if nothing it names is hidden. Its `reveal` is
   * treated as a field name and passed through the view like a change; its
   * route is checked segment by segment against the hidden values and then
   * through the same two tiers as any text; its label too. A link with a
   * hole in it navigates nowhere, so it is dropped rather than withheld.
   */
  function linksThroughView(
    links: readonly EvidenceLink[],
    capability: Capability | undefined,
    viewer: Actor | undefined,
  ): EvidenceLink[] {
    if (runtimeView === undefined && capability?.agentView === undefined) {
      return links.map((link) => ({ ...link }));
    }
    const hidden = hiddenStrings(capability, viewer);
    const kept: EvidenceLink[] = [];
    for (const link of links) {
      if (link.reveal !== undefined) {
        const probe = throughView({ [link.reveal]: true }, capability, viewer);
        if (!isPlainRecord(probe) || !(link.reveal in probe)) {
          continue;
        }
      }
      if (link.route.split("/").some((segment) => hidden.includes(segment))) {
        continue;
      }
      if (
        withhold(link.route, hidden) !== link.route ||
        withhold(link.label, hidden) !== link.label
      ) {
        continue;
      }
      kept.push({ ...link });
    }
    return kept;
  }

  /** Records a failed view and builds the refusal that stands in for the value. */
  function viewFailed(
    capability: Capability | undefined,
    name: string,
    completed: boolean,
    evidence: readonly Evidence[] = [],
  ): ToolResult {
    audit.append({
      kind: "capability_unavailable",
      capability: name,
      reasonCode: "AGENT_VIEW_FAILED",
      at: now(),
    });
    emit();
    return viewUnavailable(name, completed, refusal(capability, undefined, evidence));
  }

  /** The audit record of a grant that was considered and did not apply. */
  function notApplied(
    capability: string,
    considered: ConsideredGrant,
  ): Extract<AuditEvent, { kind: "grant_not_applied" }> {
    return {
      kind: "grant_not_applied",
      grantId: considered.id,
      capability,
      outcome: considered.outcome,
      ...("field" in considered ? { field: considered.field } : {}),
      at: now(),
    };
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
      grants: grants.list(now()),
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

  /**
   * Every invocation leaves through `crossing`, so no path inside can hand
   * the agent a value the view hides. The acting identity is resolved once
   * here and handed down, for the invocation and for the view.
   */
  async function runCapability(
    capability: Capability,
    input: Record<string, unknown>,
    via: "native" | "invoke",
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<ToolResult> {
    const invocationActor = actor;
    const result = await runInvocation(
      capability,
      input,
      via,
      invocationActor,
      signal,
      idempotencyKey,
    );
    return crossing(
      result,
      BUILTIN_NAMES.has(capability.name) ? undefined : capability,
      capability.name,
      invocationActor,
    );
  }

  async function runInvocation(
    capability: Capability,
    input: Record<string, unknown>,
    via: "native" | "invoke",
    invocationActor: Actor | undefined,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<ToolResult> {

    if (capability.name === FIND_CAPABILITIES) {
      const raw = readString(input, "query") ?? readString(input, "task") ?? "";
      const domain = readString(input, "domain");
      // Bound what enters routing, lastRouting, and the audit log.
      const report = await findCapabilities(
        raw.slice(0, 400),
        domain === undefined ? undefined : domain.slice(0, 120),
      );
      try {
        return toToolResult(throughView(report, undefined, invocationActor));
      } catch (err) {
        if (err instanceof AgentViewFailed) {
          return viewFailed(undefined, FIND_CAPABILITIES, false);
        }
        throw err;
      }
    }
    if (capability.name === INVOKE_CAPABILITY) {
      return dispatchInvoke(input);
    }
    if (capability.name === GET_CONTEXT) {
      try {
        return toToolResult(throughView(contextPayload(), undefined, invocationActor));
      } catch (err) {
        if (err instanceof AgentViewFailed) {
          return viewFailed(undefined, GET_CONTEXT, false);
        }
        throw err;
      }
    }
    if (capability.name === GET_ACTION_STATUS) {
      try {
        return actionStatus(input, invocationActor);
      } catch (err) {
        if (err instanceof AgentViewFailed) {
          return viewFailed(undefined, GET_ACTION_STATUS, false);
        }
        throw err;
      }
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
        availability.reasonCode === "AVAILABILITY_CHECK_FAILED"
          ? { reasonCode: availability.reasonCode, reason: agentText(availability.reason) }
          : availability,
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

    // A previous call of this exact operation may already have written. A
    // repeat would apply it twice, so it is refused until a human has said
    // what happened, on every path: the approval path was reachable around
    // this guard, so a repeat after a restart was asked for approval again
    // and, once approved, executed a second time with the record still open.
    const unresolved = unreconciled.forOperation(
      operationKey(capability.name, input),
    );
    if (unresolved) {
      emit();
      return executionIndeterminate(
        capability.name,
        unresolved.id,
        agentText(unresolved.detail),
        changesThroughView(unresolved.changes, capability, invocationActor),
        settled(capability, [{ kind: "record", id: unresolved.id }]),
      );
    }

    present(capability, "capability_started", input, invocationActor);
    // A grant is consulted only where policy would ask for an approval. It
    // sits after policy, so a denial is final before any mandate is read,
    // and before the approval gate, so a matching live grant is what stands
    // in for the person this once. A grant that does not apply changes
    // nothing: the call takes the path it always had, an approval with a
    // person deciding, and the result says which grant was considered and
    // what it stopped at. Refusing here would let a mandate for one
    // customer make another customer's refund un-approvable.
    let authorizing: LiveGrant | undefined;
    let considered: ConsideredGrant | undefined;
    if (decision.kind === "require_approval") {
      const consulted = grants.consult(capability.name, input, now());
      if (consulted.kind === "matched") {
        authorizing = consulted.grant;
      } else if (consulted.kind === "not_applied") {
        considered = consulted.grant;
        audit.append(notApplied(capability.name, considered));
      }
    }
    if (decision.kind === "require_approval" && authorizing === undefined) {
      // The key is claimed here, at the request, not at the execution the
      // approval releases later. A repeat with the same key while the
      // action is pending replays the same approval rather than opening a
      // second one; a claim that survives a restart refuses the repeat
      // before any approval is asked. The claim settles with the approval
      // result now and is settled again with the outcome when a person
      // decides, so a later repeat replays what actually happened.
      const claim = claimIdempotency(capability, input, idempotencyKey);
      if (claim.kind === "refused") {
        return claim.result;
      }
      if (claim.kind === "replay") {
        return await claim.result;
      }
      const queued = queueApproval(capability, input, signal, invocationActor, considered);
      const asked = isThenable(queued) ? await (queued as Promise<ToolResult>) : (queued as ToolResult);
      if (claim.kind === "won") {
        claim.settle(asked);
        const actionId = asked.code === "APPROVAL_REQUIRED" ? asked.data?.approval_id : undefined;
        if (typeof actionId === "string") {
          approvalClaims.set(actionId, claim);
        }
      }
      return asked;
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
    const forked = stageFor(capability, input, signal);
    const direct = isThenable(forked)
      ? await (forked as Promise<StageOutcome>)
      : (forked as StageOutcome);
    if (!direct.ok) {
      audit.append({
        kind: "capability_unavailable",
        capability: capability.name,
        reasonCode: "PREVIEW_UNAVAILABLE",
        at: now(),
      });
      emit();
      return settle(
        previewUnavailable(capability.name, agentText(direct.error), refusal(capability)),
      );
    }
    // The use is spent here, synchronously, at the moment the runtime
    // commits to executing and before its first await. A concurrent second
    // call runs its own consult only after this one has suspended, so it
    // sees the decremented count and cannot double-spend the last use. A
    // replay above returned before reaching this line, so an idempotent
    // retry spends nothing. A use once spent is never returned: the
    // handler may already be running, and a mandate counts dispatches.
    let grantId: string | undefined;
    if (authorizing !== undefined) {
      const spent = grants.spend(authorizing.id, now());
      if (spent === undefined) {
        // Re-entrant code revoked or exhausted the grant between the
        // consult and this claim. The mandate no longer applies, so the
        // call takes the approval path with the grant it was checked
        // against, and the idempotency slot settles on that result.
        direct.proposal?.discard();
        const consulted = grants.consult(capability.name, input, now());
        const late: ConsideredGrant =
          consulted.kind === "not_applied"
            ? consulted.grant
            : { id: authorizing.id, outcome: "revoked" };
        audit.append(notApplied(capability.name, late));
        const queued = queueApproval(capability, input, signal, invocationActor, late);
        return settle(
          isThenable(queued) ? await (queued as Promise<ToolResult>) : (queued as ToolResult),
        );
      }
      audit.append({
        kind: "grant_applied",
        grantId: spent.id,
        capability: capability.name,
        remaining: spent.remaining,
        at: now(),
      });
      grantId = authorizing.id;
    }
    const outcome = await executeNow(capability, input, {
      actor: invocationActor,
      signal,
      idempotencyKey,
      claim,
      ...(grantId !== undefined ? { grantId } : {}),
      ...(direct.proposal ? { commit: direct.proposal.commit } : {}),
    });
    if (!outcome.ok) {
      direct.proposal?.discard();
    }
    return outcome.result;
  }

  /**
   * The approval gate. Stages a preview, records the pending action, and
   * hands the agent an APPROVAL_REQUIRED naming it. `considered` is the
   * grant the call was checked against and why it did not apply, so the
   * person deciding can see what the mandate stopped at.
   */
  function queueApproval(
    capability: Capability,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    invocationActor: Actor | undefined,
    considered: ConsideredGrant | undefined,
  ): ToolResult | Promise<ToolResult> {
    const summary =
      capability.describeApproval?.(input, context) ??
      capability.title ??
      capability.name;
    // The idempotency slot was claimed before this, so a repeat under the
    // same key while the fork is in flight joins this request's result
    // rather than forking again. A fork that answers now is recorded now,
    // with no tick in between, so a synchronous adapter's timing is what it
    // always was.
    const forked = stageFor(capability, input, signal);
    return isThenable(forked)
      ? (forked as Promise<StageOutcome>).then(finish)
      : finish(forked as StageOutcome);

    function finish(staged: StageOutcome): ToolResult {
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
          agentText(staged.error),
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
          agentText(preview.error),
          refusal(capability),
        );
      }
      // The agent's copy of the preview is projected before anything is
      // queued, so a failed view queues nothing and shows nothing. The person
      // approving still sees the whole preview on the pending action.
      let shown: Change[];
      try {
        shown = changesThroughView(preview.changes, capability, invocationActor);
      } catch (err) {
        if (err instanceof AgentViewFailed) {
          staged.proposal?.discard();
          return viewFailed(capability, capability.name, false);
        }
        throw err;
      }
      // The digest is computed here, by the runtime, from the preview the
      // adapter or the author just derived, and only where there was a preview
      // to derive it from. A summary-only approval has no state to bind to.
      const stateVersion = hasPreviewSource(capability, staged.proposal)
        ? stateDigest(preview.changes)
        : undefined;
      let action;
      try {
        action = approvals.request(
          capability.name,
          input,
          capability.risk,
          summary,
          preview.changes,
          now(),
          stateVersion,
          considered,
        );
      } catch (err) {
        // Nothing owns the proposal yet, so a failure to record the pending
        // action would otherwise strand the fork with no way to reach it.
        staged.proposal?.discard();
        throw err;
      }
      // The window this approval answers for opens here. An identical pending
      // request keeps its original window rather than moving it later.
      if (!requestedAtTick.has(action.id)) {
        requestedAtTick.set(action.id, untrustedTick);
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
        shown,
        capability.approvalEvidence,
        settled(capability, [{ kind: "approval", id: action.id }]),
        considered,
        action.stateVersion,
      );
    }
  }

  /** Whether a preview was derived at all, so a digest means something. */
  function hasPreviewSource(
    capability: Capability,
    proposal: StagedProposal | undefined,
  ): boolean {
    return proposal !== undefined || capability.previewChanges !== undefined;
  }

  /**
   * The digest of current state, derived the same way the preview was: a
   * fresh fork for a staged capability, the author's preview callback for a
   * direct one, then `stateDigest` over what came back. The probe fork is
   * released at once; only the reviewed artifact ever lands. A probe that
   * cannot be derived yields no digest, which the caller treats as moved,
   * because a state that cannot be read back is not one anyone approved.
   */
  function currentDigest(
    capability: Capability,
    input: Record<string, unknown>,
  ): string | undefined | Promise<string | undefined> {
    if (capability.stagedOperation !== undefined) {
      const digestOfProbe = (probe: StageOutcome): string | undefined => {
        if (!probe.ok || probe.proposal === undefined) {
          return undefined;
        }
        try {
          return stateDigest(probe.proposal.changes);
        } finally {
          probe.proposal.discard();
        }
      };
      const probe = stageFor(capability, input);
      // A probe over a store that reads later answers later; the caller
      // awaits it, and a sync adapter's caller still gets a value now.
      return isThenable(probe)
        ? (probe as Promise<StageOutcome>).then(digestOfProbe)
        : digestOfProbe(probe as StageOutcome);
    }
    const preview = safePreview(capability, input, context);
    return preview.ok ? stateDigest(preview.changes) : undefined;
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

  type StageOutcome =
    | { ok: true; proposal?: StagedProposal }
    | { ok: false; error: string };

  function stageFor(
    capability: Capability,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): StageOutcome | Promise<StageOutcome> {
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
          persistOpen(record.id);
        },
      },
    );
    const linked = linkSignals(signal, epochController.signal);
    const failed = (err: unknown): StageOutcome => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const proposal = stage(input);
      // A store that reads before it can stage answers later; the outcome
      // is the same shape either way, so callers await only when they must.
      if (isThenable(proposal)) {
        return (proposal as Promise<StagedProposal>).then(
          (ready): StageOutcome => ({ ok: true, proposal: ready }),
          failed,
        );
      }
      return { ok: true, proposal: proposal as StagedProposal };
    } catch (err) {
      return failed(err);
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
        /** The stored receipt this execution recorded, when it recorded one. */
        receiptId?: string;
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
    /** The grant that authorized this execution in place of an approval. */
    grantId?: string | undefined;
    /** The state digest the approval was bound to, kept on an unknown outcome. */
    stateVersion?: string | undefined;
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
    | {
        kind: "won";
        slot: string;
        fingerprint: string;
        settle: (result: ToolResult) => void;
      }
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
    // A key claimed before a restart has a claim and no result. Replaying
    // is impossible and re-executing is the double-apply the key exists to
    // prevent, so the call is refused either way, with the cause.
    const restored = restoredClaims.get(slot);
    if (restored !== undefined) {
      const same = restored.fingerprint === fingerprint;
      // No capability repairs this: the fix is a person checking the
      // earlier write, so the receipt it recorded rides as evidence and
      // `next` names the receipts query for the capability.
      const evidence: Evidence[] =
        same && restored.receiptId !== undefined
          ? [{ kind: "receipt", id: restored.receiptId }]
          : [];
      return {
        kind: "refused",
        result: idempotencyConflict(
          capability.name,
          idempotencyKey,
          refusal(capability, undefined, evidence),
          same ? "after_restart" : "different_input",
        ),
      };
    }
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
    persist(() =>
      persistence!.saveIdempotencyClaim({ version: 1, slot, fingerprint, at: now() }),
    );
    return {
      kind: "won",
      slot,
      fingerprint,
      settle: (result) => {
        // The first settle resolves the promise concurrent callers joined;
        // every settle records the latest result, so a key claimed at an
        // approval request replays the approval while it is pending and
        // the outcome once a person has decided.
        entry.settled = true;
        resolve(result);
        entry.inFlight = Promise.resolve(result);
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
      if (outcome.ok && outcome.receiptId !== undefined) {
        const receiptId = outcome.receiptId;
        persist(() =>
          persistence!.saveIdempotencyClaim({
            version: 1,
            slot: claim.slot,
            fingerprint: claim.fingerprint,
            at: now(),
            receiptId,
          }),
        );
      }
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
      grantId,
      stateVersion,
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
      ...(grantId !== undefined ? { grantId } : {}),
      ...(actingActor !== undefined ? { actor: actingActor } : {}),
      at: now(),
    });
    try {
      // A staged commit is awaited like a handler is: a store that answers
      // later answers before anything about the outcome is written down.
      const value = opts.commit
        ? await opts.commit()
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
      // Evidence is settled once, here, before the receipt goes anywhere:
      // the audit event, the store, and the result all carry the same list,
      // so "show me proof" is one answer. Authored wins; otherwise derived.
      const settledReceipt: Receipt | undefined = isReceiptEnvelope(value)
        ? {
            ...value.receipt,
            evidence:
              value.receipt.evidence !== undefined
                ? authored(value.receipt.evidence)
                : deriveEvidence(capability, input, value.receipt.entity),
          }
        : undefined;
      if (settledReceipt !== undefined) {
        event.receipt = settledReceipt;
        verification = await runVerification(
          capability,
          input,
          settledReceipt.changes,
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
        if (settledReceipt !== undefined) {
          pending = structuredClone({
            capability: capability.name,
            executionId,
            input,
            receipt: settledReceipt,
            verification,
            at: now(),
            ...(planId !== undefined ? { planId } : {}),
            ...(grantId !== undefined ? { grantId } : {}),
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
      if (capability.annotations.untrustedContentHint) {
        untrustedReads.push({ name: capability.name, tick: ++untrustedTick });
        if (untrustedReads.length > UNTRUSTED_READS_LIMIT) {
          untrustedReads.splice(0, untrustedReads.length - UNTRUSTED_READS_LIMIT);
        }
      }
      const stored = pending ? receipts.record(pending) : undefined;
      const evidence: Evidence[] = [
        ...(stored ? [{ kind: "receipt" as const, id: stored.id }] : []),
        { kind: "execution", id: executionId },
      ];
      // Everything that crosses to the agent goes through the view here, on
      // the runtime's side. The receipt the store holds and the audit event
      // above are the human's and stay whole.
      let toolResult: ToolResult;
      try {
        const linksShown =
          pending === undefined
            ? []
            : linksThroughView(pending.receipt.evidence ?? [], capability, actingActor);
        const receiptShown =
          pending === undefined
            ? undefined
            : (throughView(
                {
                  ...pending.receipt,
                  changes: changesThroughView(
                    pending.receipt.changes,
                    capability,
                    actingActor,
                  ),
                  evidence: linksShown,
                },
                capability,
                actingActor,
              ) as Receipt);
        // The same links ride on the protocol's evidence list, so a result
        // and a receipt answer "show me proof" identically.
        const proof: Evidence[] = [
          ...evidence,
          ...linksShown.map((link) => ({ kind: "link" as const, ...link })),
        ];
        toolResult = completed(
          throughView(recordable, capability, actingActor),
          receiptShown,
          {
            ...settled(capability, proof),
            changes: receiptShown?.changes ?? [],
          },
        );
      } catch (err) {
        if (!(err instanceof AgentViewFailed)) {
          throw err;
        }
        toolResult = viewFailed(capability, capability.name, true, evidence);
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
        ...(stored !== undefined ? { receiptId: stored.id } : {}),
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
            ...(actingActor !== undefined ? { executedBy: actingActor } : {}),
            ...(stateVersion !== undefined ? { stateVersion } : {}),
            ...(grantId !== undefined ? { grantId } : {}),
            at: now(),
          },
          err.artifact,
        );
        persistOpen(record.id);
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
            agentText(message),
            changesThroughView(err.changes, capability, actingActor),
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
      return { ok: false, executionId, result: errorResult(agentText(message)) };
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
      // The same check a single approval runs, per operation. Earlier
      // operations have landed by now, so the probe forks from the state
      // this one was reviewed against; only a move nobody reviewed differs.
      if (operation.stateVersion !== undefined) {
        const probed = currentDigest(routed, operation.input);
        const observed = isThenable(probed)
          ? await (probed as Promise<string | undefined>)
          : (probed as string | undefined);
        if (observed !== operation.stateVersion) {
          proposals.discard(StagedProposalStore.planKey(planId, index));
          return blocked(
            `APPROVAL_STALE: the state this operation was reviewed against has moved (expected ${
              operation.stateVersion
            }, observed ${observed ?? "unreadable"}), so it was not run`,
          );
        }
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
        ...(operation.stateVersion !== undefined
          ? { stateVersion: operation.stateVersion }
          : {}),
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
          persistOpen(outcome.indeterminate.recordId);
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

  /**
   * `find_capabilities`. With no domain it is the single call it always
   * was, ranked by `rankCapabilities` over the routable catalog, plus the
   * domain tree beside the matches so a client can narrow. With a domain,
   * or `domain/subdomain`, it ranks inside that branch under the same
   * budget and the same routable predicate, so a denied capability is
   * absent from every level. An unknown domain routes nothing and answers
   * with the tree.
   */
  async function findCapabilities(
    query: string,
    domain?: string,
  ): Promise<Record<string, unknown>> {
    // Routing offers what policy lets it offer, and nothing else is ranked,
    // annotated, or counted. A denied capability is absent from the report.
    const appCaps = catalog.all().filter(appOnly).filter(routable);
    const narrowed = domain === undefined ? undefined : tree().within(domain, routable);
    const unknownDomain = domain !== undefined && narrowed === undefined;
    let ranked: RankedCapability[];
    if (narrowed !== undefined) {
      // The deterministic scorer, inside the branch the client chose, with
      // ties at the cut reduced by what the query shares with a description.
      ranked = rankWithin(narrowed, viewOf(query, context), tree().fold(query, routable))
        .slice(0, DEFAULT_ROUTED)
        .map(({ member, score }) => ({ capability: member, score }));
    } else if (unknownDomain) {
      ranked = [];
    } else {
      ranked = rankCapabilities(appCaps, context, query);
    }
    let fallback = false;
    if (ranked.length === 0 && !unknownDomain) {
      fallback = true;
      ranked = (narrowed ?? appCaps)
        .filter((capability) => evaluateAvailability(capability, context).available)
        .sort((a, b) => compareNames(a.name, b.name))
        .slice(0, 5)
        .map((capability) => ({ capability, score: 0 }));
    }
    const domains = domain === undefined || unknownDomain ? tree().view(routable).domains : undefined;
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
    lastRouting = {
      query,
      ...(domain !== undefined ? { domain } : {}),
      ...(domains !== undefined ? { domains: structuredClone(domains) } : {}),
      matches,
      activated,
      at: now(),
    };
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
    const instruction = unknownDomain
      ? `${domain} is not a domain in this catalog; choose one from domains and call again with it.`
      : `Up to 5 of the most relevant capabilities are active WebMCP tools; refine the query to surface others. Prefer the native typed tools. If your client has not refreshed its tool list, call invoke_capability with the capability name.${
          domain === undefined
            ? " The domains list is the catalog's tree; call again with domain, or domain/subdomain, to rank within one branch."
            : ""
        }`;
    return {
      catalog_size: appCaps.length,
      query,
      ...(domain !== undefined ? { domain } : {}),
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
      ...(domains !== undefined ? { domains } : {}),
      activated_tools: activated,
      limit: 5,
      instruction,
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

  function actionStatus(
    input: Record<string, unknown>,
    viewer: Actor | undefined,
  ): ToolResult {
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
    const owner = catalog.get(record.action.capability);
    if (record.status === "APPROVED_EXECUTED") {
      base.result = throughView(record.result, owner, viewer);
    }
    if (record.status === "FAILED") {
      base.error = agentText(record.error);
    }
    if (record.status === "FAILED_UNAVAILABLE") {
      base.reasonCode = record.reasonCode;
      base.reason = record.reason;
    }
    if (record.status === "INDETERMINATE") {
      base.detail = agentText(record.detail);
      base.record_id = record.recordId;
      const open = unreconciled
        .list()
        .find((entry) => entry.id === record.recordId)?.changes;
      base.changes =
        open === undefined ? undefined : changesThroughView(open, owner, viewer);
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

  async function approveInner(
    actionId: string,
    by?: Actor | ApprovalGesture,
  ): Promise<ToolResult> {
    const session = claimSession();
    const authorizer = resolveApprover(
      by ?? actor,
      { actionId },
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
    // The person approved a change from an exact state. If that state has
    // moved, the approval no longer describes what would happen, so
    // nothing runs and the artifact is released. The check is the same
    // one a plan runs per operation.
    if (action.stateVersion !== undefined) {
      const probed = currentDigest(routed, action.input);
      const observed = isThenable(probed)
        ? await (probed as Promise<string | undefined>)
        : (probed as string | undefined);
      if (observed !== action.stateVersion) {
        proposals.discard(actionId);
        const versions = {
          expected: action.stateVersion,
          observed: observed ?? "unreadable",
        };
        approvals.resolve(actionId, {
          status: "FAILED_UNAVAILABLE",
          action,
          reasonCode: "APPROVAL_STALE",
          reason: `the state this approval was reviewed against has moved (expected ${versions.expected}, observed ${versions.observed})`,
          resolvedAt: now(),
        });
        audit.append({
          kind: "capability_unavailable",
          capability: action.capability,
          reasonCode: "APPROVAL_STALE",
          at: now(),
        });
        emit();
        return approvalStale(
          action.capability,
          actionId,
          versions,
          refusal(
            routed,
            { capability: routed.name, input: action.input },
            claimed,
          ),
        );
      }
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
    const flagged = untrustedSince(actionId);
    if (flagged.length > 0) {
      audit.append({
        kind: "untrusted_content_ignored",
        actionId,
        capability: action.capability,
        sources: flagged,
        at: now(),
      });
    }
    audit.append({
      kind: "approval_approved",
      actionId,
      capability: action.capability,
      approvedBy: authorizer.actor,
      ...(authorizer.gestureId !== undefined ? { gestureId: authorizer.gestureId } : {}),
      at: now(),
    });
    const held = approvalClaims.get(actionId);
    const outcome = await executeNow(routed, action.input, {
      actor: actingActor,
      humanInitiated: true,
      ...(action.stateVersion !== undefined ? { stateVersion: action.stateVersion } : {}),
      ...(held !== undefined ? { claim: held } : {}),
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
    persistOpen(outcome.indeterminate.recordId);
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
      return errorResult(agentText(message));
    }
  
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
      await rehydrate();
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
      restoredClaims.clear();
      approvalClaims.clear();
      plans.clear();
      receipts.clear();
      grants.clear();
      gestures.clear();
      untrustedReads.length = 0;
      requestedAtTick.clear();
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
    present(request) {
      // A replay is a presentation event, not an execution. It is checked
      // the way the runtime checks its own hints, then emitted on the same
      // bus with the same phase a completed write uses, so the consumer
      // that reveals a write reveals its proof the same way. Nothing only
      // an execution can supply is set: no executionId, so the focus
      // handoff cannot fire; no humanInitiated; no actor.
      if (typeof request !== "object" || request === null) {
        throw new TypeError("present takes a presentation request object");
      }
      if (typeof request.capability !== "string" || request.capability.trim() === "") {
        throw new TypeError("a presentation request names the capability it presents");
      }
      if (request.route !== undefined && (typeof request.route !== "string" || !request.route.startsWith("/"))) {
        throw new TypeError(`a presentation route must start with "/", received ${JSON.stringify(request.route)}`);
      }
      if (request.reveal !== undefined && (typeof request.reveal !== "string" || !REVEAL_TOKEN.test(request.reveal))) {
        throw new TypeError(
          "a presentation reveal is an opaque anchor token the application registered, never a selector",
        );
      }
      if (request.message !== undefined && typeof request.message !== "string") {
        throw new TypeError("a presentation message must be a string when present");
      }
      if (request.focus !== undefined && request.focus !== "never" && request.focus !== "on_explicit_request") {
        throw new TypeError("a presentation focus policy is never or on_explicit_request");
      }
      const event: PresentationEvent = {
        phase: "capability_completed",
        capability: request.capability,
        ...(request.route !== undefined ? { route: request.route } : {}),
        ...(request.reveal !== undefined ? { reveal: request.reveal } : {}),
        ...(request.message !== undefined ? { message: request.message } : {}),
        ...(request.focus !== undefined ? { focus: request.focus } : {}),
        at: now(),
      };
      presentation.emit(event);
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
      const record = (
        routed: Capability,
        input: Record<string, unknown>,
        proposal: StageOutcome,
      ): void => {
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
        const stateVersion = hasPreviewSource(routed, proposal.proposal)
          ? stateDigest(preview.changes)
          : undefined;
        operations.push({
          capability: routed.name,
          input: structuredClone(input),
          preview: preview.changes,
          ...(stateVersion !== undefined ? { stateVersion } : {}),
        });
      };
      // Stays synchronous while every fork answers synchronously, which is
      // what an adapter whose scope closes on return needs. The first fork
      // that answers later turns the rest into a chain the scope is told
      // to stay open for, and each later operation still derives against
      // the one before it.
      const stageFrom = (index: number): void | Promise<void> => {
        for (let at = index; at < routedOperations.length; at += 1) {
          const { routed, input } = routedOperations[at]!;
          const outcome = stageFor(routed, input);
          if (isThenable(outcome)) {
            return (outcome as Promise<StageOutcome>).then((ready) => {
              record(routed, input, ready);
              return stageFrom(at + 1);
            });
          }
          record(routed, input, outcome as StageOutcome);
        }
        return undefined;
      };
      try {
        const staging = scope(() => stageFrom(0));
        if (isThenable(staging)) {
          await staging;
        }
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
      requestedAtTick.set(plan.id, untrustedTick);
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
      const approver = resolveApprover(
        by ?? actor,
        { planId },
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
      const flagged = untrustedSince(planId);
      if (flagged.length > 0) {
        audit.append({
          kind: "untrusted_content_ignored",
          planId,
          capability: claimed.operations.map((operation) => operation.capability).join(", "),
          sources: flagged,
          at: now(),
        });
      }
      audit.append({
        kind: "plan_approved",
        planId,
        actor: approver.actor,
        ...(approver.gestureId !== undefined ? { gestureId: approver.gestureId } : {}),
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
    grant(request, by) {
      // Identity first, before the request is even read. A malformed or
      // non-human issuer throws where the ambient actor would, because
      // minting authority is not a call to hand a reason back to.
      const issuer = adoptHumanActor(
        by ?? actor,
        "a grant must be issued by a human; pass one to grant rather than relying on the acting actor",
      );
      const parsed = parseGrantRequest(request, now());
      if (!parsed.ok) {
        return parsed;
      }
      const target = catalog.get(parsed.parsed.capability);
      if (target === undefined || !appOnly(target)) {
        return { ok: false, reason: `unknown capability: ${request.capability}` };
      }
      const issued = grants.issue(parsed.parsed, issuer, now());
      audit.append({
        kind: "grant_issued",
        grantId: issued.id,
        capability: issued.capability,
        actor: issuer,
        uses: issued.uses,
        expiresAt: issued.expiresAt,
        at: now(),
      });
      emit();
      return { ok: true, grant: issued };
    },
    revokeGrant(grantId, by) {
      const revoker = adoptHumanActor(
        by ?? actor,
        "a grant must be revoked by a human; pass one to revokeGrant rather than relying on the acting actor",
      );
      const result = grants.revoke(grantId, revoker, now());
      if (result.ok) {
        audit.append({
          kind: "grant_revoked",
          grantId: result.grant.id,
          capability: result.grant.capability,
          actor: revoker,
          remaining: result.grant.remaining,
          at: now(),
        });
        emit();
      }
      return result;
    },
    listGrants() {
      return grants.list(now());
    },
    getGrant(grantId) {
      return grants.get(grantId, now());
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
    issueApprovalGesture(binding, by) {
      // Identity first, the same way a grant is minted: a malformed or
      // non-human issuer throws where the ambient actor would.
      const issuer = adoptHumanActor(
        by ?? actor,
        "an approval token must be minted by a human; pass one to issueApprovalGesture rather than relying on the acting actor",
      );
      const bound =
        typeof binding === "object" && binding !== null
          ? "actionId" in binding && typeof binding.actionId === "string"
            ? { actionId: binding.actionId }
            : "planId" in binding && typeof binding.planId === "string"
              ? { planId: binding.planId }
              : undefined
          : undefined;
      if (bound === undefined) {
        throw new TypeError("an approval token is bound to one actionId or one planId");
      }
      // A token stands for a click. Minted outside one, it would prove
      // nothing the asserted identity did not, one call further away.
      let active = false;
      try {
        active = userActivation() === true;
      } catch {
        active = false;
      }
      if (!active) {
        throw new Error(
          "an approval token can only be minted during a user activation; call issueApprovalGesture from the click handler itself, not before or after it",
        );
      }
      return gestures.issue(bound, issuer, now());
    },
    async approve(actionId, by) {
      // The acting identity is read once, here, for the approval and for
      // the view its result crosses.
      const viewer = actor;
      const owner = approvals.get(actionId)?.action.capability;
      const result = await approveInner(actionId, by);
      // Once the action is no longer pending, the key claimed at its
      // request settles with what happened, whatever path answered.
      const status = approvals.get(actionId)?.status;
      const held = approvalClaims.get(actionId);
      if (held !== undefined && status !== "PENDING" && status !== "EXECUTING") {
        held.settle(result);
        approvalClaims.delete(actionId);
      }
      return crossing(
        result,
        owner === undefined ? undefined : catalog.get(owner),
        owner ?? "approve",
        viewer,
      );
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
      // An artifact that came back from persistence as a description rather
      // than the object is rebuilt here, by the application's resolver. One
      // that cannot be rebuilt leaves the record open and says so, because
      // closing a record whose artifact nobody can hand back would settle
      // nothing in the application.
      let artifact = found.artifact;
      if (isPersistedHolder(artifact)) {
        const rebuilt = persistence?.resolveArtifact?.(artifact[PERSISTED]);
        if (rebuilt === undefined) {
          const detail =
            persistence?.resolveArtifact === undefined
              ? "the artifact was persisted as a reference and the persistence adapter has no resolveArtifact to rebuild it"
              : "the persistence adapter's resolveArtifact could not rebuild the artifact";
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
            reason: `${found.record.id} stays open: ${detail}`,
          };
        }
        artifact = rebuilt;
      }
      // Only the adapter can make the artifact terminal, and only a
      // successful return says it did. A throw leaves the record and its
      // evidence exactly where they were.
      try {
        // The artifact came from this adapter's own `fork`, so handing it
        // back is the one place the erased type is reconstituted.
        (options.staging as StagingAdapter<unknown>).reconcile(
          artifact,
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
      persist(() => persistence!.settleRecord(found.record.id));
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
      const rejected = toToolResult({
        status: "REJECTED",
        approval_id: actionId,
        capability: action.capability,
      });
      const held = approvalClaims.get(actionId);
      if (held !== undefined) {
        held.settle(rejected);
        approvalClaims.delete(actionId);
      }
      return rejected;
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
          // `domain` is accepted and not declared. The bootstrap surface's
          // bytes are the budget every published set is measured against
          // and the figure the task evaluation's reference records, so the
          // narrowing input rides in every first-level answer's
          // `instruction` and `domains` instead of in this schema.
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
