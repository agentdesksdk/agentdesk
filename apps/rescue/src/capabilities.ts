import {
  CapabilityUnavailableError,
  defineCapability,
  unavailable,
  type Capability,
  type Change,
  type VerificationResult,
} from "@agentdesksdk/webmcp";
import { registerOperation } from "./adapter.ts";
import { CREW, DOCK, DRONE, MISSION, draft, getState, rows } from "./state.ts";

const DOMAIN = "rescue";

/** The panel each write moves attention to, by the id the screen registers. */
export const PANELS = {
  crew: "panel-crew",
  oxygen: "panel-oxygen",
  drone: "panel-drone",
  dock: "panel-dock",
  mission: "panel-mission",
} as const;

/** Did live state end up where the change said it would? Read back, not trusted. */
function verifyRows(changes: readonly Change[]): VerificationResult {
  const observed = rows(getState());
  for (const change of changes) {
    if (observed[change.field] !== change.after) {
      return { status: "MISMATCH", field: change.field, expected: change.after, observed: observed[change.field] };
    }
  }
  return { status: "VERIFIED" };
}

function refuse(code: string, detail: string, capability: string): never {
  throw new CapabilityUnavailableError(unavailable(code, detail, capability));
}

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

type Spec = Parameters<typeof defineCapability>[0];

/**
 * A staged write. The handler runs on the adapter's fork; the capability
 * names the operation and verifies the outcome, and declares no evidence
 * of its own: the diff a person approves is derived from the fork.
 */
function staged(
  spec: Omit<Spec, "risk" | "execute" | "staging" | "verify"> & {
    risk: "WRITE" | "CONSEQUENTIAL";
    run: (input: Record<string, unknown>) => unknown;
  },
): Capability {
  const { run, risk, ...rest } = spec;
  registerOperation(spec.name, run);
  return defineCapability({
    ...rest,
    risk,
    staging: { operation: spec.name },
    verify: (_input, _ctx, changes) => verifyRows(changes),
  } as Spec);
}

export const findStrandedCrew: Capability = defineCapability({
  name: "find_stranded_crew",
  title: "Find stranded crew",
  description: "Lists crews reported stranded, with where they are and which mission is drafted for them.",
  domain: DOMAIN,
  risk: "READ",
  intents: ["find stranded crew", "find the stranded crew", "locate crew", "who is stranded"],
  keywords: ["stranded", "crew", "find", "locate", "asteria"],
  entities: [],
  inputSchema: { type: "object", properties: {} },
  presentation: {
    reveal: PANELS.crew,
    message: "Finding the stranded crew",
    announce: () => `Found the ${CREW} crew, stranded at ${DOCK}.`,
  },
  execute: () => {
    const state = getState();
    return {
      crews: [
        {
          name: state.crew.name,
          status: state.crew.status,
          location: state.crew.location,
          mission: state.mission.id,
          mission_status: state.mission.status,
        },
      ],
    };
  },
});

export const inspectRescueConditions: Capability = defineCapability({
  name: "inspect_rescue_conditions",
  title: "Inspect rescue conditions",
  description: "Reads what a rescue needs: oxygen packs on hand, the drone's assignment, the dock's power, and the mission's status.",
  domain: DOMAIN,
  risk: "READ",
  // The words the hero prompt carries, so a deterministic router reaches
  // this read from the prompt itself and not from a name in page code.
  intents: ["prepare a rescue plan", "rescue plan", "inspect rescue conditions", "what does the rescue need"],
  keywords: ["rescue", "plan", "prepare", "conditions", "oxygen", "drone", "dock", "power"],
  entities: [],
  inputSchema: { type: "object", properties: {} },
  presentation: {
    message: "Reading oxygen, drone, dock power, and the mission",
  },
  execute: () => {
    const state = getState();
    return {
      oxygen: { ...state.oxygen },
      drone: { ...state.drone },
      dock: { ...state.dock },
      mission: { ...state.mission },
      launch_requires: { oxygen_reserved: 2, drone_assigned_to: state.mission.id, dock_power_at_least: 60 },
    };
  },
});

export const reserveOxygen: Capability = staged({
  name: "reserve_oxygen",
  title: "Reserve oxygen packs",
  description: "Reserves oxygen packs for the rescue from the packs available.",
  domain: DOMAIN,
  risk: "WRITE",
  intents: ["reserve oxygen", "reserve oxygen packs", "reserve two oxygen packs"],
  keywords: ["reserve", "oxygen", "packs"],
  entities: [],
  inputSchema: {
    type: "object",
    properties: { packs: { type: "number", description: "Packs to reserve; 2 when absent" } },
  },
  presentation: {
    reveal: PANELS.oxygen,
    focus: "on_explicit_request",
    message: (input) => `Reserving ${number(input.packs, 2)} oxygen packs`,
    announce: (input) => `Reserved ${number(input.packs, 2)} oxygen packs for ${MISSION}.`,
  },
  run: (input) => {
    const packs = number(input.packs, 2);
    const state = draft();
    if (packs < 1 || packs > state.oxygen.available) {
      refuse(
        "INSUFFICIENT_OXYGEN",
        `${state.oxygen.available} pack${state.oxygen.available === 1 ? "" : "s"} available; ${packs} asked for.`,
        "reserve_oxygen",
      );
    }
    state.oxygen.available -= packs;
    state.oxygen.reserved += packs;
    return { reserved: packs, available: state.oxygen.available };
  },
});

