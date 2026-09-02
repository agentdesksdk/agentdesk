import { useEffect, useRef, useState } from "react";
import type { RuntimeSnapshot, ToolResult, Unreconciled } from "@agentdesk/webmcp";
import { armCommitFault, disarmCommitFault } from "../capabilities/staged.ts";
import { agentdesk } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import { useRuntime } from "./hooks.ts";

/** One key for the one call, so a second press is the same call again. */
export const durabilityKey = (orderId: string) => `durability-${orderId}`;

/**
 * What already existed when the call was sent, so a repeat is told apart
 * from a first attempt: an EXECUTION_INDETERMINATE naming an open record is
 * the guard refusing the same call, and an APPROVAL_REQUIRED naming a
 * pending approval is the repeat joining it. Both carry the same shape as
 * the first-time answer.
 */
type Prior = {
  open?: ReadonlySet<string>;
  pending?: ReadonlySet<string>;
};

/** What the attempt came back with, in words a judge can read. */
export function describeAttempt(result: ToolResult, prior: Prior = {}): string {
  const data = result.data ?? {};
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  switch (result.code) {
    case undefined:
      return "Completed: the refund landed and reported. No fault was armed for this commit.";
    case "APPROVAL_REQUIRED": {
      const actionId = String(data.approval_id ?? data.actionId ?? "");
      if (prior.pending?.has(actionId)) {
        return `Approval ${actionId} is still pending: the repeat joined it rather than opening a second one. Decide it on the approval card.`;
      }
      return `Approval requested (${actionId}). Approve it on the card: the commit will write and then throw, and the outcome is recorded as unknown.`;
    }
    case "EXECUTION_INDETERMINATE": {
      const recordId = String(data.record_id ?? "");
      if (prior.open?.has(recordId)) {
        return `Refused (EXECUTION_INDETERMINATE) because a previous call of this operation may already have written and record ${recordId} is still open. Nothing ran and no approval was asked. Settle it under Unreconciled outcomes in the Inspector.`;
      }
      return `Outcome unknown: ${String(data.detail ?? "")} Recorded as ${recordId}; see Unreconciled outcomes in the Inspector.`;
    }
    case "IDEMPOTENCY_CONFLICT":
      return `Refused (IDEMPOTENCY_CONFLICT, cause ${String(data.cause ?? "unknown")}) because ${reason ?? "this key was already used."}`;
    default:
      return `Refused (${result.code}${
        typeof data.reasonCode === "string" ? `, ${data.reasonCode}` : ""
      }) because ${reason ?? (typeof data.detail === "string" ? data.detail : "the runtime declined the call.")}`;
  }
}

/**
 * What the person's decision on the approval card came to, or undefined
 * while there is none yet. The decision reaches the runtime through that
 * card, not this one, so it is read from what the runtime kept: a record
 * bound to the action, a rejection of it, or the execution the approval
 * released, which is the first terminal event for the capability after the
 * approval in the audit. Pending alone does not answer: an action leaves it
 * to execute before its commit has run.
 */
export function describeDecision(
  actionId: string,
  records: readonly Unreconciled[],
  audit: RuntimeSnapshot["audit"],
): string | undefined {
  const record = records.find((r) => r.actionId === actionId);
  if (record !== undefined) {
    return `Approved (${actionId}), then the commit wrote and threw: outcome unknown. Recorded as ${record.id}; see Unreconciled outcomes in the Inspector.`;
  }
  if (audit.some((e) => e.kind === "approval_rejected" && e.actionId === actionId)) {
    return `Rejected (${actionId}) on the approval card. Nothing ran.`;
  }
  const approvedAt = audit.findIndex((e) => e.kind === "approval_approved" && e.actionId === actionId);
  if (approvedAt === -1) {
    return undefined;
  }
  for (const event of audit.slice(approvedAt + 1)) {
    if (event.kind === "execution_indeterminate" && event.capability === "refund_shipping") {
      return `Approved (${actionId}), then the commit wrote and threw: outcome unknown. Recorded as ${event.recordId}; see Unreconciled outcomes in the Inspector.`;
    }
    if (event.kind === "execution_completed" && event.capability === "refund_shipping") {
      return `Approved (${actionId}) and completed: the refund landed and reported, so no unknown outcome was recorded.`;
    }
    if (event.kind === "execution_failed" && event.capability === "refund_shipping") {
      return `Approved (${actionId}), and the execution failed before its write: ${event.error}`;
    }
  }
  return undefined;
}

