import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { PresentationEvent } from "@agentdesk/webmcp";
import { agentdesk } from "../runtime/agentdesk.ts";

export type PresenceMode = "fast" | "guided";

const NARRATION_MS = 3200;
const REVEAL_MS = 2400;

/**
 * Renders what the agent is acting on. Presentation only; the WebMCP
 * result is authoritative whether or not this component is mounted.
 */
export function AgentPresence({ mode }: { mode: PresenceMode }) {
  const navigate = useNavigate();
  const { mode: routeMode } = useParams();
  const [narration, setNarration] = useState<string | null>(null);
  const [risk, setRisk] = useState<string | null>(null);
  const narrationTimer = useRef<number | undefined>(undefined);
  const revealTimer = useRef<number | undefined>(undefined);
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
        if (modeRef.current === "fast") {
          return;
        }
        if (event.message) {
          setNarration(event.message);
          setRisk(event.risk ?? null);
          window.clearTimeout(narrationTimer.current);
          narrationTimer.current = window.setTimeout(
            () => setNarration(null),
            NARRATION_MS,
          );
        }
        if (event.route && event.phase !== "capability_failed") {
          navigateRef.current(`/${baseRef.current}${event.route}`);
        }
        if (event.reveal) {
          highlight(event.reveal, revealTimer);
        }
      },
    );
    return () => {
      unsubscribe();
      window.clearTimeout(narrationTimer.current);
      window.clearTimeout(revealTimer.current);
    };
  }, []);

  if (!narration) {
    return null;
  }
  return (
    <div className="agent-narration" role="status" aria-live="polite">
      <span className="dot" />
      <span className="text">{narration}</span>
      {risk ? <span className={`risk ${risk}`}>{risk}</span> : null}
    </div>
  );
}

/**
 * A route change can take several frames to paint, so poll briefly for the
 * anchor instead of assuming it exists on the next frame.
 */
function highlight(
  reveal: string,
  timer: { current: number | undefined },
  framesLeft = 30,
): void {
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(
      `[data-reveal="${reveal}"]`,
    );
    if (!target) {
      if (framesLeft > 0) {
        highlight(reveal, timer, framesLeft - 1);
      }
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    for (const stale of document.querySelectorAll(".agent-reveal")) {
      stale.classList.remove("agent-reveal");
    }
    target.classList.add("agent-reveal");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      target.classList.remove("agent-reveal");
    }, REVEAL_MS);
  });
}
