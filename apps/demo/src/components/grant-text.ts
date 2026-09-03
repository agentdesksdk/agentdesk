import type { Grant, GrantOutcome, StoredReceipt } from "@agentdesksdk/webmcp";

/** The one capability the order page issues grants for. */
export const REFUND_SHIPPING = "refund_shipping";

/**
 * A considered grant as the words see it: the shape the runtime sets on a
 * pending action and carries in an APPROVAL_REQUIRED result, with the
 * bound when the outcome has one. A missing bound is read off the grant's
 * own scope.
 */
export type ConsideredOutcome = {
  id: string;
  outcome: GrantOutcome["outcome"];
  field?: string;
  max?: number;
  min?: number;
};

/** The order an exact `order_id` rule pins a grant to, if it has one. */
export function grantOrderId(grant: Grant): string | undefined {
  const rule = grant.scope.find((r) => r.field === "order_id" && r.kind === "exact");
  return rule && rule.kind === "exact" ? String(rule.value) : undefined;
}

export function isGrantOnOrder(grant: Grant, orderId: string): boolean {
  return grantOrderId(grant) === orderId;
}

/** "refund_shipping" reads as "refund shipping". */
export function capabilityWords(name: string): string {
  return name.replace(/_/g, " ");
}

export function usesText(count: number): string {
  return `${count} use${count === 1 ? "" : "s"}`;
}

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function actorName(actor: { id: string; name?: string }): string {
  return actor.name ?? actor.id;
}

/**
 * What the agent may do right now without asking. With no live grant it
 * can read and propose, and every consequential call waits for a person.
 * Each live grant adds one clause, read from the snapshot every render,
 * as phrases: what, how many, where. A line breaks between phrases only.
 */
export function authorityClauses(grants: readonly Grant[]): string[][] {
  const live = grants.filter((grant) => grant.state === "live");
  if (live.length === 0) {
    return [["read + propose"]];
  }
  return live.map((grant) => {
    const parts = [capabilityWords(grant.capability), `≤ ${usesText(grant.remaining)}`];
    const orderId = grantOrderId(grant);
    if (orderId !== undefined) {
      parts.push(`on order ${orderId}`);
    }
    return parts;
  });
}

/** The clauses as one string: phrases joined by a space, clauses by a semicolon. */
export function authorityLine(grants: readonly Grant[]): string {
  return authorityClauses(grants)
    .map((parts) => parts.join(" "))
    .join("; ");
}

/** The mandate in one sentence, for the top of the card. */
export function grantSentence(grant: Grant): string {
  const what = capabilityWords(grant.capability);
  const orderId = grantOrderId(grant);
  const where = orderId === undefined ? "" : ` on order #${orderId}`;
  if (grant.state !== "live") {
    return `The agent may no longer ${what}${where} on its own: grant ${grant.id} is ${grant.state}.`;
  }
  return `The agent may ${what}${where} without asking, ${grant.remaining} of ${usesText(
    grant.uses,
  )} left, until ${fmtTime(grant.expiresAt)}.`;
}

/** The state as words. The card carries no colour that this does not also say. */
export function grantStateText(grant: Grant): string {
  switch (grant.state) {
    case "live":
      return `live, ${grant.remaining} of ${usesText(grant.uses)} left`;
    case "exhausted":
      return `exhausted, all ${usesText(grant.uses)} spent`;
    case "expired":
      return `expired, ${usesText(grant.remaining)} unused`;
    case "revoked":
      return `revoked by ${actorName(grant.revokedBy)}, ${usesText(grant.remaining)} unused`;
  }
}

/**
 * The Uses row. Live, what is left; exhausted, all spent; expired or
 * revoked, what went unused of what was granted, the way the State row
 * says it, since nothing is "left" of a grant that can no longer be used.
 */
export function grantUsesText(grant: Grant): string {
  switch (grant.state) {
    case "live":
      return `${grant.remaining} of ${usesText(grant.uses)} left`;
    case "exhausted":
      return `all ${usesText(grant.uses)} spent`;
    case "expired":
    case "revoked":
      return `${usesText(grant.remaining)} unused of ${grant.uses} granted`;
  }
}

function fieldWords(field: string): string {
  return field.replace(/_/g, " ");
}

function bound(grant: Grant | undefined, field: string): { min?: number; max?: number } {
  const rule = grant?.scope.find((r) => r.field === field && r.kind === "bound");
  return rule && rule.kind === "bound" ? rule : {};
}

/** Why the considered grant did not apply, as the predicate of "Grant X ...". */
export function outcomeWords(considered: ConsideredOutcome, grant?: Grant): string {
  const field = considered.field ?? "";
  switch (considered.outcome) {
    case "exhausted":
      return grant ? `is exhausted, all ${usesText(grant.uses)} spent` : "is exhausted";
    case "expired":
      return "expired before this call";
    case "revoked":
      return grant?.state === "revoked"
        ? `was revoked by ${actorName(grant.revokedBy)}`
        : "was revoked";
    case "missing_field":
      return `needs ${fieldWords(field)} on the call, and this call did not carry it`;
    case "out_of_scope": {
      const rule = grant?.scope.find((r) => r.field === field && r.kind === "exact");
      if (field === "order_id" && rule && rule.kind === "exact") {
        return `covers order ${String(rule.value)}, not this order id`;
      }
      return rule && rule.kind === "exact"
        ? `covers ${fieldWords(field)} ${String(rule.value)}, not this ${fieldWords(field)}`
        : `covers a different ${fieldWords(field)}`;
    }
    case "over_bound": {
      const max = considered.max ?? bound(grant, field).max;
      return max === undefined
        ? `allows less ${fieldWords(field)} than this call asked for`
        : `allows ${fieldWords(field)} up to ${max}, and this call asked for more`;
    }
    case "under_bound": {
      const min = considered.min ?? bound(grant, field).min;
      return min === undefined
        ? `allows more ${fieldWords(field)} than this call asked for`
        : `allows ${fieldWords(field)} down to ${min}, and this call asked for less`;
    }
  }
}

export function consideredGrantText(considered: ConsideredOutcome, grant?: Grant): string {
  return `Grant ${considered.id} was considered and did not apply: it ${outcomeWords(
    considered,
    grant,
  )}. A person decides.`;
}

export function grantIssuedAnnouncement(grant: Grant): string {
  const orderId = grantOrderId(grant);
  const where = orderId === undefined ? "" : ` on order #${orderId}`;
  return `Granted ${capabilityWords(grant.capability)}${where}: ${usesText(
    grant.uses,
  )} until ${fmtTime(grant.expiresAt)}, with no approval asked inside that.`;
}

export function grantRevokedAnnouncement(grant: Grant): string {
  const orderId = grantOrderId(grant);
  const where = orderId === undefined ? "" : ` on order #${orderId}`;
  return `Revoked grant ${grant.id}, ${usesText(grant.remaining)} unused. The next ${capabilityWords(
    grant.capability,
  )}${where} asks a person.`;
}

/** Read by the receipt view, so a change says which grant stood in for the approval. */
export function receiptAuthorityText(entry: StoredReceipt): string | undefined {
  return entry.grantId === undefined
    ? undefined
    : `Authorized by grant ${entry.grantId}, with no approval asked`;
}
