/**
 * The rescue's whole world: one crew, one oxygen store, one drone, one
 * dock, one mission. Live state is replaced only by `land` and `reset`; a
 * write happens on a fork opened by the staging adapter, never here.
 */
export type RescueState = {
  crew: { name: string; status: "stranded" | "rescued"; location: string };
  oxygen: { available: number; reserved: number };
  drone: { id: string; status: "standby" | "assigned"; assignment: string | null };
  dock: { name: string; power: number };
  mission: { id: string; status: "draft" | "launched" };
};

export const MISSION = "AST-10428";
export const DRONE = "NIA-7";
export const DOCK = "Dock 3";
export const CREW = "Asteria";

export function seed(): RescueState {
  return {
    crew: { name: CREW, status: "stranded", location: DOCK },
    oxygen: { available: 6, reserved: 0 },
    drone: { id: DRONE, status: "standby", assignment: null },
    dock: { name: DOCK, power: 20 },
    mission: { id: MISSION, status: "draft" },
  };
}

let live: RescueState = seed();
const listeners = new Set<() => void>();

export function getState(): RescueState {
  return live;
}

export function subscribe(listener: () => void): () => void {
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

/**
 * The four lines a person reads, compares, and verifies: the fields of every
 * diff and of the receipt. Reserved packs and the drone's assignment are
 * shown on the screen but are consequences of these four, not lines of
 * their own, so the consolidated diff stays four rows.
 */
export function rows(state: RescueState): Record<string, string | number> {
  return {
    "Oxygen packs available": state.oxygen.available,
    [`Drone ${state.drone.id}`]: state.drone.status,
    [`${state.dock.name} power`]: `${state.dock.power}%`,
    [`Mission ${state.mission.id}`]: state.mission.status,
  };
}

/**
 * The open fork, shared by every operation staged inside one scope so a
 * plan's second operation derives against its predecessor's head rather
 * than against live state.
 */
let open: { head: RescueState } | null = null;

export function stagingScope<T>(run: () => T): T {
  const outermost = open === null;
  if (open === null) {
    open = { head: structuredClone(live) };
  }
  try {
    return run();
  } finally {
    if (outermost) {
      open = null;
    }
  }
}

/** The fork a handler writes to. Outside a fork there is nothing to write to. */
export function draft(): RescueState {
  if (open === null) {
    throw new Error("a rescue write happens on a staged fork; none is open");
  }
  return open.head;
}

/**
 * Runs one handler against the open fork (opening one for a lone call) and
 * returns the fork's state before and after, each detached, so a diff can
 * be derived later and a commit can land exactly this head.
 */
export function stage<T>(fn: () => T): { result: T; base: RescueState; head: RescueState } {
  return stagingScope(() => {
    const base = structuredClone(draft());
    const result = fn();
    return { result, base, head: structuredClone(draft()) };
  });
}

/** Replaces live state with a staged head. */
export function land(next: RescueState): void {
  live = next;
  notify();
}

const resetHooks = new Set<() => void>();

/** Invalidation point for anything holding a fork of the old world. */
export function onReset(hook: () => void): void {
  resetHooks.add(hook);
}

export function reset(): void {
  open = null;
  live = seed();
  for (const hook of resetHooks) {
    hook();
  }
  notify();
}
