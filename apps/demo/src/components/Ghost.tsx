import { stagedChangesFor } from "../capabilities/staged.ts";
import { render } from "./ApprovalCards.tsx";
import { useDemoStore, useRuntime } from "./hooks.ts";

/**
 * The document as it would be if the pending proposal were approved. Rendered
 * beside the real values rather than in place of them, so nothing on screen
 * claims to have happened yet.
 */
export function Ghost({ collection, id }: { collection: string; id: string }) {
  useRuntime();
  useDemoStore();
  const changes = stagedChangesFor(collection, id);
  if (changes.length === 0) {
    return null;
  }
  return (
    <div className="ghost" role="status">
      <h4>Proposed by the agent, not yet applied</h4>
      {changes.map((change) => (
        <div key={change.field} className="change-row">
          <span className="field">{change.field}</span>
          <span className="before">{render(change.before)}</span>
          <span className="arrow">→</span>
          <span className="after">{render(change.after)}</span>
        </div>
      ))}
    </div>
  );
}
