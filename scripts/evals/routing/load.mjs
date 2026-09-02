import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { OVERLAP_THRESHOLD, tokenOverlap } from "./overlap.mjs";
import { parseRoutingRecord, parseRoutingTask } from "./schema.mjs";

const NL = String.fromCharCode(10);

function lines(path, source) {
  return readFileSync(path, "utf8")
    .split(NL)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      try {
        return { value: JSON.parse(line), at: `${source} line ${index + 1}` };
      } catch (err) {
        throw new SyntaxError(`${source}: line ${index + 1} is not valid JSON: ${err.message}`);
      }
    });
}

/**
 * Loads the held-out tasks against the catalog they will be scored on.
 * Every task must name a capability the catalog holds, and its overlap
 * with that capability's routing metadata must sit under the threshold. A
 * task over it is refused with the figure, because scoring it would
 * measure how well the author copied the metadata and not the scorer.
 */
export function loadRoutingTasks(path, specs, { repoRoot = process.cwd(), tokenize, threshold = OVERLAP_THRESHOLD } = {}) {
  if (typeof tokenize !== "function") {
    throw new TypeError("loadRoutingTasks needs the router's tokenize, so overlap is measured the way routing reads");
  }
  const source = relative(repoRoot, path);
  const byName = new Map(specs.map((s) => [s.name, s]));
  const seen = new Set();
  return lines(path, source).map(({ value, at }) => {
    const task = parseRoutingTask(value, at);
    if (seen.has(task.id)) {
      throw new TypeError(`${at}: task id ${JSON.stringify(task.id)} appears more than once`);
    }
    seen.add(task.id);
    const spec = byName.get(task.expected);
    if (spec === undefined) {
      throw new TypeError(`${at}: task ${task.id} expects ${task.expected}, which the catalog does not hold`);
    }
    const overlap = tokenOverlap(task.prompt, spec, tokenize);
    if (overlap.ratio > threshold) {
      throw new TypeError(
        `${at}: task ${task.id} overlaps ${(overlap.ratio * 100).toFixed(0)}% with ${task.expected}'s routing metadata ` +
          `(matched: ${overlap.matched.join(", ")}), above the ${threshold} threshold; ` +
          "a prompt that quotes the metadata measures the author, not the scorer",
      );
    }
    return Object.freeze({
      ...task,
      overlap: Object.freeze({ ratio: overlap.ratio, matched: Object.freeze([...overlap.matched]), threshold }),
    });
  });
}

/** Stored records come back through `parseRoutingRecord`, line by line. */
export function loadRoutingRecords(path, { repoRoot = process.cwd() } = {}) {
  const source = relative(repoRoot, path);
  return lines(path, source).map(({ value, at }) => parseRoutingRecord(value, at));
}
