import { PANELS } from "./capabilities.ts";
import type { SceneFlags } from "./scene.ts";
import type { RescueState } from "./state.ts";

/**
 * One scene: the stranded ship at the left, the dock at the right, the
 * drone between. Every state is an attribute and a text label on the
 * element that carries it; colour and motion only echo those. The numbers
 * come from live state; the transitions come from the scene flags, which
 * turn on at the runtime's completion events.
 */
const STARS = [
  [40, 30], [120, 90], [210, 40], [330, 120], [420, 30], [560, 70], [640, 140], [760, 40],
  [880, 110], [960, 30], [1060, 80], [1150, 150], [90, 400], [300, 460], [700, 470], [1000, 440], [500, 420],
] as const;

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

// The drone's route: from its pad to the ship's hatch.
const DRONE_HOME = { x: 600, y: 300 };
const SHIP_HATCH = { x: 305, y: 250 };

export function Scene({ state, flags }: { state: RescueState; flags: SceneFlags }) {
  const dockFill = RING_C * (1 - Math.min(state.dock.power, 100) / 100);
  const toShip = { x: SHIP_HATCH.x - DRONE_HOME.x, y: SHIP_HATCH.y - DRONE_HOME.y };
  const canisters = Array.from({ length: 6 }, (_, index) => ({
    index,
    lit: index < state.oxygen.reserved,
    loaded: flags.oxygenLoaded && index < state.oxygen.reserved,
  }));
  const missionWords = flags.underway ? "Rescue underway" : "Awaiting rescue";

  return (
    <svg
      className="scene"
      viewBox="0 0 1200 520"
      role="img"
      aria-label={`${state.crew.name}, ${state.crew.status} at ${state.dock.name}. Drone ${state.drone.id} ${
        flags.droneAssigned ? `assigned to ${state.mission.id}` : "on standby"
      }. ${state.dock.name} at ${state.dock.power}% power. ${state.oxygen.available} oxygen packs available. ${missionWords}.`}
      data-underway={flags.underway}
    >
      <defs>
        <radialGradient id="glow" r="0.5">
          <stop offset="0" stopColor="#5aa9ff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#5aa9ff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {STARS.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={1.6} className="star" />
      ))}

      {/* The ship, stranded: a hull with a distress beacon. */}
      <g className="ship" data-scene="ship" data-reveal={PANELS.crew} transform="translate(120 190)">
        <polygon points="0,60 60,20 190,20 230,60 190,100 60,100" className="hull" />
        <rect x="70" y="40" width="70" height="40" rx="6" className="window" />
        <polygon points="190,20 230,60 190,100 250,90 265,60 250,30" className="engine" />
        <circle cx="30" cy="60" r="7" className="beacon" />
        <text x="115" y="140" textAnchor="middle" className="label">
          {state.crew.name.toUpperCase()}
        </text>
        <text x="115" y="162" textAnchor="middle" className="status" data-crew-status>
          {state.crew.status === "stranded" ? "STRANDED · no power" : "RESCUED"}
        </text>
      </g>

      {/* The route the drone follows, drawn once the drone is assigned. */}
      {flags.droneAssigned ? (
        <line
          x1={DRONE_HOME.x - 40}
          y1={DRONE_HOME.y}
          x2={SHIP_HATCH.x + 30}
          y2={SHIP_HATCH.y}
          className="route"
          data-scene="route"
        />
      ) : null}

      {/* The drone: grey on standby, blue once assigned; it travels the route once launched. */}
      <g
        className="drone"
        data-scene="drone"
        data-reveal={PANELS.drone}
        data-assigned={flags.droneAssigned}
        data-underway={flags.underway}
        style={{ transform: flags.underway ? `translate(${DRONE_HOME.x + toShip.x}px, ${DRONE_HOME.y + toShip.y}px)` : `translate(${DRONE_HOME.x}px, ${DRONE_HOME.y}px)` }}
      >
        <circle r="70" className="halo" />
        <rect x="-44" y="-22" width="88" height="44" rx="10" className="body" />
        <rect x="-60" y="-6" width="16" height="12" className="arm" />
        <rect x="44" y="-6" width="16" height="12" className="arm" />
        <rect x="-26" y="22" width="52" height="16" rx="4" className="bay" />
        {/* The two loaded canisters ride in the bay. */}
        {canisters
          .filter((c) => c.loaded)
          .map((c, index) => (
            <rect key={c.index} x={-18 + index * 20} y="25" width="14" height="10" rx="2" className="canister lit" />
          ))}
        <text y="-34" textAnchor="middle" className="label">
          {state.drone.id}
        </text>
        <text y="58" textAnchor="middle" className="status" data-drone-label>
          {flags.droneAssigned ? `Assigned ${state.drone.assignment ?? state.mission.id}` : "Standby"}
        </text>
      </g>

      {/* The oxygen store: six canisters; reserved ones light and move into the bay. */}
      <g className="oxygen" data-scene="oxygen" data-reveal={PANELS.oxygen} data-loaded={flags.oxygenLoaded} transform="translate(470 420)">
        <rect x="-20" y="-16" width="300" height="66" rx="10" className="shelf" />
        {canisters.map((c) => (
          <rect
            key={c.index}
            x={c.index * 40}
            y="-4"
            width="24"
            height="40"
            rx="4"
            className={`canister${c.lit ? " lit" : ""}${c.loaded ? " loaded" : ""}`}
            data-canister={c.index}
            data-lit={c.lit}
          />
        ))}
        <text x="120" y="66" textAnchor="middle" className="status">
          O₂ PACKS <tspan data-oxygen-count>{state.oxygen.available}</tspan> available
        </text>
      </g>

      {/* The dock: dark and red until powered, blue with a filled ring after. */}
      <g className="dock" data-scene="dock" data-reveal={PANELS.dock} data-powered={flags.dockPowered} transform="translate(1020 250)">
        <rect x="-70" y="-120" width="140" height="240" rx="18" className="structure" />
        <rect x="-100" y="-30" width="30" height="60" className="pad" />
        <circle r={RING_R} className="ring-track" />
        <circle r={RING_R} className="ring-fill" strokeDasharray={RING_C} strokeDashoffset={dockFill} transform="rotate(-90)" />
        <text y="8" textAnchor="middle" className="power" data-dock-power>
          {state.dock.power}%
        </text>
        <text y="150" textAnchor="middle" className="label">
          {state.dock.name.toUpperCase()}
        </text>
        <text y="172" textAnchor="middle" className="status" data-dock-label>
          {flags.dockPowered ? "POWERED" : "UNPOWERED"}
        </text>
      </g>

      {/* The mission line, the scene's own words for where it stands. */}
      <g className="mission-line" data-reveal={PANELS.mission} transform="translate(600 40)">
        <text textAnchor="middle" className="mission">
          <tspan className="id">MISSION {state.mission.id}</tspan>
          <tspan dx="14" data-mission-status>
            {missionWords}
          </tspan>
        </text>
      </g>
    </svg>
  );
}
