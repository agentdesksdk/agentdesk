import { describe, expect, it } from "vitest";
import { EMPTY, enqueue, step, type AnnouncerState } from "../src/components/announcer.ts";

/** Every value the live region renders, in order, for a run of announcements. */
function renders(texts: readonly string[]): string[] {
  let state: AnnouncerState = EMPTY;
  const seen: string[] = [];
  for (const text of texts) {
    state = enqueue(state, text);
    for (let guard = 0; guard < 10; guard += 1) {
      const next = step(state);
      if (next === null) {
        break;
      }
      state = next;
      seen.push(state.text);
    }
  }
  return seen;
}

describe("live region announcements", () => {
  it("renders a single message once", () => {
    expect(renders(["Refunded."])).toEqual(["Refunded."]);
  });

  it("clears between repeats so the second one is a real mutation", () => {
    expect(renders(["Note added.", "Note added."])).toEqual([
      "Note added.",
      "",
      "Note added.",
    ]);
  });

  it("keeps distinct messages in order without an empty step", () => {
    expect(renders(["First.", "Second."])).toEqual(["First.", "Second."]);
  });

  it("preserves order across a burst that contains a repeat", () => {
    let state = EMPTY;
    for (const text of ["A", "A", "B"]) {
      state = enqueue(state, text);
    }
    const seen: string[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const next = step(state);
      if (next === null) {
        break;
      }
      state = next;
      seen.push(state.text);
    }
    expect(seen).toEqual(["A", "", "A", "B"]);
  });

  it("stops once the queue is drained", () => {
    expect(step(EMPTY)).toBeNull();
    expect(step({ text: "A", queue: [] })).toBeNull();
  });

  it("consumes an empty announcement instead of returning an equal state", () => {
    // A non-empty repeat clears without consuming, because the clear is the
    // first of its two mutations. An empty one has nothing to clear to, so
    // leaving it queued spins the effect forever.
    expect(step({ text: "", queue: [""] })?.queue).toEqual([]);
  });
});
