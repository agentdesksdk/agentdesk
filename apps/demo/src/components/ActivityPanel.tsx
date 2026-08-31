import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  Actor,
  AffectedObject,
  AuditEvent,
  Receipt,
  VerificationResult,
} from "@agentdesk/webmcp";
import { useAnnouncer } from "./announcer.ts";
import { render } from "./ApprovalCards.tsx";
import { useRuntime } from "./hooks.ts";
import {
  describeAction,
  reviewRefusedAnnouncement,
  reviewedAnnouncement,
  rollbackRefusedAnnouncement,
  rolledBackAnnouncement,
} from "./receipt-text.ts";
import { revealTarget } from "./reveal.ts";
import { agentdesk, OPERATOR as SHARED_OPERATOR } from "../runtime/agentdesk.ts";

type Rendered = {
  key: string;
  at: number;
  head: string;
  cap?: string;
  risk?: string;
  meta?: string;
  receipt?: Receipt;
  executionId?: string;
};

function collapse(events: readonly AuditEvent[]): Rendered[] {
  const out: Rendered[] = [];
  let toolBatch: { kind: "tool_registered" | "tool_retired"; count: number; at: number } | null =
    null;
  let index = 0;

  const flush = () => {
    if (toolBatch) {
      out.push({
        key: `batch-${index++}`,
        at: toolBatch.at,
        head:
          toolBatch.kind === "tool_registered"
            ? `${toolBatch.count} tool${toolBatch.count === 1 ? "" : "s"} registered`
            : `${toolBatch.count} tool${toolBatch.count === 1 ? "" : "s"} retired`,
      });
      toolBatch = null;
    }
  };

  for (const event of events) {
    if (event.kind === "tool_registered" || event.kind === "tool_retired") {
      if (toolBatch && toolBatch.kind === event.kind) {
        toolBatch.count += 1;
        toolBatch.at = event.at;
      } else {
        flush();
        toolBatch = { kind: event.kind, count: 1, at: event.at };
      }
      continue;
    }
    flush();
    const key = `ev-${index++}`;
    switch (event.kind) {
      case "context_changed":
        out.push({
          key,
          at: event.at,
          head: "Context changed",
          meta: `${event.route} · ${event.exposure === "flat" ? "baseline" : "agentdesk"}`,
        });
        break;
      case "capability_routed":
        out.push({
          key,
          at: event.at,
          head: "Task routed",
          meta: `${event.catalogSize} capabilities searched · ${event.activated.length} activated${event.query ? ` · “${event.query}”` : ""}`,
        });
        break;
      case "capability_invoked":
        out.push({
          key,
          at: event.at,
          head: "Invoked",
          cap: event.capability,
          risk: event.risk,
          meta: `via ${event.via}`,
        });
        break;
      case "capability_unavailable":
        out.push({
          key,
          at: event.at,
          head: "Unavailable",
          cap: event.capability,
          meta: event.reasonCode,
        });
        break;
      case "approval_requested":
        out.push({
          key,
          at: event.at,
          head: "Approval required",
          cap: event.capability,
          risk: event.risk,
          meta: event.summary,
        });
        break;
      case "approval_approved":
        out.push({ key, at: event.at, head: "Human approved", meta: event.actionId });
        break;
      case "approval_rejected":
        out.push({ key, at: event.at, head: "Human rejected", meta: event.actionId });
        break;
      case "execution_started":
        break;
      case "execution_completed": {
        const row: Rendered = {
          key,
          at: event.at,
          head: "Success",
          cap: event.capability,
          executionId: event.executionId,
        };
        if (event.receipt) {
          row.receipt = event.receipt;
        }
        out.push(row);
        break;
      }
      case "execution_failed":
        out.push({
          key,
          at: event.at,
          head: "Failed",
          cap: event.capability,
          meta: event.error,
        });
        break;
      case "plan_prepared":
        out.push({
          key,
          at: event.at,
          head: `Plan prepared · ${event.operations.length} operation${event.operations.length === 1 ? "" : "s"}`,
          risk: event.risk,
          meta: event.operations.join(", "),
        });
        break;
      case "plan_approved":
        out.push({ key, at: event.at, head: "Human approved plan", meta: event.planId });
        break;
      case "plan_rejected":
        out.push({ key, at: event.at, head: "Human rejected plan", meta: event.planId });
        break;
      case "plan_drifted":
        out.push({
          key,
          at: event.at,
          head: "Plan refused, application changed after review",
          meta: event.planId,
        });
        break;
      case "plan_committed":
        out.push({ key, at: event.at, head: "Plan committed", meta: event.planId });
        break;
      case "plan_partial":
        out.push({
          key,
          at: event.at,
          head: "Plan partly committed",
          meta: event.outcomes
            .filter(
              (o) => o.status === "SKIPPED" || o.verification === "MISMATCH",
            )
            .map((o) =>
              o.status === "SKIPPED"
                ? `${o.capability} skipped`
                : `${o.capability} not verified`,
            )
            .join(", "),
        });
        break;
      case "plan_failed":
        out.push({
          key,
          at: event.at,
          head: "Plan failed",
          meta: event.outcomes
            .filter((o) => o.status === "FAILED")
            .map((o) => o.capability)
            .join(", "),
        });
        break;
      case "rollback_performed":
        out.push({
          key,
          at: event.at,
          head: "Rolled back",
          cap: event.capability,
          meta: event.receiptId,
        });
        break;
      case "rollback_indeterminate":
        out.push({
          key,
          at: event.at,
          head: "Undo outcome unknown",
          cap: event.capability,
          meta: event.receiptId,
        });
        break;
      case "rollback_reconciled":
        out.push({
          key,
          at: event.at,
          head:
            event.outcome === "compensated"
              ? "Reconciled as undone"
              : "Reconciled as untouched",
          cap: event.capability,
          meta: event.receiptId,
        });
        break;
      case "receipt_reviewed":
        out.push({
          key,
          at: event.at,
          head: "Reviewed",
          cap: event.capability,
          meta: event.receiptId,
        });
        break;
      case "policy_denied":
        out.push({
          key,
          at: event.at,
          head: "Policy denied",
          cap: event.capability,
          meta: event.reason,
        });
        break;
      case "execution_indeterminate":
        out.push({
          key,
          at: event.at,
          head: "Outcome unknown",
          cap: event.capability,
          meta: `${event.detail} · ${event.recordId} awaits reconciliation`,
        });
        break;
      case "staged_cleanup_failed":
        out.push({
          key,
          at: event.at,
          head: "Cleanup failed",
          cap: event.capability,
          meta: `${event.detail} · ${event.recordId} left open`,
        });
        break;
      case "staged_reconciled":
        out.push({
          key,
          at: event.at,
          head: event.outcome === "applied" ? "Reconciled as applied" : "Reconciled as not applied",
          cap: event.capability,
          meta: `${event.recordId} closed by ${event.actor.name ?? event.actor.id}`,
        });
        break;
      // A new audit kind has to get a case above; this stops it compiling
      // rather than letting it vanish from the panel.
      default: {
        const unhandled: never = event;
        void unhandled;
      }
    }
  }
  flush();
  return out.reverse();
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

/**
 * The person at the keyboard. A real deployment reads this from the session;
 * the demo has one operator, but the review still has to be signed by a human
 * rather than by the agent whose work is being reviewed.
 */
const OPERATOR = SHARED_OPERATOR;

const AFFECTED_ROUTE: Record<string, (id: string) => string> = {
  order: (id) => `/orders/${id}`,
};

function receiptSectionId(receiptId: string): string {
  return `receipt-${receiptId}`;
}

function verificationLabel(result: VerificationResult): string {
  switch (result.status) {
    case "VERIFIED":
      return "Verified against application state";
    case "PARTIAL":
      return `Partly verified · ${result.unverified.join(", ")}`;
    case "MISMATCH":
      return `Mismatch on ${result.field} · expected ${render(result.expected)}, read back ${render(result.observed)}`;
    case "UNSUPPORTED":
      return "No verifier declared";
  }
}

export function ActivityPanel() {
  const snapshot = useRuntime();
  const navigate = useNavigate();
  const { mode } = useParams();
  const revealTimer = useRef<number | undefined>(undefined);
  const { announcement, announce } = useAnnouncer();
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const rows = collapse(snapshot.audit).slice(0, 80);
  const stored = new Map(
    agentdesk.queryReceipts().map((entry) => [entry.executionId, entry]),
  );

  // Both actions replace the button that held focus with a static span, so
  // focus has to be placed on the surviving receipt before the browser
  // drops it to document.body.
  useEffect(() => {
    if (pendingFocus === null) {
      return;
    }
    document.getElementById(receiptSectionId(pendingFocus))?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  function goToAffected(object: AffectedObject) {
    const route = AFFECTED_ROUTE[object.kind]?.(object.id);
    if (!route) {
      return;
    }
    navigate(`/${mode ?? "agentdesk"}${route}`);
    if (object.reveal) {
      revealTarget(object.reveal, revealTimer, { highlight: true, focus: true });
    }
  }

  return (
    <div className="activity">
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="rail-section" style={{ borderBottom: "none", padding: "14px 0 4px" }}>
        <h3>AgentDesk activity</h3>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          No activity yet. Connect a WebMCP client or route a task to begin.
        </div>
      ) : (
        rows.map((row) => {
          const entry = row.executionId ? stored.get(row.executionId) : undefined;
          return (
            <div key={row.key} className="event">
              <time>{clock(row.at)}</time>
              <div className="what">
                <div>
                  {row.cap ? <span className="cap">{row.cap} </span> : null}
                  {row.risk ? <span className={`risk ${row.risk}`}>{row.risk}</span> : null}
                  {row.cap || row.risk ? " " : null}
                  {row.head}
                </div>
                {row.meta ? <div className="meta">{row.meta}</div> : null}
                {row.receipt ? (
                  <section
                    className="receipt"
                    id={entry ? receiptSectionId(entry.id) : undefined}
                    tabIndex={-1}
                    aria-label={`Receipt for ${row.receipt.entity}`}
                  >
                    <div className="receipt-head">
                      Receipt · {row.receipt.entity}
                    </div>
                    {row.receipt.changes.map((change) => (
                      <div key={change.field} className="change-row">
                        <span className="field">{change.field}</span>
                        <span className="before">{render(change.before)}</span>
                        <span className="arrow">→</span>
                        <span className="after">{render(change.after)}</span>
                      </div>
                    ))}
                    {(() => {
                      if (!entry) {
                        return null;
                      }
                      const action = describeAction(entry);
                      return (
                        <div className="receipt-foot">
                          <span
                            className={`verify ${entry.verification.status}`}
                            title={verificationLabel(entry.verification)}
                          >
                            {verificationLabel(entry.verification)}
                          </span>
                          <div className="receipt-actions">
                            {(entry.receipt.affected ?? []).map((object) => (
                              <button
                                key={`${object.kind}-${object.id}`}
                                type="button"
                                className="undo"
                                aria-label={`Go to ${object.label}, changed by ${entry.capability.replace(/_/g, " ")}`}
                                onClick={() => goToAffected(object)}
                              >
                                {object.label}
                              </button>
                            ))}
                            {entry.reviewedAt !== undefined ? (
                              <span className="undone">Reviewed</span>
                            ) : (
                              <button
                                type="button"
                                className="undo"
                                aria-label={`Mark ${action} reviewed`}
                                onClick={() => {
                                  const outcome = agentdesk.markReviewed(
                                    entry.id,
                                    OPERATOR,
                                  );
                                  announce(
                                    outcome.ok
                                      ? reviewedAnnouncement(entry)
                                      : reviewRefusedAnnouncement(
                                          entry,
                                          outcome.reason,
                                        ),
                                  );
                                  setPendingFocus(entry.id);
                                }}
                              >
                                Mark reviewed
                              </button>
                            )}
                            {entry.rolledBackAt !== undefined ? (
                              <span className="undone">Rolled back</span>
                            ) : entry.rollbackState === "INDETERMINATE" ? (
                              <span className="unreconciled">
                                Undo outcome unknown
                              </span>
                            ) : entry.receipt.undoable !== true ? null : (
                              <button
                                type="button"
                                className="undo"
                                aria-label={`Undo ${action}`}
                                onClick={() => {
                                  void agentdesk.rollback(entry.id).then((outcome) => {
                                    announce(
                                      outcome.ok
                                        ? rolledBackAnnouncement(entry)
                                        : rollbackRefusedAnnouncement(
                                            entry,
                                            outcome.reason,
                                          ),
                                    );
                                    setPendingFocus(entry.id);
                                  });
                                }}
                              >
                                Undo
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </section>
                ) : null}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
