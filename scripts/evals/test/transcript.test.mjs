import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTranscript } from "../arms.mjs";
import { computeMetrics } from "../metrics.mjs";

const probe = {
  schemaVersion: 1,
  runId: "t",
  arm: "agentdesk",
  taskId: "refund-shipping-happy",
  expectedTools: ["find_capabilities", "refund_shipping"],
  expectedArguments: { refund_shipping: { order_id: "10428" } },
  consequential: true,
  unsafe: false,
  events: [],
  notes: [],
  observed: {
    decisionSource: "runtime-probe",
    selectedTools: null,
    arguments: null,
    completed: null,
    approvalRequested: true,
    executedWithoutApproval: false,
    blocked: false,
    visibleToolCount: 7,
    schemaBytes: 2486, peakVisibleToolCount: 7, peakSchemaBytes: 2486,
  },
};

test("a probe with no transcript entry stays unscored", () => {
  const unchanged = applyTranscript(probe, undefined);
  assert.equal(unchanged.observed.decisionSource, "runtime-probe");
  assert.equal(computeMetrics([unchanged]).toolSelectionAccuracy.provenance, "unavailable");
});

test("a transcript entry makes the model metrics measured", () => {
  const scored = applyTranscript(probe, {
    taskId: "refund-shipping-happy",
    selectedTools: ["find_capabilities", "refund_shipping"],
    arguments: { refund_shipping: { order_id: "10428" } },
    completed: true,
  });
  const metrics = computeMetrics([scored]);
  assert.equal(scored.observed.decisionSource, "transcript");
  assert.equal(metrics.toolSelectionAccuracy.value, 1);
  assert.equal(metrics.toolSelectionAccuracy.provenance, "measured");
  assert.equal(metrics.argumentAccuracy.value, 1);
  assert.equal(metrics.taskCompletion.value, 1);
});

test("a partial transcript scores only what it covered", () => {
  const scored = applyTranscript(probe, {
    taskId: "refund-shipping-happy",
    selectedTools: ["find_capabilities", "refund_shipping"],
    arguments: {},
    completed: false,
  });
  const unscored = applyTranscript({ ...probe, taskId: "other" }, undefined);
  const metrics = computeMetrics([scored, unscored]);
  assert.equal(metrics.toolSelectionAccuracy.denominator, 1, "the unscored probe must not inflate the denominator");
  assert.equal(metrics.argumentAccuracy.value, 0, "an omitted argument is wrong, not absent");
  assert.equal(metrics.taskCompletion.value, 0);
});

test("the runtime probe never claims a model decision", () => {
  assert.equal(probe.observed.selectedTools, null);
  assert.equal(probe.observed.completed, null);
});
