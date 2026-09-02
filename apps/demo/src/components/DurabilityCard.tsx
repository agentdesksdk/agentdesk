import { useState } from "react";
import type { ToolResult } from "@agentdesk/webmcp";
import { armCommitFault } from "../capabilities/staged.ts";
import { agentdesk, OPERATOR } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import { useRuntime } from "./hooks.ts";

/** One key for the one call, so a second press is the same call again. */
export const durabilityKey = (orderId: string) => `durability-${orderId}`;

/**
 * What the attempt came back with, in words a judge can read. `openBefore`
 * is the set of unreconciled record ids that existed before the call: an
 * EXECUTION_INDETERMINATE naming one of them is the guard refusing the same
 * call, not a new unknown outcome, and the two carry the same shape.
 */
export function describeAttempt(result: ToolResult, openBefore: ReadonlySet<string> = new Set()): string {
  const data = result.data ?? {};
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  switch (result.code) {
    case undefined:
      return "Completed: the refund landed and reported. No fault was armed for this commit.";
    case "APPROVAL_REQUIRED":
      return `Approval requested (${String(data.approval_id ?? data.actionId ?? "")}). Approve it: the commit will write and then fail, and the outcome is recorded as unknown.`;
    case "EXECUTION_INDETERMINATE": {
      const recordId = String(data.record_id ?? "");
      if (openBefore.has(recordId)) {
        return `Refused (EXECUTION_INDETERMINATE) because a previous call of this operation may already have written and record ${recordId} is still open. Nothing ran. Settle it under Unreconciled outcomes in the Inspector.`;
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
 * The judge-facing interruption. One press runs a shipping refund whose
 * commit writes and then throws, under a fixed idempotency key. The person
 * approves it, the outcome is recorded as unknown, and a reload proves the
 * record, the refusal of the same call, and Reconcile all survive.
 */
export function DurabilityCard({ orderId }: { orderId: string }) {
  useRuntime();
  const { announcement, announce } = useAnnouncer();
  const [outcome, setOutcome] = useState("");
  const open = agentdesk.listUnreconciled().filter((r) => r.capability === "refund_shipping");

  /**
   * The operator's mandate, issued on this click when none is live. Under
   * a grant the call takes the path the runtime guards by operation key and
   * by idempotency claim; through an approval it is not, and the record
   * then names the grant that authorized the write.
   */
  function ensureGrant(): string | undefined {
    const live = agentdesk
      .getSnapshot()
      .grants.find(
        (g) =>
          g.state === "live" &&
          g.capability === "refund_shipping" &&
          g.scope.some(
            (r) => r.field === "order_id" && r.kind === "exact" && String(r.value) === orderId,
          ),
      );
    if (live !== undefined) {
      return undefined;
    }
    const issued = agentdesk.grant(
      {
        capability: "refund_shipping",
        scope: { order_id: orderId },
        uses: 2,
        expiresAt: Date.now() + 10 * 60_000,
      },
      OPERATOR,
    );
    return issued.ok ? undefined : issued.reason;
  }

  async function interrupt() {
    const refused = ensureGrant();
    if (refused !== undefined) {
      const words = `Could not issue the grant: ${refused}`;
      setOutcome(words);
      announce(words);
      return;
    }
    armCommitFault("refund_shipping");
    // Sent the way a client sends it: by name, through invoke_capability,
    // with the idempotency key on the call rather than in the input.
    const openBefore = new Set(agentdesk.listUnreconciled().map((r) => r.id));
    const result = await agentdesk.invoke("invoke_capability", {
      name: "refund_shipping",
      input: { order_id: orderId },
      idempotency_key: durabilityKey(orderId),
    });
    const words = describeAttempt(result, openBefore);
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
        One press issues a two-use grant for refund_shipping on this order, so
        no approval card stands in the way, then runs the refund through
        invoke_capability with the idempotency key{" "}
        <code>{durabilityKey(orderId)}</code>, with its commit armed to write
        and then throw. Reload the page: the unknown outcome is still listed in
        the Inspector, pressing again is refused in words, and Reconcile
        settles it.
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
