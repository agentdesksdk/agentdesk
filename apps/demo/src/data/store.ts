import { buildSeed } from "./seed.ts";
import type { Branch, DemoState } from "./types.ts";

type Listener = () => void;

let state: DemoState = buildSeed();
const listeners = new Set<Listener>();

/**
 * The open agent branch, if any. While it is set, `getState` and `mutate`
 * address it instead of the live document, so a capability handler stages
 * its write without touching what the human is looking at.
 */
let open: { head: DemoState; at: number } | null = null;

export function getState(): DemoState {
  return open ? open.head : state;
}

/** Live state, ignoring any open branch. What the human is looking at. */
export function getCommittedState(): DemoState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function mutate(fn: (draft: DemoState) => void): void {
  const next = structuredClone(getState());
  fn(next);
  if (open) {
    open.head = next;
    return;
  }
  state = next;
  notify();
}

/**
 * Timestamp a handler must use instead of reading the wall clock. Frozen for
 * the life of a branch, so the dry run that produced an approved diff and the
 * commit that lands it cannot disagree about when they happened.
 */
export function nowIso(): string {
  return new Date(open ? open.at : Date.now()).toISOString();
}

/**
 * Runs `fn` against a fork of current state and returns what changed without
 * touching the live document. Nested calls share one branch, so a sequence of
 * staged operations composes and each one sees its predecessor's writes.
 *
 * `at` pins the branch clock. Re-running a staged operation later passes the
 * original branch's clock so the two runs cannot differ by timestamp alone.
 */
export function stage<T>(fn: () => T, at?: number): { result: T; branch: Branch } {
  const outermost = open === null;
  if (open === null) {
    open = { head: structuredClone(state), at: at ?? Date.now() };
  }
  const base = open.head;
  try {
    const result = fn();
    return { result, branch: { base, head: open.head, at: open.at } };
  } finally {
    if (outermost) {
      open = null;
    }
  }
}

/** Replaces live state with an already-merged document. */
export function land(next: DemoState): void {
  state = next;
  notify();
}

const resetHooks = new Set<Listener>();

/** Invalidation point for anything holding a reference into the document. */
export function onReset(hook: Listener): void {
  resetHooks.add(hook);
}

export function resetStore(): void {
  open = null;
  state = buildSeed();
  for (const hook of resetHooks) {
    hook();
  }
  notify();
}
