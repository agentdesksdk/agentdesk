import { deepFreeze } from "./audit.ts";
import { isCapabilityName, type CapabilityName } from "./capability.ts";
import type { HumanActor } from "./plan.ts";

/**
 * Scoped authority grants. A person approves a bounded mandate once, and
 * the runtime spends it one execution at a time instead of asking for an
 * approval on every call.
 *
 * A grant narrows approval and never widens policy. It is consulted only
 * where policy says `require_approval`; under `deny` nothing executes, and
 * under `allow` a grant is never consulted and records nothing. A grant
 * that does not apply to a call changes nothing: the call takes the path
 * it always had, an approval with a person deciding.
 */

export type GrantId = string & { readonly __brand: "GrantId" };

export type ScopeValue = string | number | boolean;

/**
 * One rule against one field of the call input. `exact` is for identity
 * fields and compares strictly. `bound` is for numeric fields and requires
 * a finite number inside the closed interval. A field the input does not
 * carry fails its rule; a scope is never a wildcard over missing input.
 */
export type ScopeRule =
  | { readonly field: string; readonly kind: "exact"; readonly value: ScopeValue }
  | {
      readonly field: string;
      readonly kind: "bound";
      readonly min?: number;
      readonly max?: number;
    };

/**
 * What a person asks for. `scope` is written per input field: a primitive
 * is an exact match on that field, and a key of the form `maxAmount` or
 * `minAmount` is a numeric bound on the field `amount`. `expiresAt` is an
 * ISO timestamp or epoch milliseconds.
 */
export type GrantRequest = {
  capability: string;
  scope?: Record<string, ScopeValue>;
  uses: number;
  expiresAt: string | number;
};

type GrantBase = {
  readonly id: GrantId;
  readonly capability: CapabilityName;
  readonly scope: readonly ScopeRule[];
  /** Uses granted at issue. */
  readonly uses: number;
  readonly issuedBy: HumanActor;
  readonly issuedAt: number;
  readonly expiresAt: number;
};

/**
 * A grant is in exactly one state, and the terminal states are distinct
 * shapes rather than a live grant with a flag. Only `live` can authorize
 * an execution. `remaining` on a terminal state is what was left when it
 * ended, kept for the record.
 */
export type Grant =
  | (GrantBase & { readonly state: "live"; readonly remaining: number })
  | (GrantBase & {
      readonly state: "exhausted";
      readonly remaining: 0;
      readonly exhaustedAt: number;
    })
  | (GrantBase & {
      readonly state: "expired";
      readonly remaining: number;
      readonly expiredAt: number;
    })
  | (GrantBase & {
      readonly state: "revoked";
      readonly remaining: number;
      readonly revokedAt: number;
      readonly revokedBy: HumanActor;
    });

export type LiveGrant = Extract<Grant, { state: "live" }>;

export type GrantState = Grant["state"];

/**
 * Why a grant did not apply to a call. The scope outcomes name the field,
 * and the bound outcomes carry the bound, so a result can say exactly what
 * the mandate stopped at without repeating the input.
 */
export type GrantOutcome =
  | { readonly outcome: "exhausted" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "revoked" }
  | { readonly outcome: "missing_field"; readonly field: string }
  | { readonly outcome: "out_of_scope"; readonly field: string }
  | { readonly outcome: "over_bound"; readonly field: string; readonly max: number }
  | { readonly outcome: "under_bound"; readonly field: string; readonly min: number };

/** The grant a call was checked against, and why it did not apply. */
export type ConsideredGrant = { readonly id: GrantId } & GrantOutcome;

/**
 * What consulting the grants for one call says. `none` means no grant was
 * ever issued for the capability. `not_applied` means grants exist and
 * none authorizes this call; the one named is the one whose state best
 * explains why. Both leave the ordinary approval gate in charge.
 */
export type GrantConsultation =
  | { kind: "none" }
  | { kind: "matched"; grant: LiveGrant }
  | { kind: "not_applied"; grant: ConsideredGrant };

/** A request with every field checked, ready for the store. */
export type ParsedGrantRequest = {
  capability: CapabilityName;
  scope: readonly ScopeRule[];
  uses: number;
  expiresAt: number;
};

const BOUND_KEY = /^(max|min)([A-Z][A-Za-z0-9_]*)$/;

function isScopeValue(value: unknown): value is ScopeValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Turns the per-field scope literal into rules. `maxAmount: 25` bounds
 * `amount` from above and `minAmount: 5` from below; any other key is an
 * exact match on that field. Two bounds on one field merge; a bound and an
 * exact on one field contradict each other and are refused, as is any
 * value that is not a finite number, a string, or a boolean.
 */
