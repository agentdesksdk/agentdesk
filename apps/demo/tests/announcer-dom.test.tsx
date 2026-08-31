// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAnnouncer } from "../src/components/announcer.ts";

function Region({ onReady }: { onReady: (announce: (t: string) => void) => void }) {
  const { announcement, announce } = useAnnouncer();
  onReady(announce);
  return (
    <p role="status" aria-live="polite">
      {announcement}
    </p>
  );
}

function mount() {
  let announce: (text: string) => void = () => {};
  const view = render(<Region onReady={(fn) => (announce = fn)} />);
  const region = view.container.querySelector("p")!;
  const seen: string[] = [];
  new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return { view, region, seen, announce: (t: string) => announce(t) };
}

/** Pumped with timers, not rAF, so a test counting rAF counts only the hook's. */
async function frames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

afterEach(cleanup);

describe("the live region in a real DOM", () => {
  it("mutates once for a single announcement", async () => {
    const { seen, announce } = mount();
    act(() => announce("Refunded."));
    await frames(3);
    expect(seen).toEqual(["Refunded."]);
  });

  it("mutates three times for a repeat, so both are spoken", async () => {
    const { seen, announce } = mount();
    act(() => announce("Note added."));
    await frames(2);
    act(() => announce("Note added."));
    await frames(3);
    expect(seen).toEqual(["Note added.", "", "Note added."]);
  });

  it("keeps a burst in order", async () => {
    const { seen, announce } = mount();
    act(() => {
      announce("First.");
      announce("Second.");
    });
    await frames(4);
    expect(seen).toEqual(["First.", "Second."]);
  });

  it("settles instead of scheduling frames forever on an empty announcement", async () => {
    const real = window.requestAnimationFrame;
    let scheduled = 0;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      scheduled += 1;
      return real(cb);
    }) as typeof window.requestAnimationFrame;
    try {
      const { announce } = mount();
      act(() => announce(""));
      await frames(6);
      const settled = scheduled;
      await frames(6);
      expect(scheduled).toBe(settled);
    } finally {
      window.requestAnimationFrame = real;
    }
  });

  it("does not write to the region after unmount", async () => {
    const { view, region, seen, announce } = mount();
    act(() => announce("Late."));
    view.unmount();
    await frames(4);
    expect(region.isConnected).toBe(false);
    expect(seen).toEqual([]);
  });
});
