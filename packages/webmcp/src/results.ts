import type { Change, RiskLevel, Unavailability } from "./capability.ts";
import type { ConsideredGrant } from "./grants.ts";
import type { Refusal, Settled } from "./protocol.ts";

export type ToolCode =
  | "TOOL_RETIRED"
  | "APPROVAL_REQUIRED"
  | "CAPABILITY_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "POLICY_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_CAPACITY"
  | "PREVIEW_UNAVAILABLE"
  | "EXECUTION_CANCELLED"
  | "EXECUTION_INDETERMINATE"
  | "APPROVAL_STALE";

export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  code?: ToolCode;
  data?: Record<string, unknown>;
};

function coded(
  code: ToolCode,
  data: Record<string, unknown>,
  isError: boolean,
): ToolResult {
  const result: ToolResult = {
    content: [{ type: "text", text: JSON.stringify(data) }],
    code,
    data,
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

/**
 * Writes the protocol's answers onto a payload. Every builder below goes
 * through here, so no result can carry the lists without the evidence or
 * the repair without the derived alias.
 *
 * `suggestedCapability` is derived from `repair.capability` and nothing
 * else, kept for one release for consumers that read the old name. It is
 * never set on its own, so a repair the runtime dropped takes the alias with
 * it.
 */
function answered(
  data: Record<string, unknown>,
  situation: Refusal | Settled,
): Record<string, unknown> {
  data.nowPossible = [...situation.nowPossible];
  data.blockedCapabilities = [...situation.blockedCapabilities];
  data.evidence = situation.evidence.map((item) => ({ ...item }));
  if (situation.repair !== undefined) {
    data.repair =
      situation.repair.input === undefined
        ? { capability: situation.repair.capability }
        : {
            capability: situation.repair.capability,
            input: { ...situation.repair.input },
          };
    data.suggestedCapability = situation.repair.capability;
  }
  return data;
}

export function toolRetired(name: string, situation: Refusal): ToolResult {
  return coded(
    "TOOL_RETIRED",
    answered(
      {
        status: "TOOL_RETIRED",
        code: "TOOL_RETIRED",
        tool: name,
        capability: name,
        reason:
          "Application context changed and this capability is no longer part of the active tool surface.",
        next: "Call find_capabilities with the current task.",
      },
      situation,
    ),
    true,
  );
}

/**
 * Takes only the code and the sentence from the author's unavailability.
 * The repair is deliberately not read from it: the runtime checks the
 * author's claim against policy and availability and hands over what
 * survived on the situation, so a builder cannot repeat a name the runtime
 * declined to offer.
 */
export function capabilityUnavailable(
  name: string,
  why: Pick<Unavailability, "reasonCode" | "reason">,
  situation: Refusal,
): ToolResult {
  return coded(
    "CAPABILITY_UNAVAILABLE",
    answered(
      {
        status: "CAPABILITY_UNAVAILABLE",
        code: "CAPABILITY_UNAVAILABLE",
        capability: name,
        available: false,
        reasonCode: why.reasonCode,
        reason: why.reason,
      },
      situation,
    ),
    true,
  );
}

/**
 * `considered` is the grant the call was checked against and why it did not
 * apply. A grant that does not apply changes nothing about the outcome,
 * which is why this is an approval and not a refusal; it only says what
 * the mandate stopped at, so a person deciding can see it.
 */
export function approvalRequired(
  capability: string,
  actionId: string,
  risk: RiskLevel,
  summary: string,
  preview: Change[],
  approvalEvidence: "derived" | "diff" | "summary",
  situation: Settled,
  considered?: ConsideredGrant,
): ToolResult {
  const data: Record<string, unknown> = {
    status: "APPROVAL_REQUIRED",
    code: "APPROVAL_REQUIRED",
    approval_id: actionId,
    actionId,
    capability,
    risk,
    summary,
    // Tells the caller whether the human is seeing a field-level diff or
    // only a sentence, so "approved" can be interpreted correctly.
    approvalEvidence,
    hint: "A human must approve this action in the application UI. Do not wait on this call; check get_action_status with the approval_id later.",
  };
  if (preview.length > 0) {
    data.will_change = preview;
  }
  if (considered !== undefined) {
    data.grant = { ...considered };
  }
  return coded("APPROVAL_REQUIRED", answered(data, situation), false);
}

/**
 * An object the write touched, named so a human can navigate to it. The
 * `reveal` anchor is an application-registered opaque id, never a selector.
 */
export type AffectedObject = {
  kind: string;
  id: string;
  label: string;
  reveal?: string;
};

/**
 * Application-authored evidence of a completed write: which entity
 * changed, field-level before/after, and whether it can be undone. The
 * runtime carries receipts verbatim into the tool result, the audit
 * timeline, and the approval record.
 */
export type Receipt = {
  entity: string;
  changes: Change[];
  undoable?: boolean;
  note?: string;
  affected?: AffectedObject[];
};

const RECEIPT = Symbol.for("agentdesk.receipt");

type ReceiptEnvelope = {
  [RECEIPT]: true;
  receipt: Receipt;
  value: unknown;
};

/** Wraps a handler's return value with a verifiable change receipt. */
export function receipt(spec: Receipt & { result: unknown }): unknown {
  const { result, ...rest } = spec;
  const envelope: ReceiptEnvelope = {
    [RECEIPT]: true,
    receipt: rest,
    value: result,
  };
  return envelope;
}

export function isReceiptEnvelope(value: unknown): value is ReceiptEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[RECEIPT] === true
  );
}

