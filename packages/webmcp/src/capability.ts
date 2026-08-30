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
import type { VerificationResult } from "./plan.ts";

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

export type Policy =
  | { kind: "allow" }
  | { kind: "approval_required" };

export type ToolSurfaceKind = "native" | "invoke";

export type Unavailability = {
  available: false;
  reasonCode: string;
  reason: string;
  suggestedCapability?: string;
};

export type Availability = { available: true } | Unavailability;

export const AVAILABLE: Availability = { available: true };

export function unavailable(
  reasonCode: string,
  reason: string,
  suggestedCapability?: string,
): Unavailability {
  const result: Unavailability = { available: false, reasonCode, reason };
  if (suggestedCapability !== undefined) {
    result.suggestedCapability = suggestedCapability;
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
  risk: RiskLevel;
  inputSchema: InputSchema;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  surface: ToolSurfaceKind;
  availability: (ctx: AppContext) => Availability;
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
   * What the human is shown before approving. `diff` requires
   * `previewChanges`; `summary` is an explicit opt-out for actions with no
   * enumerable change set. A consequential capability must pick one, so a
   * missing preview can never silently degrade into an empty diff.
   */
  approvalEvidence: "diff" | "summary";
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

export type CapabilitySpec = {
  name: string;
  description: string;
  id?: string;
  title?: string;
  domain?: string;
  intents?: readonly string[];
  keywords?: readonly string[];
  entities?: readonly string[];
  routes?: readonly string[];
  risk?: RiskLevel;
  inputSchema?: InputSchema;
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  surface?: ToolSurfaceKind;
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
  previewChanges?: (
    input: Record<string, unknown>,
    ctx: AppContext,
  ) => Change[];
  /** Required for a consequential capability with no `previewChanges`. */
  approvalEvidence?: "diff" | "summary";
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
  execute: (
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Promise<unknown> | unknown;
};

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

  const approvalEvidence =
    spec.approvalEvidence ?? (spec.previewChanges ? "diff" : "summary");
  if (risk === "CONSEQUENTIAL") {
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
    execute: spec.execute,
  };
  if (spec.domain !== undefined) {
    capability.domain = spec.domain;
  }
  if (spec.title !== undefined) {
    capability.title = spec.title;
  }
  if (spec.checkInput !== undefined) {
    capability.checkInput = spec.checkInput;
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
