import type { AuditEvent, Receipt, VerificationResult } from "@agentdesk/webmcp";
import { render } from "./ApprovalCards.tsx";
import { useRuntime } from "./hooks.ts";
import { agentdesk } from "../runtime/agentdesk.ts";

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
    }
  }
  flush();
  return out.reverse();
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
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
  const rows = collapse(snapshot.audit).slice(0, 80);
  const stored = new Map(
    agentdesk.queryReceipts().map((entry) => [entry.executionId, entry]),
  );
  return (
    <div className="activity">
      <div className="rail-section" style={{ borderBottom: "none", padding: "14px 0 4px" }}>
        <h3>AgentDesk activity</h3>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          No activity yet. Connect a WebMCP client or route a task to begin.
        </div>
      ) : (
        rows.map((row) => (
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
                <div className="receipt">
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
                    const entry = row.executionId
                      ? stored.get(row.executionId)
                      : undefined;
                    if (!entry) {
                      return null;
                    }
                    return (
                      <div className="receipt-foot">
                        <span
                          className={`verify ${entry.verification.status}`}
                          title={verificationLabel(entry.verification)}
                        >
                          {verificationLabel(entry.verification)}
                        </span>
                        {entry.rolledBackAt !== undefined ? (
                          <span className="undone">Rolled back</span>
                        ) : entry.receipt.undoable !== true ? null : (
                          <button
                            type="button"
                            className="undo"
                            onClick={() => {
                              void agentdesk.rollback(entry.id);
                            }}
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
