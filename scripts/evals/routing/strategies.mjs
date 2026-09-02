import { existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Which scorer a cell runs. The built-ins are the SDK's exported
 * strategies, taken by name. A custom scorer is a module on disk that
 * exports a `CapabilityScorer` (as `default` or as `scorer`), so a
 * replacement scorer can report its cells against the committed reference
 * without the eval knowing it exists. The same catalog and the same tasks
 * are what the hierarchical catalog of roadmap 2.2 is accepted on.
 */
export const BUILTIN_STRATEGIES = Object.freeze(["deterministic", "hybrid"]);

/** A custom cell is named after its file, or after the module's own `name`. */
const CUSTOM_NAME = /^custom:[A-Za-z0-9_.-]+$/;

export function isStrategyName(name) {
  return BUILTIN_STRATEGIES.includes(name) || CUSTOM_NAME.test(name);
}

export function resolveStrategy(name) {
  if (!BUILTIN_STRATEGIES.includes(name)) {
    throw new TypeError(
      `unknown strategy ${JSON.stringify(name)}; the SDK exports ${BUILTIN_STRATEGIES.join(" and ")}, ` +
        "and a scorer of your own is --scorer <path> to a module exporting a CapabilityScorer",
    );
  }
  return { name, kind: name, strategy: { kind: name } };
}

/**
 * `onFailure: "refuse"`, always. The SDK's other option degrades a broken
 * custom scorer to the deterministic one, which in a report would print a
 * deterministic number under the custom cell's name. Here a broken scorer
 * stops the run instead, so every figure under a custom label came from
 * that scorer.
 */
export async function loadScorer(path, { repoRoot = process.cwd() } = {}) {
  const absolute = resolve(repoRoot, path);
  const shown = relative(repoRoot, absolute).split("\\").join("/");
  if (!existsSync(absolute)) {
    throw new Error(`scorer module not found: ${shown}`);
  }
  let mod;
  try {
    mod = await import(pathToFileURL(absolute).href);
  } catch (err) {
    throw new Error(`could not load scorer ${shown}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const scorer =
    typeof mod.default === "function" ? mod.default : typeof mod.scorer === "function" ? mod.scorer : undefined;
  if (scorer === undefined) {
    throw new TypeError(
      `${shown} must export a CapabilityScorer function as default or as \`scorer\`; ` +
        `it exports ${Object.keys(mod).join(", ") || "nothing"}`,
    );
  }
  const own = typeof mod.name === "string" && mod.name.trim() !== "" ? mod.name.trim() : basename(absolute).replace(/\.[cm]?js$/, "");
  const safe = own.replace(/[^A-Za-z0-9_.-]/g, "-");
  return {
    name: `custom:${safe}`,
    kind: "custom",
    strategy: { kind: "custom", scorer, onFailure: "refuse" },
    path: shown,
  };
}

/** The cells a run produces: the named built-ins, then the custom scorer when one is given. */
export async function resolveStrategies({ names, scorerPath, repoRoot = process.cwd() } = {}) {
  const chosen = names === undefined ? [...BUILTIN_STRATEGIES] : [...names];
  const seen = new Set();
  const resolved = [];
  for (const name of chosen) {
    if (seen.has(name)) {
      throw new TypeError(`strategy ${JSON.stringify(name)} is named twice; a duplicate cell would report one run as two`);
    }
    seen.add(name);
    resolved.push(resolveStrategy(name));
  }
  if (scorerPath !== undefined) {
    resolved.push(await loadScorer(scorerPath, { repoRoot }));
  }
  return resolved;
}

/** A cell name as a file name: a colon is not one on Windows. */
export function recordsFileKey(name) {
  return name.replace(/[^A-Za-z0-9_.-]/g, "-");
}