export const assignRescueDrone: Capability = staged({
  name: "assign_rescue_drone",
  title: "Assign rescue drone",
  description: `Assigns rescue drone ${DRONE} to the mission.`,
  domain: DOMAIN,
  risk: "WRITE",
  intents: ["assign rescue drone", "assign drone", "assign nia-7"],
  keywords: ["assign", "drone", "nia", "rescue"],
  entities: [],
  inputSchema: {
    type: "object",
    properties: {
      drone: { type: "string", description: `Drone id; ${DRONE} when absent` },
      mission: { type: "string", description: `Mission id; ${MISSION} when absent` },
    },
  },
  presentation: {
    reveal: PANELS.drone,
    focus: "on_explicit_request",
    message: `Assigning ${DRONE} to ${MISSION}`,
    announce: `Drone ${DRONE} assigned to ${MISSION}.`,
  },
  run: (input) => {
    const state = draft();
    const drone = typeof input.drone === "string" ? input.drone : DRONE;
    const mission = typeof input.mission === "string" ? input.mission : MISSION;
    if (drone !== state.drone.id) {
      refuse("UNKNOWN_DRONE", `The only rescue drone is ${state.drone.id}.`, "assign_rescue_drone");
    }
    if (mission !== state.mission.id) {
      refuse("UNKNOWN_MISSION", `The only mission is ${state.mission.id}.`, "assign_rescue_drone");
    }
    state.drone.status = "assigned";
    state.drone.assignment = mission;
    return { drone, assigned_to: mission };
  },
});

export const rerouteDockPower: Capability = staged({
  name: "reroute_dock_power",
  title: "Reroute dock power",
  description: `Reroutes power to ${DOCK} so the dock can receive the rescue.`,
  domain: DOMAIN,
  risk: "WRITE",
  intents: ["reroute power", "reroute power to dock", "reroute dock power"],
  keywords: ["reroute", "power", "dock", "allocation"],
  entities: [],
  inputSchema: {
    type: "object",
    properties: {
      dock: { type: "string", description: `Dock name; ${DOCK} when absent` },
      percent: { type: "number", description: "Power allocation to set; 65 when absent" },
    },
  },
  presentation: {
    reveal: PANELS.dock,
    focus: "on_explicit_request",
    message: (input) => `Rerouting ${DOCK} to ${number(input.percent, 65)}% power`,
    announce: (input) => `${DOCK} power at ${number(input.percent, 65)}%.`,
  },
  run: (input) => {
    const state = draft();
    const dock = typeof input.dock === "string" ? input.dock : DOCK;
    const percent = number(input.percent, 65);
    if (dock !== state.dock.name) {
      refuse("UNKNOWN_DOCK", `The only dock is ${state.dock.name}.`, "reroute_dock_power");
    }
    if (percent < 0 || percent > 100) {
      refuse("BAD_ALLOCATION", "Power allocation is a percentage from 0 to 100.", "reroute_dock_power");
    }
    state.dock.power = percent;
    return { dock, power: percent };
  },
});

export const launchRescue: Capability = staged({
  name: "launch_rescue",
  title: "Launch rescue",
  description: `Launches the rescue mission for the ${CREW} crew. Requires human approval.`,
  domain: DOMAIN,
  risk: "CONSEQUENTIAL",
  intents: ["launch rescue", "launch the rescue", "launch mission"],
  keywords: ["launch", "rescue", "mission", "go"],
  entities: [],
  // A launch is decided against the readiness read; naming it here lets
  // routing pull the read in beside the launch for any prompt that asks to launch.
  relationships: { requires: ["inspect_rescue_conditions"] },
  inputSchema: {
    type: "object",
    properties: { mission: { type: "string", description: `Mission id; ${MISSION} when absent` } },
  },
  presentation: {
    reveal: PANELS.mission,
    focus: "on_explicit_request",
    message: `Launching ${MISSION}`,
    announce: `Mission ${MISSION} launched. The rescue is under way.`,
  },
  run: (input) => {
    const state = draft();
    const mission = typeof input.mission === "string" ? input.mission : MISSION;
    if (mission !== state.mission.id) {
      refuse("UNKNOWN_MISSION", `The only mission is ${state.mission.id}.`, "launch_rescue");
    }
    if (state.mission.status === "launched") {
      refuse("ALREADY_LAUNCHED", `${mission} has already launched.`, "launch_rescue");
    }
    const missing: string[] = [];
    if (state.oxygen.reserved < 2) {
      missing.push(`2 oxygen packs reserved (${state.oxygen.reserved} are)`);
    }
    if (state.drone.assignment !== mission) {
      missing.push(`${state.drone.id} assigned to ${mission} (it is ${state.drone.status})`);
    }
    if (state.dock.power < 60) {
      missing.push(`${state.dock.name} at 60% power or more (it is at ${state.dock.power}%)`);
    }
    if (missing.length > 0) {
      refuse("NOT_READY", `The launch needs ${missing.join(", ")}.`, "launch_rescue");
    }
    state.mission.status = "launched";
    return { mission, launched: true };
  },
});

