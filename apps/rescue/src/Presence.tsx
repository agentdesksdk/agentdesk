import { useEffect, useRef, useState } from "react";
import type { PresentationEvent } from "@agentdesksdk/webmcp";
import { revealPanel } from "./reveal.ts";
import { rescue } from "./runtime.ts";

export type PresenceMode = "guided" | "fast";

const NARRATION_MS = 3200;

/**
 * Where the agent is acting, read off the runtime's presentation bus.
 * Guided: each operation's message is narrated and its panel lit as it
 * runs, so attention moves across the four panels in the plan's order.
 * Fast: no narration and no lighting; the values still change. Focus moves
 * once per human-initiated execution, in either mode, to the panel that
 * changed, and every completion is announced in text.
 */
export function Presence({ mode }: { mode: PresenceMode }) {
  const [narration, setNarration] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const narrationTimer = useRef<number | undefined>(undefined);
  const revealTimer = useRef<number | undefined>(undefined);
  const focused = useRef<string | undefined>(undefined);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (mode === "fast") {
      window.clearTimeout(narrationTimer.current);
      setNarration(null);
    }
  }, [mode]);

  useEffect(() => {
    const unsubscribe = rescue.subscribePresentation((event: PresentationEvent) => {
      const guided = modeRef.current === "guided";
      const handoff =
        event.phase === "capability_completed" &&
        event.focus === "on_explicit_request" &&
        event.humanInitiated === true &&
        event.executionId !== undefined &&
        event.executionId !== focused.current &&
        event.reveal !== undefined;
      if (handoff) {
        focused.current = event.executionId;
      }
      if (event.announce && event.phase === "capability_completed") {
        setAnnouncement(event.announce);
      }
      if (guided && event.message) {
        setNarration(event.message);
        window.clearTimeout(narrationTimer.current);
        narrationTimer.current = window.setTimeout(() => setNarration(null), NARRATION_MS);
      }
      // A panel lights when its operation has landed, not when it starts, so
      // attention moves with the values.
      if (event.reveal && event.phase === "capability_completed" && (guided || handoff)) {
        revealPanel(event.reveal, revealTimer, { highlight: guided, focus: handoff });
      }
    });
    return () => {
      unsubscribe();
      window.clearTimeout(narrationTimer.current);
      window.clearTimeout(revealTimer.current);
    };
  }, []);

  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite" data-presence-announce>
        {announcement}
      </p>
      <div className="presence" data-presence-mode={mode}>
        <span className={`dot${narration ? " live" : ""}`} aria-hidden="true" />
        <span className="label">
          {mode === "guided" ? "Guided" : "Fast"}: {narration ?? "agent idle"}
        </span>
      </div>
    </>
  );
}
