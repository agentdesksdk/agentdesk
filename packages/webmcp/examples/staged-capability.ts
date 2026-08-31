// The README's staged-capability example, compiled by `pnpm typecheck` and
// compared against the README by `pnpm check:docs`, so the first thing an
// adopter copies cannot be a shape the runtime rejects.
import {
  createAgentDeskRuntime,
  defineCapability,
  type StagingAdapter,
} from "../src/index.ts";

/** Stands in for the application's own adapter. */
declare const meridianStaging: StagingAdapter<unknown>;

// #region readme
const refundShipping = defineCapability({
  name: "refund_shipping",
  description: "Refund the shipping fee for an order.",
  risk: "CONSEQUENTIAL",
  // No execute, no previewChanges, no approvalEvidence, no code at all. The
  // capability names an operation the adapter owns and the runtime hands it
  // the validated input.
  staging: { operation: "refund_shipping" },
});

const runtime = createAgentDeskRuntime({
  capabilities: [refundShipping],
  // Bound once. The adapter owns the operations, the diff, and the commit,
  // so a capability can neither describe its own change nor reach live state
  // outside the fork this opens.
  staging: meridianStaging,
});
// #endregion readme

export { runtime };
