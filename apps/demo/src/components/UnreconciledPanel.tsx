import { useState } from "react";
import type { StagedResolution, Unreconciled } from "@agentdesk/webmcp";
import { agentdesk, demoPersistence, OPERATOR } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import { render } from "./ApprovalCards.tsx";
import { useRuntime } from "./hooks.ts";

function kindWords(kind: Unreconciled["kind"]): string {
  return kind === "commit_indeterminate" ? "commit outcome unknown" : "cleanup failed";
}

function authorityWords(record: Unreconciled): string {
  if (record.grantId !== undefined) {
    return `grant ${record.grantId}, no approval asked`;
  }
  if (record.actionId !== undefined) {
    return `approval ${record.actionId}, approved by a person`;
  }
  return "approved by a person";
}

function actorWords(record: Unreconciled): string {
  const actor = record.executedBy;
  if (actor === undefined) {
    return "unknown";
  }
  return `${actor.name ?? actor.id} (${actor.kind})`;
}

function resolutionWords(resolution: StagedResolution): string {
  switch (resolution.kind) {
    case "commit_applied":
      return "the write landed";
    case "commit_not_applied":
      return "the write did not land";
    case "cleanup_disposed":
      return "the cleanup is disposed";
  }
}

const fmtTime = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Outcomes nobody can call settled, read from the runtime on every snapshot.
 * Everything the record carried is text; the two Reconcile controls record
 * what a person found, through the runtime, which audits it and settles the
 * fork the staging adapter rebuilt.
 */
export function UnreconciledPanel() {
  useRuntime();
  const { announcement, announce } = useAnnouncer();
  const [refusal, setRefusal] = useState<string | null>(null);
  const records = agentdesk.listUnreconciled();

  function settle(record: Unreconciled, resolution: StagedResolution) {
    const outcome = agentdesk.reconcile(record.id, resolution, OPERATOR);
    if (outcome.ok) {
      setRefusal(null);
      announce(
        `Reconciled ${record.id}: ${resolutionWords(resolution)}. The record is settled and no longer listed.`,
      );
    } else {
      setRefusal(`${record.id}: ${outcome.reason}`);
      announce(`Could not reconcile ${record.id}. ${outcome.reason}`);
    }
  }

  return (
    <>
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        data-unreconciled-status
      >
        {announcement}
      </p>
      {records.length > 0 ? (
        <div
          className="rail-section unreconciled-panel"
          role="region"
          aria-label="Unreconciled outcomes"
        >
          <h3>
            Unreconciled outcomes <span data-unreconciled>{records.length}</span>
          </h3>
          <p className="footnote">
            Each of these wrote and then failed to report, so the runtime cannot
            say what happened. Kept across reloads in{" "}
            {demoPersistence.kind === "indexeddb" ? "IndexedDB" : "memory"}. A
            person decides; the same call is refused until then.
          </p>
          {records.map((record) => (
            <article key={record.id} className="unreconciled-record" data-record={record.id}>
              <div className="record-head">
                <span className="cap">{record.id}</span> {kindWords(record.kind)}
              </div>
              <div className="stat-row">
                <span>Capability</span>
                <span className="num">{record.capability}</span>
              </div>
              <div className="stat-row">
                <span>Recorded</span>
                <span className="num">{fmtTime(record.at)}</span>
              </div>
              <div className="stat-row">
                <span>Operation key</span>
                <span className="num key">{record.operationKey ?? "none"}</span>
              </div>
              <div className="stat-row">
                <span>Actor</span>
                <span className="num">{actorWords(record)}</span>
              </div>
              <div className="stat-row">
                <span>Authorized by</span>
                <span className="num">{authorityWords(record)}</span>
              </div>
              {record.stateVersion !== undefined ? (
                <div className="stat-row">
                  <span>Bound to state</span>
                  <span className="num key">{record.stateVersion}</span>
                </div>
              ) : null}
              <p className="detail">{record.detail}</p>
              <h4>Authorized changes</h4>
              {record.changes.map((change) => (
                <div key={change.field} className="change-row">
                  <span className="field">{change.field}</span>
                  <span className="before">{render(change.before)}</span>
                  <span className="arrow">→</span>
                  <span className="after">{render(change.after)}</span>
                </div>
              ))}
              <div className="record-actions">
                {record.kind === "commit_indeterminate" ? (
                  <>
                    <button
                      type="button"
                      className="undo"
                      aria-label={`Reconcile ${record.id}: the write landed`}
                      onClick={() => settle(record, { kind: "commit_applied" })}
                    >
                      The write landed
                    </button>
                    <button
                      type="button"
                      className="undo"
                      aria-label={`Reconcile ${record.id}: the write did not land`}
                      onClick={() => settle(record, { kind: "commit_not_applied" })}
                    >
                      The write did not land
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="undo"
                    aria-label={`Reconcile ${record.id}: the cleanup is disposed`}
                    onClick={() => settle(record, { kind: "cleanup_disposed" })}
                  >
                    The cleanup is disposed
                  </button>
                )}
              </div>
            </article>
          ))}
          {refusal !== null ? (
            <p className="record-refusal" role="alert">
              Not reconciled. {refusal}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
