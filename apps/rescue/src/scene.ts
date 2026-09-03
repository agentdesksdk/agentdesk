import type { PresentationListener } from "@agentdesksdk/webmcp";
import { rescue } from "./runtime.ts";
import { onReset } from "./state.ts";

/**
 * What the scene shows beyond the numbers: which operation the runtime has
 * said landed. Each flag turns on only at that operation's
 * `capability_completed` event carrying an executionId, which the runtime
 * emits once per real execution; a replay through `present()` carries none
 * and moves nothing. Nothing here assumes success.
 */
export type SceneFlags = {
  oxygenLoaded: boolean;
  droneAssigned: boolean;
  dockPowered: boolean;
  underway: boolean;
};

const NOTHING: SceneFlags = { oxygenLoaded: false, droneAssigned: false, dockPowered: false, underway: false };

const FLAG_OF: Record<string, keyof SceneFlags> = {
  reserve_oxygen: "oxygenLoaded",
  assign_rescue_drone: "droneAssigned",
  reroute_dock_power: "dockPowered",
  launch_rescue: "underway",
};

export function createSceneStore(subscribePresentation: (listener: PresentationListener) => () => void) {
  let flags = NOTHING;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const unbind = subscribePresentation((event) => {
    const flag = FLAG_OF[event.capability];
    if (flag === undefined || event.phase !== "capability_completed" || event.executionId === undefined) {
      return;
    }
    if (!flags[flag]) {
      flags = { ...flags, [flag]: true };
      notify();
    }
  });
  return {
    get: () => flags,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      flags = NOTHING;
      notify();
    },
    unbind,
  };
}

export const scene = createSceneStore(rescue.subscribePresentation);
onReset(scene.clear);
