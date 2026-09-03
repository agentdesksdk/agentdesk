import { useEffect, useRef, useState } from "react";
import type { AuditEvent, Unreconciled } from "@agentdesksdk/webmcp";
import { armCommitFault, disarmCommitFault } from "../capabilities/staged.ts";
import { agentdesk } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import { useRuntime } from "./hooks.ts";

/** One key for the one call, so the client's second call is the same call again. */
export const durabilityKey = (orderId: string) => `durability-${orderId}`;

/** The prompt a person gives their WebMCP client. The page shows it and does nothing with it. */
export const durabilityPrompt = (orderId: string) =>
  `Refund the shipping on order ${orderId} with idempotency key ${durabilityKey(orderId)}`;

const CAPABILITY = "refund_shipping";

export type DurabilityStep = { key: string; words: string };

/**
 * What the runtime recorded about the client's refund calls, in words.
 * The page is not the caller, so it reads the audit: each `capability_invoked`
 * for the refund opens a call, and what follows it before the next call
 * says how it went. The runtime writes no event for a refusal by the
 * open-record guard or by a surviving idempotency claim; a call that
 * nothing follows was refused before anything was staged, and the open
 * record, when there is one, is the reason it names.
 */
export function describeFromAudit(
  audit: readonly AuditEvent[],
  records: readonly Unreconciled[],
  orderId: string,
): { status: string; steps: DurabilityStep[] } {
  const open = records.filter((r) => r.capability === CAPABILITY);
  const steps: DurabilityStep[] = [];
  const starts = audit
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "capability_invoked" && event.capability === CAPABILITY);

  starts.forEach(({ index }, n) => {
    const end = n + 1 < starts.length ? starts[n + 1]!.index : audit.length;
    const window = audit.slice(index + 1, end);
    const key = `call-${index}`;
    const requested = window.find((e) => e.kind === "approval_requested" && e.capability === CAPABILITY);
    if (requested?.kind === "approval_requested") {
      steps.push({ key, words: `The client's keyed call arrived: approval ${requested.actionId} requested. Decide it on the card.` });
      if (window.some((e) => e.kind === "approval_rejected" && e.actionId === requested.actionId)) {
        steps.push({ key: `${key}-rejected`, words: `Rejected (${requested.actionId}) on the approval card. Nothing ran.` });
        return;
      }
      if (window.some((e) => e.kind === "approval_approved" && e.actionId === requested.actionId)) {
        const unknown = window.find((e) => e.kind === "execution_indeterminate" && e.capability === CAPABILITY);
        const completed = window.some((e) => e.kind === "execution_completed" && e.capability === CAPABILITY);
        const failed = window.find((e) => e.kind === "execution_failed" && e.capability === CAPABILITY);
        if (unknown?.kind === "execution_indeterminate") {
          steps.push({
            key: `${key}-unknown`,
            words: `Approved (${requested.actionId}), then the commit wrote and threw: outcome unknown, recorded as ${unknown.recordId}. See Unreconciled outcomes in the Inspector.`,
          });
        } else if (completed) {
          steps.push({ key: `${key}-done`, words: `Approved (${requested.actionId}) and completed: the refund landed and reported.` });
        } else if (failed?.kind === "execution_failed") {
          steps.push({ key: `${key}-failed`, words: `Approved (${requested.actionId}), and the execution failed before its write: ${failed.error}` });
        } else {
          steps.push({ key: `${key}-approved`, words: `Approved (${requested.actionId}); executing.` });
        }
      }
      return;
    }
    if (window.some((e) => e.kind === "execution_started" && e.capability === CAPABILITY)) {
      const unknown = window.find((e) => e.kind === "execution_indeterminate" && e.capability === CAPABILITY);
      steps.push({
        key,
        words:
          unknown?.kind === "execution_indeterminate"
            ? `The client's call ran under a grant; the commit wrote and threw: outcome unknown, recorded as ${unknown.recordId}.`
            : "The client's call ran under a grant, with no approval asked.",
      });
      return;
    }
    if (window.some((e) => e.kind === "capability_unavailable" && e.capability === CAPABILITY)) {
      const why = window.find((e) => e.kind === "capability_unavailable" && e.capability === CAPABILITY);
      steps.push({ key, words: `The client's call was refused: ${why?.kind === "capability_unavailable" ? why.reasonCode : "unavailable"}.` });
      return;
    }
    const still = open[0];
    steps.push({
      key,
      words:
        still !== undefined
          ? `The client's repeat was refused: record ${still.id} is still open, so no approval was asked and nothing ran. Settle it under Unreconciled outcomes.`
          : "The client's repeat was answered from the idempotency claim on its key: no approval was asked and nothing ran. After a restart the same key is refused as IDEMPOTENCY_CONFLICT.",
    });
  });

  const last = steps[steps.length - 1];
  if (last !== undefined) {
    return { status: last.words, steps };
  }
  if (open.length > 0) {
    return {
      status: `Record ${open[0]!.id} survived the reload and waits under Unreconciled outcomes; the client's repeat of order ${orderId} will be refused until it is settled.`,
      steps,
    };
  }
  return { status: "Waiting for a WebMCP agent.", steps };
}

