import type { AuditEvent, Grant, GrantOutcome, StoredReceipt } from "@agentdesk/webmcp";

/** The one capability the order page issues grants for. */
export const REFUND_SHIPPING = "refund_shipping";

export type NotApplied = Extract<AuditEvent, { kind: "grant_not_applied" }>;

/** A considered grant as the approval card sees it: the audit shape, plus the bounds a result would carry. */
export type ConsideredOutcome = {
  grantId: string;
  outcome: GrantOutcome["outcome"];
  field?: string;
  max?: number;
  min?: number;
};

export function grantOrderId(_grant: Grant): string | undefined {
  return undefined;
}

export function isGrantOnOrder(_grant: Grant, _orderId: string): boolean {
  return false;
}

export function capabilityWords(name: string): string {
  return name;
}

export function usesText(count: number): string {
  return String(count);
}

export function fmtTime(_at: number): string {
  return "";
}

export function authorityLine(_grants: readonly Grant[]): string {
  return "read + propose";
}

export function grantSentence(_grant: Grant): string {
  return "";
}

export function grantStateText(_grant: Grant): string {
  return "";
}

export function outcomeWords(_considered: ConsideredOutcome, _grant?: Grant): string {
  return "";
}

export function consideredGrantText(_considered: ConsideredOutcome, _grant?: Grant): string {
  return "";
}

export function consideredGrantFor(
  _actionId: string,
  _capability: string,
  _audit: readonly AuditEvent[],
): NotApplied | undefined {
  return undefined;
}

export function grantIssuedAnnouncement(_grant: Grant): string {
  return "";
}

export function grantRevokedAnnouncement(_grant: Grant): string {
  return "";
}

export function receiptAuthorityText(_entry: StoredReceipt): string | undefined {
  return undefined;
}
