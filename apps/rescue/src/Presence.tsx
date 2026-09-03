import { useEffect, useRef, useState } from "react";
import type { PresentationEvent } from "@agentdesksdk/webmcp";
import { revealPanel } from "./reveal.ts";
import { rescue } from "./runtime.ts";

export type PresenceMode = "guided" | "fast";

const NARRATION_MS = 3200;

/**
 * How long guided attention rests on each panel. A plan's four commits land
 * within milliseconds of each other; shown at that speed only the last
 * panel would ever be seen lit. The values change when they change; only
 * the telling is paced. Tests shorten it.
 */
let guidedPaceMs = 700;

export function setGuidedPace(ms: number): void {
  guidedPaceMs = ms;
}

type Beat = { message?: string; reveal?: string; focus: boolean };

/**
 * Where the agent is acting, read off the runtime's presentation bus.
 * Guided: each operation's message is narrated and its panel lit as it
 * lands, one after another in the plan's order. Fast: no narration and no
 * lighting; the values still change. Focus moves once per human-initiated
 * execution, in either mode, to the panel that changed, and every
 * completion is announced in text.
 */
export function Presence({ mode }: { mode: PresenceMode }) {
  const [narration, setNarration] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const narrationTimer = useRef<number | undefined>(undefined);
  const revealTimer = useRef<number | undefined>(undefined);
  const focused = useRef<string | undefined>(undefined);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const queue = useRef<Beat[]>([]);
  const draining = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (mode === "fast") {
      window.clearTimeout(narrationTimer.current);
      setNarration(null);
    }
  }, [mode]);

  useEffect(() => {
    const play = (beat: Beat) => {
      if (beat.message !== undefined) {
        setNarration(beat.message);
        window.clearTimeout(narrationTimer.current);
        narrationTimer.current = window.setTimeout(() => setNarration(null), NARRATION_MS);
      }
      if (beat.reveal !== undefined) {
        revealPanel(beat.reveal, revealTimer, { highlight: true, focus: beat.focus });
      }
    };
    const drain = () => {
      const next = queue.current.shift();
      if (next === undefined) {
        draining.current = undefined;
        return;
      }
      play(next);
      draining.current = window.setTimeout(drain, guidedPaceMs);
    };
    const enqueue = (beat: Beat) => {
      queue.current.push(beat);
      if (draining.current === undefined) {
        drain();
      }
    };

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
      // A panel lights when its operation has landed, not when it starts, so
      // attention moves with the values; each beat is shown in turn.
      if (event.phase === "capability_completed" && guided && (event.reveal !== undefined || event.message !== undefined)) {
        enqueue({ message: event.message, reveal: event.reveal, focus: handoff });
      } else if (handoff && event.reveal !== undefined) {
        revealPanel(event.reveal, revealTimer, { highlight: false, focus: true });
      }
    });
    return () => {
      unsubscribe();
      window.clearTimeout(narrationTimer.current);
      window.clearTimeout(revealTimer.current);
      window.clearTimeout(draining.current);
      queue.current = [];
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