export function parseScope(
  scope: Record<string, ScopeValue> | undefined,
): { ok: true; rules: ScopeRule[] } | { ok: false; reason: string } {
  const exact = new Map<string, ScopeValue>();
  const bounds = new Map<string, { min?: number; max?: number }>();
  for (const [key, value] of Object.entries(scope ?? {})) {
    if (!isScopeValue(value)) {
      return {
        ok: false,
        reason: `scope field ${key} must be a string, a boolean, or a finite number`,
      };
    }
    const bound = BOUND_KEY.exec(key);
    if (bound) {
      const field = bound[2]!.charAt(0).toLowerCase() + bound[2]!.slice(1);
      if (typeof value !== "number") {
        return { ok: false, reason: `scope bound ${key} must be a number` };
      }
      const existing = bounds.get(field) ?? {};
      bounds.set(field, { ...existing, [bound[1]!]: value });
      continue;
    }
    exact.set(key, value);
  }
  for (const field of bounds.keys()) {
    if (exact.has(field)) {
      return {
        ok: false,
        reason: `scope field ${field} carries both an exact value and a bound`,
      };
    }
  }
  for (const [field, range] of bounds) {
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
      return {
        ok: false,
        reason: `scope bound on ${field} has a minimum above its maximum`,
      };
    }
  }
  const rules: ScopeRule[] = [
    ...[...bounds].map(([field, range]) => ({ field, kind: "bound" as const, ...range })),
    ...[...exact].map(([field, value]) => ({ field, kind: "exact" as const, value })),
  ];
  rules.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return { ok: true, rules };
}

export function parseGrantRequest(
  request: GrantRequest,
  at: number,
): { ok: true; parsed: ParsedGrantRequest } | { ok: false; reason: string } {
  if (typeof request !== "object" || request === null) {
    return { ok: false, reason: "a grant request must be an object" };
  }
  if (typeof request.capability !== "string" || !isCapabilityName(request.capability)) {
    return { ok: false, reason: "a grant must name a capability" };
  }
  if (
    typeof request.uses !== "number" ||
    !Number.isInteger(request.uses) ||
    request.uses < 1
  ) {
    return { ok: false, reason: "a grant must allow a positive whole number of uses" };
  }
  const expiresAt =
    typeof request.expiresAt === "number"
      ? request.expiresAt
      : typeof request.expiresAt === "string"
        ? Date.parse(request.expiresAt)
        : Number.NaN;
  if (!Number.isFinite(expiresAt)) {
    return {
      ok: false,
      reason: "a grant must expire at an ISO timestamp or epoch milliseconds",
    };
  }
  if (expiresAt <= at) {
    return { ok: false, reason: "a grant must expire in the future" };
  }
  const scope = parseScope(request.scope);
  if (!scope.ok) {
    return scope;
  }
  return {
    ok: true,
    parsed: {
      capability: request.capability,
      scope: scope.rules,
      uses: request.uses,
      expiresAt,
    },
  };
}

/** The scope outcomes, which are the only ones `matchesScope` can produce. */
export type ScopeOutcome = Extract<GrantOutcome, { field: string }>;

/**
 * Whether the call input sits inside the scope. Every rule must hold, and a
 * field the input does not carry fails its rule, so a scope can only ever
 * narrow what a call may do. A failure names the field and what stopped it.
 */
export function matchesScope(
  scope: readonly ScopeRule[],
  input: Record<string, unknown>,
): { ok: true } | { ok: false; why: ScopeOutcome } {
  for (const rule of scope) {
    if (!(rule.field in input) || input[rule.field] === undefined) {
      return { ok: false, why: { outcome: "missing_field", field: rule.field } };
    }
    const value = input[rule.field];
    if (rule.kind === "exact") {
      if (value !== rule.value) {
        return { ok: false, why: { outcome: "out_of_scope", field: rule.field } };
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, why: { outcome: "out_of_scope", field: rule.field } };
    }
    if (rule.max !== undefined && value > rule.max) {
      return {
        ok: false,
        why: { outcome: "over_bound", field: rule.field, max: rule.max },
      };
    }
    if (rule.min !== undefined && value < rule.min) {
      return {
        ok: false,
        why: { outcome: "under_bound", field: rule.field, min: rule.min },
      };
    }
  }
  return { ok: true };
}

/**
 * In-memory, like every other record store here. Every record handed out
 * is frozen, so a holder cannot add a use to a grant it was shown.
 *
 * Expiry settles lazily: a live grant past its expiry becomes `expired` the
 * next time anything reads it with a clock.
 */
export class GrantStore {
  private readonly grants = new Map<string, Grant>();
  /**
   * The order in which grants last changed state. Two changes can land in
   * the same millisecond, and "most recent" has to be a total order for
   * the consult to be deterministic, so each change also takes a ticket.
   */
  private readonly changed = new Map<string, number>();
  private ticket = 0;
  private nextId = 1;

  private touch(id: string): void {
    this.changed.set(id, ++this.ticket);
  }