async function copyPrompt(orderId: string, say: (words: string) => void) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(durabilityPrompt(orderId));
      say("Copied. Paste it into your WebMCP client.");
      return;
    }
  } catch {
    // the words below cover it
  }
  say("Select the prompt and copy it; the clipboard is not available here.");
}

/**
 * The judge-facing interruption, as the page's part of it: a chaos switch
 * that arms the next refund_shipping commit to write and then throw, the
 * prompt a client is given, and what the runtime records as that client's
 * call arrives, is approved, fails to report, survives a reload, and is
 * refused again. Nothing here sends the refund.
 */
export function DurabilityCard({ orderId }: { orderId: string }) {
  const snapshot = useRuntime();
  const { announcement, announce } = useAnnouncer();
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState("");
  const records = agentdesk.listUnreconciled();
  const { status, steps } = describeFromAudit(snapshot.audit, records, orderId);

  // Reset Demo empties the audit and emits before anything is appended; a
  // snapshot with a shorter audit than the last one seen is that reset, and
  // the store's own reset has already cleared the fault.
  const seenAudit = useRef(snapshot.audit.length);
  useEffect(() => {
    if (snapshot.audit.length < seenAudit.current) {
      setArmed(false);
      setNote("");
    }
    seenAudit.current = snapshot.audit.length;
  }, [snapshot.audit.length]);

  // The fault fires once, at the commit; once an unknown outcome is recorded
  // the switch reads disarmed again, because it is.
  const lastUnknown = [...snapshot.audit].reverse().find((e) => e.kind === "execution_indeterminate" && e.capability === CAPABILITY);
  const unknownAt = lastUnknown?.at;
  useEffect(() => {
    if (unknownAt !== undefined) {
      setArmed(false);
    }
  }, [unknownAt]);

  // Each new status is announced once, as the runtime records it.
  const spoken = useRef(status);
  useEffect(() => {
    if (status !== spoken.current) {
      spoken.current = status;
      announce(status);
    }
  }, [status, announce]);

  function toggleFault() {
    if (armed) {
      disarmCommitFault(CAPABILITY);
      setArmed(false);
      announce("Commit fault disarmed.");
    } else {
      armCommitFault(CAPABILITY);
      setArmed(true);
      announce("Commit fault armed: the next refund_shipping commit will write and then throw.");
    }
  }

  return (
    <div className="panel durability-card" role="region" aria-label={`Interrupted operations on order #${orderId}`}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2>Interrupt and recover</h2>
      <p className="page-sub" style={{ marginBottom: 10 }}>
        Arm the commit fault, then give your WebMCP client the prompt below. The refund asks for approval; approve it on
        the card, and the commit writes and then throws, so the outcome is recorded as unknown. Reload the page: the
        record is still listed in the Inspector, the client's repeat is refused in words without asking again, and
        Reconcile settles it.
      </p>
      <div className="actions" style={{ justifyContent: "flex-start", gap: 8 }}>
        <button
          type="button"
          className={armed ? "primary" : undefined}
          aria-pressed={armed}
          aria-label={`Commit fault: ${armed ? "armed" : "disarmed"}. ${armed ? "Disarm it" : "Arm it: the next refund_shipping commit writes, then throws"}`}
          onClick={toggleFault}
        >
          Commit fault: {armed ? "armed" : "disarmed"}
        </button>
      </div>
      <p className="page-sub" style={{ margin: "10px 0 4px" }}>
        The prompt a client is given, with the idempotency key <code>{durabilityKey(orderId)}</code> on the call:
      </p>
      <blockquote className="durability-prompt" data-durability-prompt>
        {durabilityPrompt(orderId)}
      </blockquote>
      <div className="actions" style={{ justifyContent: "flex-start", gap: 8 }}>
        <button type="button" onClick={() => void copyPrompt(orderId, setNote)}>
          Copy prompt
        </button>
        <span className="page-sub" style={{ margin: 0 }}>
          {note}
        </span>
      </div>
      <p className="durability-result" data-agent-status>
        {status}
      </p>
      {steps.length > 1 ? (
        <ol className="durability-steps" aria-label="What the runtime recorded for this refund">
          {steps.map((step) => (
            <li key={step.key} data-durability-step>
              {step.words}
            </li>
          ))}
        </ol>
      ) : steps.length === 1 ? (
        <ol className="durability-steps" aria-label="What the runtime recorded for this refund">
          <li data-durability-step>{steps[0]!.words}</li>
        </ol>
      ) : null}
    </div>
  );
}
