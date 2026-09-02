import { PROVENANCE } from "./schema.mjs";

/**
 * Every metric is a pure function of stored records, and a metric with no
 * applicable records is unavailable, never zero. All of them are
 * runtime-measured: nothing here needs a model decision.
 */
function ratio(name, numerator, denominator) {
  if (denominator === 0) {
    return { name, value: null, numerator, denominator, provenance: PROVENANCE.unavailable, reason: "no applicable tasks in this run" };
  }
  return { name, value: numerator / denominator, numerator, denominator, provenance: PROVENANCE.measured };
}

function summarize(name, values, reason = "no records carried this observation") {
  if (values.length === 0) {
    return { name, value: null, numerator: 0, denominator: 0, provenance: PROVENANCE.unavailable, reason };
  }
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    name,
    value: total / values.length,
    mean: total / values.length,
    max: Math.max(...values),
    min: Math.min(...values),
    denominator: values.length,
    provenance: PROVENANCE.measured,
  };
}

/** Whether the capability that completes the task is in the published set. */
export function terminalInRoutedSet(records) {
  return ratio("terminalInRoutedSet", records.filter((r) => r.observed.hit === true).length, records.length);
}

/** Where it landed, over the tasks where it landed at all. */
export function terminalRank(records) {
  return summarize(
    "terminalRank",
    records.filter((r) => r.observed.hit === true).map((r) => r.observed.rank),
    "no task routed its expected capability",
  );
}

export function routedSetSize(records) {
  return summarize("routedSetSize", records.map((r) => r.observed.routedCount));
}

export function schemaBytes(records) {
  return summarize("schemaBytes", records.map((r) => r.observed.schemaBytes));
}

/** The fragility #19 recorded: how often the budget cut through equal scores. */
export function tieAtCut(records) {
  return ratio("tieAtCut", records.filter((r) => r.observed.tieAtCut === true).length, records.length);
}

/** The leakage figure, so the report carries the number that enforces the rule. */
export function metadataOverlap(records) {
  return summarize("metadataOverlap", records.map((r) => r.overlap.ratio));
}

export function computeRoutingMetrics(records) {
  return {
    terminalInRoutedSet: terminalInRoutedSet(records),
    terminalRank: terminalRank(records),
    routedSetSize: routedSetSize(records),
    schemaBytes: schemaBytes(records),
    tieAtCut: tieAtCut(records),
    metadataOverlap: metadataOverlap(records),
  };
}

/** The tasks the strategy got wrong, with what it routed instead. */
export function failingTasks(records) {
  return records
    .filter((r) => r.observed.hit !== true)
    .map((r) => ({
      taskId: r.taskId,
      prompt: r.prompt,
      expected: r.expected,
      rank: r.observed.rank,
      routed: r.observed.routed.map((m) => m.name),
    }));
}