  issue(parsed: ParsedGrantRequest, by: HumanActor, at: number): LiveGrant {
    const grant: LiveGrant = deepFreeze({
      id: `GRT-${this.nextId++}` as GrantId,
      capability: parsed.capability,
      scope: parsed.scope.map((rule) => ({ ...rule })),
      uses: parsed.uses,
      remaining: parsed.uses,
      issuedBy: { ...by },
      issuedAt: at,
      expiresAt: parsed.expiresAt,
      state: "live",
    });
    this.grants.set(grant.id, grant);
    this.touch(grant.id);
    return grant;
  }

  get(id: string, at: number): Grant | undefined {
    const grant = this.grants.get(id);
    return grant === undefined ? undefined : this.settle(grant, at);
  }

  list(at: number): Grant[] {
    return [...this.grants.values()].map((grant) => this.settle(grant, at));
  }

  /** Capabilities holding at least one live grant, for a result's `nowPossible`. */
  liveCapabilities(at: number): CapabilityName[] {
    const names = new Set<CapabilityName>();
    for (const grant of this.list(at)) {
      if (grant.state === "live") {
        names.add(grant.capability);
      }
    }
    return [...names];
  }

  /**
   * The first live grant whose scope covers the call wins. When none does,
   * a live grant the call falls outside of is named first, because it alone
   * could still apply to a different input. Among the rest, the one whose
   * state most recently changed is named, by the timestamp of the spend,
   * revoke, or expiry that put it there: that is the grant the person most
   * recently acted on, and the one an approval card should explain. A
   * person who just pressed Revoke must not be told about the grant that
   * ran out an hour ago.
   */
  consult(
    capability: string,
    input: Record<string, unknown>,
    at: number,
  ): GrantConsultation {
    const candidates = this.list(at).filter((grant) => grant.capability === capability);
    if (candidates.length === 0) {
      return { kind: "none" };
    }
    let outside: ConsideredGrant | undefined;
    for (const grant of candidates) {
      if (grant.state !== "live") {
        continue;
      }
      const fit = matchesScope(grant.scope, input);
      if (fit.ok) {
        return { kind: "matched", grant };
      }
      outside ??= { id: grant.id, ...fit.why };
    }
    if (outside) {
      return { kind: "not_applied", grant: outside };
    }
    const settled = candidates
      .filter((grant) => grant.state !== "live")
      .sort((a, b) => {
        const byTime = changedAt(b) - changedAt(a);
        return byTime !== 0
          ? byTime
          : (this.changed.get(b.id) ?? 0) - (this.changed.get(a.id) ?? 0);
      });
    const latest = settled[0];
    if (latest === undefined) {
      // Every candidate is live and every live one matched or was recorded
      // above, so this line is unreachable; the type needs a return.
      return { kind: "none" };
    }
    return { kind: "not_applied", grant: { id: latest.id, outcome: latest.state } };
  }

  /**
   * Spends one use. Synchronous, so a caller that spends before its first
   * await holds the use before any concurrent call can read the count.
   * Returns nothing when the grant is not live, which is the caller's cue
   * to take the approval path rather than execute.
   */
  spend(id: string, at: number): Grant | undefined {
    const grant = this.get(id, at);
    if (grant === undefined || grant.state !== "live") {
      return undefined;
    }
    const remaining = grant.remaining - 1;
    const next: Grant =
      remaining === 0
        ? { ...grant, state: "exhausted", remaining: 0, exhaustedAt: at }
        : { ...grant, remaining };
    this.grants.set(id, deepFreeze(next));
    this.touch(id);
    return next;
  }

  revoke(
    id: string,
    by: HumanActor,
    at: number,
  ): { ok: true; grant: Grant } | { ok: false; reason: string } {
    const grant = this.get(id, at);
    if (grant === undefined) {
      return { ok: false, reason: `unknown grant: ${id}` };
    }
    if (grant.state !== "live") {
      return { ok: false, reason: `grant ${id} is ${grant.state}, and only a live grant can be revoked` };
    }
    const revoked: Grant = deepFreeze({
      ...grant,
      state: "revoked",
      revokedAt: at,
      revokedBy: { ...by },
    });
    this.grants.set(id, revoked);
    this.touch(id);
    return { ok: true, grant: revoked };
  }

  clear(): void {
    this.grants.clear();
    this.changed.clear();
  }

  private settle(grant: Grant, at: number): Grant {
    if (grant.state !== "live" || grant.expiresAt > at) {
      return grant;
    }
    const expired: Grant = deepFreeze({ ...grant, state: "expired", expiredAt: at });
    this.grants.set(grant.id, expired);
    this.touch(grant.id);
    return expired;
  }
}

/** When a grant entered its current state. A live grant's is its issue. */
function changedAt(grant: Grant): number {
  switch (grant.state) {
    case "live":
      return grant.issuedAt;
    case "exhausted":
      return grant.exhaustedAt;
    case "revoked":
      return grant.revokedAt;
    case "expired":
      return grant.expiredAt;
  }
}
