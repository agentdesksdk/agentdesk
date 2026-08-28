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

export type RiskLevel = "READ" | "WRITE" | "CONSEQUENTIAL";

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
  execute: (
    input: Record<string, unknown>,
    ctx: AppContext,
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
  execute: (
    input: Record<string, unknown>,
    ctx: AppContext,
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
  return capability;
}
