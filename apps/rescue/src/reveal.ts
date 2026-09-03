const REVEAL_MS = 2400;
const REVEAL_TOKEN = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * A reveal target is an opaque id the screen registered on one of its
 * panels. Constraining the token keeps `querySelector` out of reach of
 * anything an agent could author.
 */
export function isRegisteredRevealToken(reveal: string): boolean {
  return REVEAL_TOKEN.test(reveal);
}

/** The panels revealed so far, in order, for tests and the rail. */
const revealed: string[] = [];

export function revealedPanels(): readonly string[] {
  return revealed;
}

export function clearRevealed(): void {
  revealed.length = 0;
}

/**
 * Lights the panel and, when asked, moves focus to it. Polls briefly for the
 * element, because a state change can take a frame to paint.
 */
export function revealPanel(
  reveal: string,
  timer: { current: number | undefined },
  options: { highlight: boolean; focus: boolean },
  framesLeft = 30,
): void {
  if (!isRegisteredRevealToken(reveal)) {
    return;
  }
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-reveal="${reveal}"]`);
    if (!target) {
      if (framesLeft > 0) {
        revealPanel(reveal, timer, options, framesLeft - 1);
      }
      return;
    }
    revealed.push(reveal);
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
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  });
}
