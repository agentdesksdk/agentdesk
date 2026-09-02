export type CapabilityName = string & { readonly __brand: "CapabilityName" };

export type InputSchema = {
  type: "object";
  description?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

export type AppContext = {
  route: string;
  state: Record<string, unknown>;
};

/**
 * What a handler receives as its second argument. Extends AppContext so
 * existing handlers that read `route`/`state` keep working unchanged, and
 * adds the execution metadata WebMCP gives us.
 *
 * `signal` is the WebMCP execution signal (spec: ToolExecuteCallbackOptions)
 * linked with the runtime's lifecycle, so it aborts when the client cancels
 * the call OR when the runtime is stopped or reset. Pass it to fetch.
 */
export type ExecutionContext = AppContext & {
  signal: AbortSignal;
  /** Unique per execution attempt; correlates audit events. */
  executionId: string;
  /** Caller-supplied dedupe key, when one was provided. */
  idempotencyKey?: string;
};

import type { FocusPolicy } from "./presentation.ts";
import type { Actor, VerificationResult } from "./plan.ts";
import type { Repair } from "./protocol.ts";


export type RiskLevel = "READ" | "WRITE" | "CONSEQUENTIAL";

/** One field-level before/after pair. Values must be JSON-serializable. */
export type Change = {
  field: string;
  before: unknown;
  after: unknown;
};

/**
 * Optional hints for showing a human what a capability is acting on.
 * The runtime only resolves these to plain data; navigating, scrolling,
 * and highlighting are the UI's job.
 */
export type Presentation = {
  /** Where the affected entity lives, e.g. `/orders/10428`. */
  route?: (input: Record<string, unknown>, ctx: AppContext) => string | undefined;
  /** Anchor for the UI to scroll to and emphasize, matched by the app. */
  reveal?: string;
  /** Short narration, e.g. "Checking whether shipping was paid". */
  message?:
    | string
    | ((input: Record<string, unknown>, ctx: AppContext) => string);
  /** Whether a completed action may move keyboard focus to `reveal`. */
  focus?: FocusPolicy;
  /**
   * Short screen-reader sentence for the completed action. Takes input so
   * the announcement can name the entity; "refund applied" without saying
   * to what is not usable by someone who cannot see the screen.
   */
  announce?:
    | string
    | ((input: Record<string, unknown>, ctx: AppContext) => string);
};

/**
 * The routing graph, expressed on the capability that knows about it.
 *
 * `requires` names a step that usually has to happen first, so a query that
 * matches this capability can pull its prerequisite in. `related` names a
 * step a caller commonly wants alongside it. Both are names rather than
 * references, because a capability can name one the catalog does not hold
 * and routing has to survive that rather than throw.
 */
export type CapabilityRelationships = {
  requires?: readonly string[];
  related?: readonly string[];
};

/**
 * What a defined capability carries. Both arrays are always present, so
 * routing reads `relationships.requires` without a guard.
 *
 * Author input stays optional above, because making a caller write two empty
 * arrays to say nothing would be a worse API. Normalization is what closes
 * the gap, and this is the type that records it happened.
 */
export type NormalizedRelationships = {
  readonly requires: readonly string[];
  readonly related: readonly string[];
};

export type Policy =
  | { kind: "allow" }
  | { kind: "approval_required" };

/**
 * The projection of application state an agent is allowed to see. Given a
 * state-shaped object and who is looking, returns what may cross to the
 * agent. The runtime applies it on its side of the boundary to everything
 * that crosses, so a capability cannot skip it.
 */
export type AgentView = (view: {
  state: Record<string, unknown>;
  actor?: Actor;
}) => Record<string, unknown>;

export type ToolSurfaceKind = "native" | "invoke";

/**
 * What an author says about a capability that cannot run: a stable code, a
 * sentence a human can read, and optionally the capability that repairs the
 * situation with the input to call it with.
 *
 * The author's `repair` is a claim, not a promise. The runtime checks it
 * against policy and availability before it reaches a result, so a repair
 * naming a capability the agent cannot route to is dropped rather than
 * repeated. There is no `suggestedCapability` here any more; the runtime
 * derives that name from `repair.capability` on the way out, for one
 * release, so nothing has two places to say the same thing.
 */
export type Unavailability = {
  available: false;
  reasonCode: string;
  reason: string;
  repair?: Repair;
};

export type Availability = { available: true } | Unavailability;

export const AVAILABLE: Availability = { available: true };

/**
 * `repair` may be a bare capability name, which is the old
 * `suggestedCapability` argument and means `{ capability: name }`. Passing
 * the object is the form that can carry input.
 */
export function unavailable(
  reasonCode: string,
  reason: string,
  repair?: Repair | string,
): Unavailability {
  const result: Unavailability = { available: false, reasonCode, reason };
  if (repair !== undefined) {
    result.repair =
      typeof repair === "string"
        ? { capability: repair }
        : repair.input === undefined
          ? { capability: repair.capability }
          : { capability: repair.capability, input: { ...repair.input } };
  }
  return result;
}

/**
 * Thrown by a capability handler when input-level validation fails
 * (e.g. the referenced order is already refunded). The runtime turns
 * this into a structured CAPABILITY_UNAVAILABLE tool result instead
 * of an opaque error.
 */
export class CapabilityUnavailableError extends Error {
  readonly unavailability: Unavailability;

  constructor(unavailability: Unavailability) {
    super(unavailability.reason);
    this.name = "CapabilityUnavailableError";
    this.unavailability = unavailability;
  }
}

export type Capability = {
  /** Stable identifier. Equal to `name` unless overridden. */
  id: string;
  name: CapabilityName;
  description: string;
  title?: string;
  domain?: string;
  /** Intent phrases; a phrase matches when all its words appear in the query. */
  intents: readonly string[];
  /** Single-word keywords; name tokens are always included. */
  keywords: readonly string[];
  /** Context state keys whose presence makes this capability more relevant. */
  entities: readonly string[];
  /** Route prefixes on which this capability is more relevant. */
  routes: readonly string[];
  /**
   * How this capability sits against others, used by hybrid routing to
   * surface the step a task needs next rather than the whole catalog.
   *
   * These are routing hints, not execution constraints. The runtime does
   * not enforce ordering from `requires`, because a capability that truly
   * cannot run yet says so through `availability` or `checkInput`, where
   * the refusal carries a reason a human can read.
   */
  relationships: NormalizedRelationships;
  risk: RiskLevel;
  inputSchema: InputSchema;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  surface: ToolSurfaceKind;
  availability: (ctx: AppContext) => Availability;
  /**
   * Narrows the runtime's agent view further for this capability's own
   * results. Receives what the runtime's view already let through, so it
   * can only remove, never restore.
   */
  agentView?: AgentView;
  /**
   * Input-level pre-flight, checked before the policy gate so an
   * infeasible consequential action fails fast instead of queueing an
   * approval that would fail. Re-checked at approval time.
   */
  checkInput?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => Availability;
  policy: Policy;
  presentation?: Presentation;
  describeApproval?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => string;
  /**
   * What this call would change, evaluated before execution so a human can
   * see it on the approval card. Advisory: the authoritative record is the
   * receipt the handler returns after the write.
   */
  previewChanges?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => Change[];
  /**
   * What the human is shown before approving, ordered by how much the
   * approval is worth.
   *
   * `derived` is not selectable. The runtime sets it only for a capability
   * that declared `stage`, where the diff is read off a fork the same run
   * will land, so the label cannot be claimed alongside an unrelated
   * preview callback. `diff` requires `previewChanges` and is an author's
   * enumeration, which can drift from what `execute` does. `summary` is an
   * explicit opt-out for actions with no enumerable change set. A
   * consequential capability must have one, so a missing preview can never
   * silently degrade into an empty diff.
   */
  approvalEvidence: "derived" | "diff" | "summary";
  /**
   * Present exactly when `approvalEvidence` is `derived`. The name of an
   * operation the staging adapter owns. The capability supplies no code, so
   * it has no say in how its change is made or described.
   */
  stagedOperation?: string;
  /**
   * Reads state back after execution and reports whether it matches what
   * the change was supposed to do. This is the difference between a
   * handler claiming success and the application actually being in the
   * promised state, so it runs against real state, not the return value.
   */
  verify?: (
    input: Record<string, unknown>,
    ctx: AppContext,
    changes: readonly Change[],
  ) => VerificationResult | Promise<VerificationResult>;
  /**
   * Reads state back after a rollback and reports whether the receipt's
   * `before` values are actually back.
   *
   * `verify` cannot answer this. It asks whether the original change is
   * still visible, so it detects a no-op undo and nothing more. Its MISMATCH
   * says only that state moved, not that it moved to the right place, and an
   * undo that lands on a third value is not a rollback.
   */
  verifyRollback?: (
    input: Record<string, unknown>,
    ctx: AppContext,
    changes: readonly Change[],
  ) => VerificationResult | Promise<VerificationResult>;
  /**
   * What a receipt may claim after an undo, the twin of `approvalEvidence`.
   *
   * `verified` needs `verifyRollback` and records a proven rollback.
   * `handler` is the explicit opt-out for an application that cannot read
   * its own state back, and records the undo on the handler's word alone.
   * Declaring neither leaves the receipt INDETERMINATE for a human to
   * reconcile, because a governance record should not assert what nobody
   * checked.
   */
  rollbackEvidence?: "verified" | "handler";
  /**
   * Optional. Most applications cannot undo, and pretending otherwise is
   * worse than admitting it, so a capability without this reports
   * UNSUPPORTED rather than failing.
   */
  rollback?: (
    input: Record<string, unknown>,
    ctx: AppContext,
    changes: readonly Change[],
  ) => unknown | Promise<unknown>;
  /**
   * Never called for a staged capability. `defineCapability` substitutes a
   * handler that throws, so a caller that loses the staged proposal fails
   * closed instead of running the write outside the artifact that was
   * approved.
   */
  execute: (
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<unknown> | unknown;
};

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function parseCapabilityName(raw: string): CapabilityName {
  if (!NAME_RE.test(raw)) {
    throw new Error(`invalid capability name: ${raw}`);
  }
  return raw as CapabilityName;
}

export function isCapabilityName(value: string): value is CapabilityName {
  return NAME_RE.test(value);
}

/** Everything that does not depend on how the capability produces its write. */
type CapabilitySpecBase = {
  name: string;
  description: string;
  id?: string;
  title?: string;
  domain?: string;
  intents?: readonly string[];
  keywords?: readonly string[];
  entities?: readonly string[];
  routes?: readonly string[];
  relationships?: CapabilityRelationships;
  risk?: RiskLevel;
  inputSchema?: InputSchema;
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  surface?: ToolSurfaceKind;
  agentView?: AgentView;
  /** Legacy boolean availability. Prefer `availability` for structured reasons. */
  available?: (ctx: AppContext) => boolean;
  availability?: (ctx: AppContext) => Availability;
  checkInput?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => Availability;
  policy?: Policy;
  presentation?: Presentation;
  describeApproval?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => string;
  verify?: (
    input: Record<string, unknown>,
    ctx: AppContext,
    changes: readonly Change[],
  ) => VerificationResult | Promise<VerificationResult>;
  verifyRollback?: (
    input: Record<string, unknown>,
    ctx: AppContext,
    changes: readonly Change[],
  ) => VerificationResult | Promise<VerificationResult>;
  rollbackEvidence?: "verified" | "handler";
  rollback?: (
    input: Record<string, unknown>,
    ctx: AppContext,
    changes: readonly Change[],
  ) => unknown | Promise<unknown>;
};

/**
 * A capability that writes when it executes. Its preview, if it has one, is
 * a second description of the operation written by hand, so it is labelled
 * `diff` and can drift from what `execute` does.
 */
export type DirectCapabilitySpec = CapabilitySpecBase & {
  execute: (
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<unknown> | unknown;
  previewChanges?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => Change[];
  /** Required for a consequential capability with no `previewChanges`. */
  approvalEvidence?: "diff" | "summary";
  stage?: undefined;
};

/**
 * A capability that stages its write instead of performing it. The diff and
 * the change are one execution, which is what `derived` evidence means, so
 * neither the preview callback nor the evidence label is separately
 * selectable here.
 */
export type StagedCapabilitySpec = CapabilitySpecBase & {
  /**
   * The name of an operation the staging adapter owns, and nothing else. A
   * capability supplies no executable code, so it can neither describe its
   * own change nor reach live state outside the fork the adapter opens.
   * That separation is what `derived` evidence asserts.
   */
  staging: {
    operation: string;
    write?: undefined;
    adapter?: undefined;
  };
  execute?: undefined;
  previewChanges?: undefined;
  approvalEvidence?: undefined;
  stage?: undefined;
};

export type CapabilitySpec = DirectCapabilitySpec | StagedCapabilitySpec;

/** `Omit` over a union, which would otherwise collapse to the shared keys. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export function defineCapability(spec: CapabilitySpec): Capability {
  if (spec.description.trim() === "") {
    throw new Error("capability description must be non-empty");
  }
  const name = parseCapabilityName(spec.name);
  const risk: RiskLevel =
    spec.risk ??
    (spec.policy?.kind === "approval_required" ? "CONSEQUENTIAL" : "READ");
  const policy: Policy =
    spec.policy ??
    (risk === "CONSEQUENTIAL" ? { kind: "approval_required" } : { kind: "allow" });
  const availability =
    spec.availability ??
    (spec.available
      ? (ctx: AppContext): Availability =>
          spec.available!(ctx)
            ? AVAILABLE
            : unavailable(
                "CONTEXT_MISMATCH",
                `${name} is not available in the current application context.`,
              )
      : (): Availability => AVAILABLE);

  // A JavaScript caller can hand over an object the union rejects, so the
  // two shapes are separated again here rather than trusted from the type.
  const staging = (spec as { staging?: StagedCapabilitySpec["staging"] })
    .staging;
  const staged = typeof staging === "object" && staging !== null;
  if (staged) {
    if (typeof spec.execute === "function") {
      throw new Error(
        `${name} declares both stage and execute. A staged capability lands through its proposal, so there is no second handler to run.`,
      );
    }
    if (spec.previewChanges !== undefined || spec.approvalEvidence !== undefined) {
      throw new Error(
        `${name} declares staging alongside previewChanges or approvalEvidence. Derived evidence means the staged run is the preview; a second one could disagree with it.`,
      );
    }
    if ((spec as { stage?: unknown }).stage !== undefined) {
      throw new Error(
        `${name} supplies a stage handler directly. A staged proposal is built by the runtime, so an author-assembled one cannot claim derived evidence.`,
      );
    }
    if (staging.adapter !== undefined || staging.write !== undefined) {
      throw new Error(
        `${name} supplies staging code. A capability only names an operation the adapter owns, because code it supplied could reach live state outside the fork or describe a change it does not make.`,
      );
    }
    if (typeof staging.operation !== "string" || staging.operation === "") {
      throw new Error(`${name} declares staging without an operation name`);
    }
  } else {
    if (typeof spec.execute !== "function") {
      throw new Error(`${name} must declare either execute or stage`);
    }
    // The public spec type has no "derived" member, so reaching this means a
    // JavaScript caller supplied the stronger label without the staged run
    // that is the only thing entitled to it.
    if ((spec.approvalEvidence as string) === "derived") {
      throw new Error(
        `${name} claims approvalEvidence "derived" without a stage handler. Derived evidence means the preview came from the run that will land, which a preview callback cannot provide.`,
      );
    }
  }

  const approvalEvidence: Capability["approvalEvidence"] = staged
    ? "derived"
    : (spec.approvalEvidence ?? (spec.previewChanges ? "diff" : "summary"));
  if (risk === "CONSEQUENTIAL" && !staged) {
    if (approvalEvidence === "diff" && !spec.previewChanges) {
      throw new Error(
        `${name} declares approvalEvidence "diff" but has no previewChanges`,
      );
    }
    if (spec.approvalEvidence === undefined && !spec.previewChanges) {
      throw new Error(
        `${name} is CONSEQUENTIAL and must either declare previewChanges or opt in to approvalEvidence: "summary". A human approving without a diff has to be a deliberate choice.`,
      );
    }
  }

  const keywords = new Set<string>(name.split("_"));
  for (const keyword of spec.keywords ?? []) {
    keywords.add(keyword.toLowerCase());
  }

  const capability: Capability = {
    id: spec.id ?? name,
    name,
    description: spec.description,
    intents: spec.intents ?? [],
    keywords: [...keywords],
    entities: spec.entities ?? [],
    routes: spec.routes ?? [],
    // Copied and frozen, so a caller mutating the array it passed in cannot
    // rewrite the routing graph of an already-defined capability.
    relationships: Object.freeze({
      requires: Object.freeze([...new Set(spec.relationships?.requires ?? [])]),
      related: Object.freeze([...new Set(spec.relationships?.related ?? [])]),
    }),
    risk,
    inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
    annotations: {
      readOnlyHint: spec.readOnlyHint ?? risk === "READ",
      untrustedContentHint: spec.untrustedContentHint === true,
    },
    surface: spec.surface ?? "invoke",
    availability,
    policy,
    approvalEvidence,
    execute: staged
      ? () => {
          throw new Error(
            `${name} is staged and must be committed through the proposal the runtime holds for its approval. Executing it directly would run a write no one approved.`,
          );
        }
      : spec.execute!,
  };
  if (staged) {
    capability.stagedOperation = staging.operation;
  }
  if (spec.domain !== undefined) {
    capability.domain = spec.domain;
  }
  if (spec.title !== undefined) {
    capability.title = spec.title;
  }
  if (spec.checkInput !== undefined) {
    capability.checkInput = spec.checkInput;
  }
  if (spec.agentView !== undefined) {
    capability.agentView = spec.agentView;
  }
  if (spec.presentation !== undefined) {
    capability.presentation = spec.presentation;
  }
  if (spec.describeApproval !== undefined) {
    capability.describeApproval = spec.describeApproval;
  }
  if (spec.previewChanges !== undefined) {
    capability.previewChanges = spec.previewChanges;
  }
  if (spec.verify !== undefined) {
    capability.verify = spec.verify;
  }
  if (spec.verifyRollback !== undefined) {
    capability.verifyRollback = spec.verifyRollback;
  }
  if (spec.verifyRollback !== undefined && spec.rollbackEvidence === "handler") {
    throw new Error(
      `${name} declares verifyRollback and also waives it with rollbackEvidence "handler". Keep the verifier, or drop it and accept the handler's word, but not both.`,
    );
  }
  if (spec.rollbackEvidence !== undefined) {
    capability.rollbackEvidence = spec.rollbackEvidence;
  } else if (spec.verifyRollback !== undefined) {
    capability.rollbackEvidence = "verified";
  }
  if (spec.rollback !== undefined) {
    capability.rollback = spec.rollback;
  }
  return capability;
}
