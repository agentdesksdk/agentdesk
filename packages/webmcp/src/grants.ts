import type { CapabilityName } from "./capability.ts";
import type { HumanActor } from "./plan.ts";

/**
 * Scoped authority grants. A person approves a bounded mandate once, and
 * the runtime spends it one execution at a time instead of asking for an
 * approval on every call.
 *
 * A grant narrows approval and never widens policy. It is consulted only
 * where policy says `require_approval`; under `deny` nothing executes, and
 * under `allow` a grant is never consulted and records nothing.
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

export type GrantRefusalCode =
  | "GRANT_EXHAUSTED"
  | "GRANT_EXPIRED"
  | "GRANT_REVOKED"
  | "GRANT_OUT_OF_SCOPE";

/**
 * What consulting the grants for one call says. `none` means no grant was
 * ever issued for the capability, so the ordinary approval gate applies.
 * `refused` means grants exist and none authorizes this call; the grant
 * named is the one whose state explains why.
 */
export type GrantConsultation =
  | { kind: "none" }
  | { kind: "matched"; grant: LiveGrant }
  | {
      kind: "refused";
      grant: Grant;
      reasonCode: GrantRefusalCode;
      reason: string;
    };
