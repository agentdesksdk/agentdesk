import { SHAPES as SHAPE_NAMES } from "./schema.mjs";

/**
 * The second axis. Exposure decides what the agent can see before it acts;
 * shape decides what it is handed after. `structured` is the result the
 * runtime emits today: the handler's value, the receipt, and the protocol's
 * answers. `bare` is that same result stripped to what a plain handler
 * returns, so the cost of the answers and the evidence can be read off the
 * difference between the two.
 *
 * Shape is applied to the recorded copy of the result and nowhere else. The
 * runtime ran identically under both, and the record's `approvalRequested`
 * and `blocked` say so: shape changes what the agent is handed, not what
 * the runtime demanded.
 */
export const SHAPES = Object.freeze({
  bare: Object.freeze({ shape: "bare", label: "bare result", project: bare }),
  structured: Object.freeze({ shape: "structured", label: "structured evidence", project: (payload) => payload }),
});

/**
 * What a plain handler returns: a value, or a message. Status stays so a
 * reader can tell a completion from a refusal, and an approval keeps the
 * id the agent needs to poll with; governance is not evidence. Everything
 * else, the receipt, the changes, the situation lists, the repair, the
 * evidence, is what the structured shape adds and is what this removes.
 */
function bare(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const kept = { status: payload.status };
  if (payload.status === "COMPLETED") {
    kept.result = payload.result ?? null;
  } else if (payload.status === "APPROVAL_REQUIRED") {
    kept.approval_id = payload.approval_id;
  } else if (typeof payload.reason === "string") {
    kept.reason = payload.reason;
  }
  return kept;
}

export function projectResult(shape, payload) {
  const entry = SHAPES[shape];
  if (entry === undefined) {
    throw new TypeError(`shape must be one of ${SHAPE_NAMES.join(", ")}, received ${JSON.stringify(shape)}`);
  }
  return entry.project(payload);
}