/**
 * The judge-facing interruption. One press sends a shipping refund through
 * invoke_capability under a fixed idempotency key, with its commit armed to
 * write and then throw. The refund asks for approval; the person approves it
 * on the approval card, and the outcome is recorded as unknown. A reload
 * proves the record, the refusal of the same call, and Reconcile all
 * survive.
 */
export function DurabilityCard({ orderId }: { orderId: string }) {
  const snapshot = useRuntime();
  const { announcement, announce } = useAnnouncer();
  const [outcome, setOutcome] = useState("");
  /** The approval this card asked for and nobody has decided yet. */
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const open = agentdesk.listUnreconciled().filter((r) => r.capability === "refund_shipping");

  // Reset Demo. The audit only ever grows, or holds at its bound, except
  // when the runtime is reset, which empties it and emits before anything
  // is appended; a snapshot with a shorter audit than the last one seen is
  // that reset, and the card's last result goes with the state it described.
  const seenAudit = useRef(snapshot.audit.length);
  useEffect(() => {
    if (snapshot.audit.length < seenAudit.current) {
      setOutcome("");
      setAsked(undefined);
    }
    seenAudit.current = snapshot.audit.length;
  }, [snapshot.audit.length]);

  // The decision arrives on the approval card, so it is read off the first
  // snapshot that carries it, and announced once.
  useEffect(() => {
    if (asked === undefined) {
      return;
    }
    const words = describeDecision(asked, agentdesk.listUnreconciled(), snapshot.audit);
    if (words === undefined) {
      return;
    }
    setAsked(undefined);
    setOutcome(words);
    announce(words);
  }, [asked, snapshot, announce]);

  async function interrupt() {
    armCommitFault("refund_shipping");
    const prior: Prior = {
      open: new Set(agentdesk.listUnreconciled().map((r) => r.id)),
      pending: new Set(agentdesk.getSnapshot().pending.map((a) => a.id)),
    };
    // Sent the way a client sends it: by name, through invoke_capability,
    // with the idempotency key on the call rather than in the input.
    const result = await agentdesk.invoke("invoke_capability", {
      name: "refund_shipping",
      input: { order_id: orderId },
      idempotency_key: durabilityKey(orderId),
    });
    const actionId = result.code === "APPROVAL_REQUIRED" ? result.data?.approval_id : undefined;
    if (typeof actionId === "string") {
      // The commit runs when the person approves, so the fault stays armed.
      setAsked(actionId);
    } else {
      // Either the commit already ran and consumed the fault, or the call
      // was refused before staging; a fault left armed would fire on
      // whichever refund came next.
      disarmCommitFault("refund_shipping");
    }
    const words = describeAttempt(result, prior);
    setOutcome(words);
    announce(words);
  }

  return (
    <div
      className="panel durability-card"
      role="region"
      aria-label={`Interrupted operations on order #${orderId}`}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2>Interrupt and recover</h2>
      <p className="page-sub" style={{ marginBottom: 10 }}>
        One press sends a shipping refund through invoke_capability with the
        idempotency key <code>{durabilityKey(orderId)}</code>, its commit
        armed to write and then throw. The refund asks for approval; approve
        it on the card, and the outcome is recorded as unknown. Reload the
        page: the record is still listed in the Inspector, pressing again is
        refused in words without asking for approval again, and Reconcile
        settles it. Under a live grant from the authority card above, the
        same press runs without an approval.
      </p>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button
          type="button"
          className="primary"
          aria-label={`Interrupt a shipping refund on order #${orderId}`}
          onClick={() => void interrupt()}
        >
          Interrupt a refund
        </button>
      </div>
      <p className="durability-result" data-durability-result>
        {outcome}
      </p>
      {open.length > 0 ? (
        <p className="page-sub" style={{ marginBottom: 0 }}>
          {open.length === 1 ? "One unknown outcome is" : `${open.length} unknown outcomes are`}{" "}
          listed in the Inspector under Unreconciled outcomes.
        </p>
      ) : null}
    </div>
  );
}
