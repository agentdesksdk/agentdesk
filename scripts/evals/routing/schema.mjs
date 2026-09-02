// Stub. The tests in scripts/evals/test/routing-*.test.mjs were written
// against these exports first; every value here is the wrong answer on
// purpose, so the tests fail on their assertions and not on an import.
export const ROUTING_TASK_SCHEMA_VERSION = 1;
export const ROUTING_RECORD_SCHEMA_VERSION = 1;
export const ROUTING_REPORT_SCHEMA_VERSION = 1;
export const STRATEGIES = Object.freeze(["deterministic", "hybrid"]);
export const ROUTED_BUDGET = 0;

export function parseRoutingTask(value) {
  return value;
}

export function parseRoutingRecord(value) {
  return value;
}

export function routingRecord(fields) {
  return { ...fields };
}
