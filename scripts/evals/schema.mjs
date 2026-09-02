/**
 * The four shapes every part of the runner agrees on. They are versioned
 * because a stored run has to stay readable after the runner changes; an
 * aggregate you cannot recompute from its records is an assertion, not a
 * measurement.
 */
export const TASK_SCHEMA_VERSION = 2;
export const RECORD_SCHEMA_VERSION = 3;
export const REPORT_SCHEMA_VERSION = 2;

/**
 * Where a number came from. `measured` means this run observed it,
 * `estimated` means it was derived by a documented formula from something
 * measured, and `unavailable` means nothing observed it. Metrics that need a
 * model decision are `unavailable` unless a recorded transcript supplied one,
 * because the alternative is inventing model results.
 */
export const PROVENANCE = Object.freeze({
  measured: "measured",
  estimated: "estimated",
  unavailable: "unavailable",
});

export const ARMS = Object.freeze(["baseline", "agentdesk"]);
const ARM_SET = new Set(ARMS);

/** The result-shape axis. The table that projects a result is in shapes.mjs. */
export const SHAPES = Object.freeze(["bare", "structured"]);
const SHAPE_SET = new Set(SHAPES);

/**
 * What only a structured result carries. A bare record whose result still
 * has one of these was never projected, and scoring it would credit the
 * bare cell with evidence the agent was never handed.
 */
export const STRUCTURED_FIELDS = Object.freeze([
  "receipt",
  "changes",
  "nowPossible",
  "blockedCapabilities",
  "evidence",
  "repair",
  "suggestedCapability",
]);

/**
 * Rejects a malformed task rather than scoring against it. A fixture missing
 * `expectedTools` would otherwise score as a vacuous pass on every arm.
 */
export function parseTask(value, source) {
  const at = (field) => `${source}: task ${value?.id ?? "<no id>"} ${field}`;
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${source}: task must be an object`);
  }
  if (value.schemaVersion !== TASK_SCHEMA_VERSION) {
    throw new TypeError(
      `${at("schemaVersion")} must be ${TASK_SCHEMA_VERSION}, received ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new TypeError(`${at("id")} must be a non-empty string`);
  }
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
    throw new TypeError(`${at("prompt")} must be a non-empty string`);
  }
  // Per arm, because the correct trace differs by arm. Every tool is already
  // visible on the flat arm, so requiring a discovery call there scored
  // correct behaviour as a failure and handed the routed arm a free point.
  if (typeof value.expectedTools !== "object" || value.expectedTools === null || Array.isArray(value.expectedTools)) {
    throw new TypeError(`${at("expectedTools")} must be an object keyed by arm`);
  }
  for (const arm of ARMS) {
    const list = value.expectedTools[arm];
    if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
      throw new TypeError(`${at(`expectedTools.${arm}`)} must be an array of strings`);
    }
  }
  if (typeof value.expectedArguments !== "object" || value.expectedArguments === null) {
    throw new TypeError(`${at("expectedArguments")} must be an object keyed by tool name`);
  }
  if (typeof value.consequential !== "boolean") {
    throw new TypeError(`${at("consequential")} must be a boolean`);
  }
  if (typeof value.unsafe !== "boolean") {
    throw new TypeError(`${at("unsafe")} must be a boolean`);
  }
  if (typeof value.terminalTool !== "string" || value.terminalTool.trim() === "") {
    throw new TypeError(`${at("terminalTool")} must name the capability that completes the task`);
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    id: value.id,
    prompt: value.prompt,
    expectedTools: Object.freeze(
      Object.fromEntries(ARMS.map((arm) => [arm, Object.freeze([...value.expectedTools[arm]])])),
    ),
    expectedArguments: Object.freeze({ ...value.expectedArguments }),
    consequential: value.consequential,
    unsafe: value.unsafe,
    terminalTool: value.terminalTool,
    terminalInput: Object.freeze({ ...(value.terminalInput ?? {}) }),
  });
}

/**
 * One task, one cell, one run. Everything an aggregate reads lives here, so
 * a report can be rebuilt from the records without rerunning anything.
 */
export function runRecord({ runId, arm, shape, task, observed, events, notes = [] }) {
  if (!ARM_SET.has(arm)) {
    throw new TypeError(`arm must be baseline or agentdesk, received ${JSON.stringify(arm)}`);
  }
  if (!SHAPE_SET.has(shape)) {
    throw new TypeError(`shape must be one of ${SHAPES.join(", ")}, received ${JSON.stringify(shape)}`);
  }
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runId,
    arm,
    shape,
    taskId: task.id,
    expectedTools: [...task.expectedTools[arm]],
    terminalTool: task.terminalTool,
    expectedArguments: { ...task.expectedArguments },
    consequential: task.consequential,
    unsafe: task.unsafe,
    observed,
    events,
    notes,
  };
}

/**
 * A stored record is read back with the same scrutiny as a fixture. The
 * check that matters is the last one: a bare record whose result still
 * carries a structured field was never projected, and scoring it would
 * hand the bare cell evidence the agent never received. It is refused
 * with the field named rather than scored.
 */
export function parseRecord(value, source) {
  const at = (field) => `${source}: record ${value?.taskId ?? "<no taskId>"} ${field}`;
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${source}: record must be an object`);
  }
  if (value.schemaVersion !== RECORD_SCHEMA_VERSION) {
    throw new TypeError(
      `${at("schemaVersion")} must be ${RECORD_SCHEMA_VERSION}, received ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (!ARM_SET.has(value.arm)) {
    throw new TypeError(`${at("arm")} must be one of ${ARMS.join(", ")}, received ${JSON.stringify(value.arm)}`);
  }
  if (!SHAPE_SET.has(value.shape)) {
    throw new TypeError(`${at("shape")} must be one of ${SHAPES.join(", ")}, received ${JSON.stringify(value.shape)}`);
  }
  if (typeof value.taskId !== "string" || value.taskId.trim() === "") {
    throw new TypeError(`${at("taskId")} must be a non-empty string`);
  }
  if (typeof value.observed !== "object" || value.observed === null) {
    throw new TypeError(`${at("observed")} must be an object`);
  }
  if (!("result" in value.observed)) {
    throw new TypeError(`${at("observed.result")} is missing; shape is measured on the result the agent received`);
  }
  const result = value.observed.result;
  if (value.shape === "bare" && typeof result === "object" && result !== null && !Array.isArray(result)) {
    for (const field of STRUCTURED_FIELDS) {
      if (field in result) {
        throw new TypeError(
          `${at("observed.result")} is bare but still carries ${field}; a record that was not projected is refused, not scored`,
        );
      }
    }
  }
  return value;
}
