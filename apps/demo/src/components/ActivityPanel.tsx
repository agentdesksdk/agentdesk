import type { AuditEvent, Receipt } from "@agentdesk/webmcp";
import { render } from "./ApprovalCards.tsx";
import { useRuntime } from "./hooks.ts";

type Rendered = {
  key: string;
  at: number;
  head: string;
  cap?: string;
  risk?: string;
  meta?: string;
  receipt?: Receipt;
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
    }
  }
  flush();
  return out.reverse();
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

export function ActivityPanel() {
  const snapshot = useRuntime();
  const rows = collapse(snapshot.audit).slice(0, 80);
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
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