export function validationFailed(
  capability: string,
  issues: Array<{ path: string; message: string }>,
  situation: Refusal,
): ToolResult {
  return coded(
    "VALIDATION_FAILED",
    answered(
      {
        status: "VALIDATION_FAILED",
        code: "VALIDATION_FAILED",
        capability,
        issues,
        reason: `The input did not match ${capability}'s schema: ${issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
        next: "Fix the arguments and call again. Nothing was executed.",
      },
      situation,
    ),
    true,
  );
}

export function policyDenied(
  capability: string,
  reason: string,
  situation: Refusal,
): ToolResult {
  return coded(
    "POLICY_DENIED",
    answered(
      {
        status: "POLICY_DENIED",
        code: "POLICY_DENIED",
        capability,
        reason,
        next: "This action is not permitted in the current context.",
      },
      situation,
    ),
    true,
  );
}

export function idempotencyConflict(
  capability: string,
  key: string,
  situation: Refusal,
): ToolResult {
  return coded(
    "IDEMPOTENCY_CONFLICT",
    answered(
      {
        status: "IDEMPOTENCY_CONFLICT",
        code: "IDEMPOTENCY_CONFLICT",
        capability,
        idempotency_key: key,
        reason:
          "This idempotency key was already used for this capability with different input.",
        next: "Use a new idempotency_key, or resend the original input to get the original result.",
      },
      situation,
    ),
    true,
  );
}

export function idempotencyCapacity(
  capability: string,
  limit: number,
  situation: Refusal,
): ToolResult {
  return coded(
    "IDEMPOTENCY_CAPACITY",
    answered(
      {
        status: "IDEMPOTENCY_CAPACITY",
        code: "IDEMPOTENCY_CAPACITY",
        capability,
        limit,
        reason: `All ${limit} idempotency slots are held by in-flight executions, so this key cannot be tracked without breaking the retention bound.`,
        next: "Retry once earlier work settles, or call without an idempotency_key to execute without deduplication.",
      },
      situation,
    ),
    true,
  );
}

/**
 * A write whose outcome nobody can establish. Not an error, because an error
 * invites a retry, and a retry here can apply the change a second time. It
 * carries `changes` because they may have landed, and takes a `Settled`
 * situation because no capability repairs it: a human reconciles the record
 * the evidence names.
 */
export function executionIndeterminate(
  capability: string,
  recordId: string,
  detail: string,
  changes: readonly Change[],
  situation: Settled,
): ToolResult {
  return coded(
    "EXECUTION_INDETERMINATE",
    answered(
      {
        status: "INDETERMINATE",
        code: "EXECUTION_INDETERMINATE",
        capability,
        record_id: recordId,
        detail,
        changes,
        hint: "The write may or may not have landed. Do not retry. Check the application, then have a human reconcile this record.",
      },
      situation,
    ),
    false,
  );
}

export function previewUnavailable(
  capability: string,
  error: string,
  situation: Refusal,
): ToolResult {
  return coded(
    "PREVIEW_UNAVAILABLE",
    answered(
      {
        status: "PREVIEW_UNAVAILABLE",
        code: "PREVIEW_UNAVAILABLE",
        capability,
        error,
        reason:
          "This capability declares a change preview and it failed. A consequential action is not queued for approval without one, because a human would be approving blind.",
        next: "Retry once the underlying data is readable.",
      },
      situation,
    ),
    true,
  );
}

export function executionCancelled(
  capability: string,
  situation: Refusal,
): ToolResult {
  return coded(
    "EXECUTION_CANCELLED",
    answered(
      {
        status: "EXECUTION_CANCELLED",
        code: "EXECUTION_CANCELLED",
        capability,
        reason:
          "The runtime was stopped or reset while this execution was in flight.",
        next: "Re-check application state before retrying; the write may or may not have landed.",
      },
      situation,
    ),
    true,
  );
}

export function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * A completed execution. `value` is the handler's return value as plain
 * data, already proven recordable by the caller, so nothing here can throw
 * after the write was committed.
 *
 * With a receipt, the payload is the whole result and rides in `content` and
 * `data` alike. Without one, `content` stays the bare value, byte for byte
 * what a handler returned before this protocol existed, and the answers
 * ride in `data`. A handler that built its own `ToolResult` keeps it.
 */
export function completed(
  value: unknown,
  receipt: Receipt | undefined,
  situation: Settled & { changes: readonly Change[] },
): ToolResult {
  if (isToolResult(value)) {
    return value;
  }
  const answers = answered({}, situation);
  const result = value ?? null;
  if (receipt !== undefined) {
    const payload = {
      status: "COMPLETED",
      result,
      receipt,
      changes: [...situation.changes],
      ...answers,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      data: payload,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(result),
      },
    ],
    data: {
      status: "COMPLETED",
      result,
      changes: [...situation.changes],
      ...answers,
    },
  };
}

/**
 * A bootstrap payload or a bare value as a result. A receipt envelope does
 * not belong here: an execution's result is built by `completed`, which is
 * the only builder that knows what changed and what proves it.
 */
export function toToolResult(value: unknown): ToolResult {
  if (isToolResult(value)) {
    return value;
  }
  if (typeof value === "string") {
    return textResult(value);
  }
  // JSON.stringify(undefined) is undefined, which would violate the
  // advertised { type, text } shape; normalize to null.
  return textResult(JSON.stringify(value === undefined ? null : value));
}

export function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("content" in value) || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      typeof item.type === "string" &&
      "text" in item &&
      typeof item.text === "string",
  );
}