/** The post-launch capability's name, spelled once; every other module uses this constant. */
export const COMPLETE_RESCUE = "complete_rescue";

/**
 * After the launch: the crew comes aboard and the mission closes. The
 * availability hook reads mission state, so before the launch the router
 * ranks it, annotates it unavailable with this reason, and does not
 * register it; once launch_rescue has completed it routes and registers.
 * Nothing on the page can call it; only a WebMCP client does.
 */
export const completeRescue: Capability = staged({
  name: COMPLETE_RESCUE,
  title: "Complete the rescue",
  description: `Brings the ${CREW} crew aboard ${DRONE} and closes mission ${MISSION}: the crew becomes rescued and the mission completed. Available once the rescue has launched.`,
  domain: DOMAIN,
  risk: "WRITE",
  intents: ["complete the rescue", "complete the asteria rescue", "finish the rescue", "verify the crew is safe", "close the mission"],
  keywords: ["complete", "finish", "verify", "safe", "final", "receipt", "recover"],
  entities: [],
  inputSchema: {
    type: "object",
    properties: { mission: { type: "string", description: `The mission to complete; ${MISSION} when absent` } },
  },
  availability: () => {
    const mission = getState().mission;
    if (mission.status === "launched") {
      return { available: true };
    }
    if (mission.status === "completed") {
      return unavailable("ALREADY_COMPLETED", `Mission ${mission.id} is already complete; the crew is rescued.`);
    }
    return unavailable("NOT_LAUNCHED", `Mission ${mission.id} has not launched. complete_rescue becomes available once launch_rescue has completed.`);
  },
  // The optional mission argument is parsed exactly as launch_rescue parses
  // it. Checked here, before staging, so a wrong one is refused with its
  // reason and no fork is opened; the handler repeats the check as a guard.
  checkInput: (input) => {
    const mission = typeof input.mission === "string" ? input.mission : MISSION;
    return mission === getState().mission.id
      ? { available: true }
      : unavailable("UNKNOWN_MISSION", `The only mission is ${getState().mission.id}.`);
  },
  presentation: {
    reveal: PANELS.crew,
    focus: "on_explicit_request",
    message: `Completing the rescue of ${CREW}`,
    announce: `Crew ${CREW} recovered. Mission ${MISSION} complete.`,
  },
  run: (input) => {
    const state = draft();
    // The optional mission argument is parsed exactly as launch_rescue parses
    // it, and a wrong one is refused before anything on the fork is touched.
    const mission = typeof input.mission === "string" ? input.mission : MISSION;
    if (mission !== state.mission.id) {
      refuse("UNKNOWN_MISSION", `The only mission is ${state.mission.id}.`, COMPLETE_RESCUE);
    }
    if (state.mission.status === "completed") {
      refuse("ALREADY_COMPLETED", `Mission ${state.mission.id} is already complete.`, COMPLETE_RESCUE);
    }
    if (state.mission.status !== "launched") {
      refuse("NOT_LAUNCHED", `Mission ${state.mission.id} has not launched.`, COMPLETE_RESCUE);
    }
    state.crew.status = "rescued";
    state.mission.status = "completed";
    return { crew: state.crew.status, mission: state.mission.status };
  },
});

export const rescueCapabilities: Capability[] = [
  findStrandedCrew,
  inspectRescueConditions,
  reserveOxygen,
  assignRescueDrone,
  rerouteDockPower,
  launchRescue,
  completeRescue,
];

/** The four operations the hero prompt asks for, in the order it asks. */
export const RESCUE_PLAN = [
  { capability: "reserve_oxygen", input: { packs: 2 } },
  { capability: "assign_rescue_drone", input: { drone: DRONE, mission: MISSION } },
  { capability: "reroute_dock_power", input: { dock: DOCK, percent: 65 } },
  { capability: "launch_rescue", input: { mission: MISSION } },
];
