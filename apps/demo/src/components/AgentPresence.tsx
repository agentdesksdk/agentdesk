import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { PresentationEvent } from "@agentdesk/webmcp";
import { agentdesk } from "../runtime/agentdesk.ts";
import { revealTarget, shouldHandOffFocus } from "./reveal.ts";

export type PresenceMode = "fast" | "guided";

const NARRATION_MS = 3200;

/**
 * Renders what the agent is acting on. Presentation only; the WebMCP
 * result is authoritative whether or not this component is mounted.
 */
export function AgentPresence({ mode }: { mode: PresenceMode }) {
  const navigate = useNavigate();
  const { mode: routeMode } = useParams();
  const [narration, setNarration] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [risk, setRisk] = useState<string | null>(null);
  const narrationTimer = useRef<number | undefined>(undefined);
  const announceTimer = useRef<number | undefined>(undefined);
  const revealTimer = useRef<number | undefined>(undefined);
  // One slot, because the runtime emits capability_completed exactly once
  // per execution, so no earlier id can come back around.
  const focusedExecution = useRef<string | undefined>(undefined);
  const navigateRef = useRef(navigate);
  const modeRef = useRef(mode);
  const baseRef = useRef(routeMode ?? "agentdesk");

  navigateRef.current = navigate;
  modeRef.current = mode;
  baseRef.current = routeMode ?? "agentdesk";

  useEffect(() => {
    if (mode === "fast") {
      window.clearTimeout(narrationTimer.current);
      setNarration(null);
      for (const stale of document.querySelectorAll(".agent-reveal")) {
        stale.classList.remove("agent-reveal");
      }
    }
  }, [mode]);

  useEffect(() => {
    const unsubscribe = agentdesk.subscribePresentation(
      (event: PresentationEvent) => {
        const guided = modeRef.current === "guided";
        // Focus handoff outlives fast mode. The Approve button that held
        // focus has just unmounted, so suppressing this alongside the
        // narration would strand a keyboard user at the top of the page.
        const handoff = shouldHandOffFocus(event, focusedExecution.current);
        if (handoff) {
          focusedExecution.current = event.executionId;
        }
        if (event.announce && event.phase === "capability_completed") {
          setAnnouncement(event.announce);
          window.clearTimeout(announceTimer.current);
          announceTimer.current = window.setTimeout(
            () => setAnnouncement(""),
            NARRATION_MS,
          );
        }
        if (guided && event.message) {
          setNarration(event.message);
          setRisk(event.risk ?? null);
          window.clearTimeout(narrationTimer.current);
          narrationTimer.current = window.setTimeout(
            () => setNarration(null),
            NARRATION_MS,
          );
        }
        if (guided && event.route && event.phase !== "capability_failed") {
          navigateRef.current(`/${baseRef.current}${event.route}`);
        }
        if (event.reveal && (guided || handoff)) {
          revealTarget(event.reveal, revealTimer, {
            highlight: guided,
            focus: handoff,
          });
        }
      },
    );
    return () => {
      unsubscribe();
      window.clearTimeout(narrationTimer.current);
      window.clearTimeout(announceTimer.current);
      window.clearTimeout(revealTimer.current);
    };
  }, []);

  return (
    <>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {narration ? (
        <div className="agent-narration" role="status" aria-live="polite">
          <span className="dot" />
          <span className="text">{narration}</span>
          {risk ? <span className={`risk ${risk}`}>{risk}</span> : null}
        </div>
      ) : null}
    </>
  );
}
