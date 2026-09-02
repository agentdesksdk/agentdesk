// The hierarchical routing strategy as a custom scorer, so the routing
// stress evaluation can report it against the committed reference:
//
//   node scripts/evals/routing/run.mjs \
//     --strategies deterministic \
//     --scorer packages/webmcp/examples/hierarchical-scorer.mjs \
//     --run-id routing-2.2 --out scripts/evals/runs/routing-2.2
//
// It reads the built package, so run `pnpm build` first. The scorer is the
// SDK's own `hierarchicalScorer`: the query's decisive tokens choose a
// domain, a second is kept when it nearly ties, and the deterministic
// scorer runs inside with ties at the cut reduced by description overlap.
// No model is involved, which is the point: this is the lexical domain
// step alone, the floor for what a client choosing the domain achieves.
import { hierarchicalScorer } from "../dist/index.js";

export const name = "hierarchical";
export default hierarchicalScorer;
