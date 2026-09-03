import { buildSeed } from "./seed.ts";
import type { Branch, DemoState } from "./types.ts";

type Listener = () => void;

export const DEMO_STATE_STORAGE_KEY = "agentdesk-meridian-state-v1";

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readPersistedState(): DemoState | undefined {
  try {
    const raw = browserStorage()?.getItem(DEMO_STATE_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; state?: unknown };
    const candidate = parsed.state as Partial<DemoState> | undefined;
    if (
      parsed.version !== 1 ||
      candidate === undefined ||
      !Array.isArray(candidate.customers) ||
      !Array.isArray(candidate.orders) ||
      !Array.isArray(candidate.products) ||
      !Array.isArray(candidate.tickets) ||
      !Array.isArray(candidate.credits) ||
      !Array.isArray(candidate.invoices)
    ) {
      return undefined;
    }
    const restored = structuredClone(candidate as DemoState);
    restored.tickets = restored.tickets.map((ticket) => ({
      ...ticket,
      assignee: ticket.assignee ?? null,
    }));
    return restored;
  } catch {
    return undefined;
  }
}

function persistCommittedState(): void {
  try {
    browserStorage()?.setItem(
      DEMO_STATE_STORAGE_KEY,
      JSON.stringify({ version: 1, state }),
    );
  } catch {
    // A locked-down browser still gets a complete in-memory demo.
  }
}

let state: DemoState = readPersistedState() ?? buildSeed();
const listeners = new Set<Listener>();

/**
 * The open agent branch, if any. While it is set, `getState` and `mutate`
 * address it instead of the live document, so a capability handler stages
 * its write without touching what the human is looking at.
 */
let open: { head: DemoState; at: number } | null = null;

/**
 * Set when a staged handler suspended. Its continuation will resume after
 * the fork closed and would otherwise write live state before anyone
 * approved it, and nothing at the call site can tell that write apart from
 * a legitimate one. Writes stop until the store is reset.
 */
let escaped: string | null = null;

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
  if (escaped !== null) {
    throw new Error(
      `refusing to write: ${escaped} suspended during staging, so this write cannot be attributed to a reviewed change. Reset the store.`,
    );
  }
  const next = structuredClone(getState());
  fn(next);
  if (open) {
    open.head = next;
    return;
  }
  state = next;
  persistCommittedState();
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
export function stage<T>(
  name: string,
  fn: () => T,
  at?: number,
): { result: T; branch: Branch } {
  const outermost = open === null;
  if (open === null) {
    open = { head: structuredClone(state), at: at ?? Date.now() };
  }
  const base = open.head;
  try {
    const result = fn();
    const pending = result as PromiseLike<unknown> & {
      catch?: (onRejected: () => void) => unknown;
    };
    if (typeof pending?.then === "function") {
      escaped = name;
      // The continuation is already scheduled and will reject when its next
      // write is refused. Observing it here keeps that refusal from
      // surfacing as an unhandled rejection somewhere unrelated.
      pending.catch?.(() => {});
      throw new Error(
        `${name} staged asynchronously. Its remaining writes would land on live state after the fork closed, so the store is now refusing writes.`,
      );
    }
    return { result, branch: { base, head: open.head, at: open.at } };
  } finally {
    if (outermost) {
      open = null;
    }
  }
}

/**
 * Opens one branch for the duration of `run` so a sequence of stagings
 * composes. Plan preparation uses this; each operation derives against its
 * predecessor's staged head rather than against live state.
 */
export function stagingScope<T>(run: () => T): T {
  const outermost = open === null;
  if (open === null) {
    open = { head: structuredClone(state), at: Date.now() };
  }
  try {
    return run();
  } finally {
    if (outermost) {
      open = null;
    }
  }
}

/** Replaces live state with an already-merged document. */
export function land(next: DemoState): void {
  state = next;
  persistCommittedState();
  notify();
}

const resetHooks = new Set<Listener>();

/** Invalidation point for anything holding a reference into the document. */
export function onReset(hook: Listener): void {
  resetHooks.add(hook);
}

export function resetStore(): void {
  open = null;
  escaped = null;
  state = buildSeed();
  persistCommittedState();
  for (const hook of resetHooks) {
    hook();
  }
  notify();
}
