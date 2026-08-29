import type { StoredReceipt } from "@agentdesk/webmcp";

/** Reads as a phrase in an aria-label: "Undo refund shipping on Order #10428". */
export function describeAction(entry: StoredReceipt): string {
  return `${entry.capability.replace(/_/g, " ")} on ${entry.receipt.entity}`;
}

function opening(entry: StoredReceipt): string {
  const action = describeAction(entry);
  return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

export function reviewedAnnouncement(entry: StoredReceipt): string {
  return `Marked reviewed. ${opening(entry)}.`;
}

export function reviewRefusedAnnouncement(
  entry: StoredReceipt,
  reason: string,
): string {
  return `Could not mark ${describeAction(entry)} reviewed. ${reason}`;
}

export function rolledBackAnnouncement(entry: StoredReceipt): string {
  return `Rolled back ${describeAction(entry)}.`;
}

export function rollbackRefusedAnnouncement(
  entry: StoredReceipt,
  reason: string,
): string {
  return `Could not roll back ${describeAction(entry)}. ${reason}`;
}
