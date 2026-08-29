import type { PresentationEvent } from "@agentdesk/webmcp";

const REVEAL_MS = 2400;

/**
 * A reveal target is an opaque id the application registered on one of its
 * own elements. Constraining the token is what keeps `querySelector` out of
 * reach of anything an agent could author, whatever a future caller passes.
 */
const REVEAL_TOKEN = /^[a-z0-9][a-z0-9-]*$/i;

export function isRegisteredRevealToken(reveal: string): boolean {
  return REVEAL_TOKEN.test(reveal);
}

/**
 * The enforcement point for `focus: "on_explicit_request"`. An agent working
 * in the background cannot satisfy this, because only `approve()` sets
 * `humanInitiated`, and each execution can spend the handoff once.
 */
export function shouldHandOffFocus(
  event: PresentationEvent,
  lastFocusedExecutionId: string | undefined,
): event is PresentationEvent & { executionId: string; reveal: string } {
  return (
    event.phase === "capability_completed" &&
    event.focus === "on_explicit_request" &&
    event.humanInitiated === true &&
    event.executionId !== undefined &&
    event.executionId !== lastFocusedExecutionId &&
    event.reveal !== undefined &&
    isRegisteredRevealToken(event.reveal)
  );
}

export type RevealOptions = {
  highlight: boolean;
  focus: boolean;
};

/**
 * A route change can take several frames to paint, so poll briefly for the
 * anchor instead of assuming it exists on the next frame.
 */
export function revealTarget(
  reveal: string,
  timer: { current: number | undefined },
  options: RevealOptions,
  framesLeft = 30,
): void {
  // The token shape is the whole of what keeps the querySelector below out
  // of reach of an injected selector.
  if (!isRegisteredRevealToken(reveal)) {
    return;
  }
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(
      `[data-reveal="${reveal}"]`,
    );
    if (!target) {
      if (framesLeft > 0) {
        revealTarget(reveal, timer, options, framesLeft - 1);
      }
      return;
    }
    if (options.highlight) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      for (const stale of document.querySelectorAll(".agent-reveal")) {
        stale.classList.remove("agent-reveal");
      }
      target.classList.add("agent-reveal");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        target.classList.remove("agent-reveal");
      }, REVEAL_MS);
    }
    if (options.focus) {
      // Set here rather than on every anchor in the app, so a panel cannot
      // become unfocusable by an author forgetting one attribute.
      target.tabIndex = -1;
      target.focus({ preventScroll: options.highlight });
    }
  });
}
