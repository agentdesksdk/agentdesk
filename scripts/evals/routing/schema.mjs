/**
 * The shapes the routing evaluation agrees on. Versioned for the same
 * reason the task eval's are: a stored run has to stay readable after the
 * runner changes, or its aggregates become assertions.
 */
export const ROUTING_TASK_SCHEMA_VERSION = 1;
export const ROUTING_RECORD_SCHEMA_VERSION = 1;
export const ROUTING_REPORT_SCHEMA_VERSION = 1;

/** The two built-in strategies. A custom scorer is what 2.2 will plug in. */
export const STRATEGIES = Object.freeze(["deterministic", "hybrid"]);
const STRATEGY_SET = new Set(STRATEGIES);

/**
 * `DEFAULT_ROUTED` in router.ts, which `find_capabilities` registers. It is
 * not exported by the SDK, so it is pinned here and a test asserts the
 * router returns no more than this when no limit is passed.
 */
export const ROUTED_BUDGET = 5;

export const PROVENANCE = Object.freeze({
  measured: "measured",
  unavailable: "unavailable",
});

/** A held-out task: a messy phrasing and the one capability that completes it. */
export function parseRoutingTask(value, source) {
  const at = (field) => `${source}: task ${value?.id ?? "<no id>"} ${field}`;
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${source}: task must be an object`);
  }
  if (value.schemaVersion !== ROUTING_TASK_SCHEMA_VERSION) {
    throw new TypeError(
      `${at("schemaVersion")} must be ${ROUTING_TASK_SCHEMA_VERSION}, received ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new TypeError(`${at("id")} must be a non-empty string`);
  }
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
    throw new TypeError(`${at("prompt")} must be a non-empty string`);
  }
  if (typeof value.expected !== "string" || value.expected.trim() === "") {
    throw new TypeError(`${at("expected")} must name the capability that completes the task`);
  }
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "id", "prompt", "expected", "note"].includes(key)) {
      throw new TypeError(`${at(key)} is an unknown field`);
    }
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    id: value.id,
    prompt: value.prompt,
    expected: value.expected,
    ...(typeof value.note === "string" ? { note: value.note } : {}),
  });
}

/** One task, one strategy, one run. Everything an aggregate reads is here. */
export function routingRecord({ runId, strategy, task, observed, notes = [] }) {
  if (!STRATEGY_SET.has(strategy)) {
    throw new TypeError(`strategy must be one of ${STRATEGIES.join(", ")}, received ${JSON.stringify(strategy)}`);
  }
  return {
    schemaVersion: ROUTING_RECORD_SCHEMA_VERSION,
    runId,
    strategy,
    taskId: task.id,
    prompt: task.prompt,
    expected: task.expected,
    overlap: { ...task.overlap, matched: [...task.overlap.matched] },
    observed,
    notes,
  };
}

export function parseRoutingRecord(value, source) {
  const at = (field) => `${source}: record ${value?.taskId ?? "<no taskId>"} ${field}`;
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${source}: record must be an object`);
  }
  if (value.schemaVersion !== ROUTING_RECORD_SCHEMA_VERSION) {
    throw new TypeError(
      `${at("schemaVersion")} must be ${ROUTING_RECORD_SCHEMA_VERSION}, received ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (!STRATEGY_SET.has(value.strategy)) {
    throw new TypeError(`${at("strategy")} must be one of ${STRATEGIES.join(", ")}, received ${JSON.stringify(value.strategy)}`);
  }
  if (typeof value.taskId !== "string" || value.taskId.trim() === "") {
    throw new TypeError(`${at("taskId")} must be a non-empty string`);
  }
  if (typeof value.expected !== "string") {
    throw new TypeError(`${at("expected")} must be a string`);
  }
  if (typeof value.overlap !== "object" || value.overlap === null || typeof value.overlap.ratio !== "number") {
    throw new TypeError(`${at("overlap.ratio")} must be a number; the leakage figure is part of the record`);
  }
  const o = value.observed;
  if (typeof o !== "object" || o === null) {
    throw new TypeError(`${at("observed")} must be an object`);
  }
  if (!Array.isArray(o.routed) || o.routed.some((m) => typeof m?.name !== "string" || typeof m?.score !== "number")) {
    throw new TypeError(`${at("observed.routed")} must be an array of { name, score }`);
  }
  if (o.rank !== null && !(Number.isInteger(o.rank) && o.rank >= 1)) {
    throw new TypeError(`${at("observed.rank")} must be a positive integer or null`);
  }
  for (const field of ["hit", "tieAtCut"]) {
    if (typeof o[field] !== "boolean") {
      throw new TypeError(`${at(`observed.${field}`)} must be a boolean`);
    }
  }
  for (const field of ["budget", "routedCount", "schemaBytes"]) {
    if (typeof o[field] !== "number") {
      throw new TypeError(`${at(`observed.${field}`)} must be a number`);
    }
  }
  if (o.hit !== (o.rank !== null && o.rank <= o.budget)) {
    throw new TypeError(`${at("observed.hit")} disagrees with rank ${o.rank} and budget ${o.budget}`);
  }
  return value;
}
