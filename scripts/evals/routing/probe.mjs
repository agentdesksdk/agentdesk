import { ROUTED_BUDGET, routingRecord } from "./schema.mjs";

const encoder = new TextEncoder();

/**
 * Bytes exactly as `ToolSurfaceManager` counts them for a live tool: the
 * serialized name, title, description, input schema, and annotations. A
 * test holds this equal to the runtime's own `schemaBytes` less the
 * bootstrap tools, so the figure here is the runtime's, not an estimate.
 */
export function definitionBytes(capability) {
  return encoder.encode(
    JSON.stringify({
      name: capability.name,
      title: capability.title,
      description: capability.description,
      inputSchema: capability.inputSchema,
      annotations: capability.annotations,
    }),
  ).length;
}

/**
 * Routes one task through the SDK's `routeTask` under one strategy and
 * records what came back. No model is involved: the question is whether
 * the capability that completes the task is in the set the router would
 * publish, where it ranks, how big that set is, what it would cost to
 * register, and whether the cut landed on a tie.
 *
 * The router is asked for one more than the budget so the first excluded
 * score is visible; the routed set is the first `ROUTED_BUDGET`, which is
 * what `find_capabilities` registers. Rank is within the router's reach,
 * `MAX_ROUTED`; a capability it never returned has no rank.
 */
export async function probeRouting({ routeTask, capabilities, task, strategy, runId, context }) {
  const ctx = context ?? { route: "/", state: {} };
  const result = await routeTask(
    capabilities,
    { query: task.prompt, context: ctx, limit: ROUTED_BUDGET + 1 },
    { kind: strategy },
  );
  if (result.ok !== true) {
    throw new Error(`routing refused for ${task.id} under ${strategy}: ${result.reason}`);
  }
  const ranked = result.matches.map((m) => ({ name: m.capability.name, score: m.score }));
  const routed = ranked.slice(0, ROUTED_BUDGET);
  const index = ranked.findIndex((m) => m.name === task.expected);
  const rank = index === -1 ? null : index + 1;
  const cutScore = routed.length === ROUTED_BUDGET ? routed[ROUTED_BUDGET - 1].score : null;
  const nextScore = ranked.length > ROUTED_BUDGET ? ranked[ROUTED_BUDGET].score : null;
  const byName = new Map(capabilities.map((c) => [c.name, c]));

  return routingRecord({
    runId,
    strategy,
    task,
    observed: {
      strategyRan: result.strategy,
      budget: ROUTED_BUDGET,
      routed,
      rank,
      hit: rank !== null && rank <= ROUTED_BUDGET,
      routedCount: routed.length,
      schemaBytes: routed.reduce((sum, m) => sum + definitionBytes(byName.get(m.name)), 0),
      cutScore,
      nextScore,
      tieAtCut: cutScore !== null && nextScore !== null && cutScore === nextScore,
    },
    notes: [
      "routed through the SDK's routeTask with no application context; rank is within the router's top six",
    ],
  });
}
