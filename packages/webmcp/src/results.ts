import type { Change, RiskLevel, Unavailability } from "./capability.ts";

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
  | "EXECUTION_INDETERMINATE";

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

export function toolRetired(name: string): ToolResult {
  return coded(
    "TOOL_RETIRED",
    {
      status: "TOOL_RETIRED",
      code: "TOOL_RETIRED",
      tool: name,
      capability: name,
      reason:
        "Application context changed and this capability is no longer part of the active tool surface.",
      next: "Call find_capabilities with the current task.",
    },
    true,
  );
}

export function capabilityUnavailable(
  name: string,
  why: Unavailability,
): ToolResult {
  const data: Record<string, unknown> = {
    status: "CAPABILITY_UNAVAILABLE",
    code: "CAPABILITY_UNAVAILABLE",
    capability: name,
    available: false,
    reasonCode: why.reasonCode,
    reason: why.reason,
  };
  if (why.suggestedCapability !== undefined) {
    data.suggestedCapability = why.suggestedCapability;
  }
  return coded("CAPABILITY_UNAVAILABLE", data, true);
}

export function approvalRequired(
  capability: string,
  actionId: string,
  risk: RiskLevel,
  summary: string,
  preview: Change[] = [],
  approvalEvidence: "derived" | "diff" | "summary" = "summary",
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
  return coded("APPROVAL_REQUIRED", data, false);
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
): ToolResult {
  return coded(
    "VALIDATION_FAILED",
    {
      status: "VALIDATION_FAILED",
      code: "VALIDATION_FAILED",
      capability,
      issues,
      next: "Fix the arguments and call again. Nothing was executed.",
    },
    true,
  );
}

export function policyDenied(
  capability: string,
  reason: string,
): ToolResult {
  return coded(
    "POLICY_DENIED",
    {
      status: "POLICY_DENIED",
      code: "POLICY_DENIED",
      capability,
      reason,
      next: "This action is not permitted in the current context.",
    },
    true,
  );
}

export function idempotencyConflict(
  capability: string,
  key: string,
): ToolResult {
  return coded(
    "IDEMPOTENCY_CONFLICT",
    {
      status: "IDEMPOTENCY_CONFLICT",
      code: "IDEMPOTENCY_CONFLICT",
      capability,
      idempotency_key: key,
      reason:
        "This idempotency key was already used for this capability with different input.",
      next: "Use a new idempotency_key, or resend the original input to get the original result.",
    },
    true,
  );
}

export function idempotencyCapacity(
  capability: string,
  limit: number,
): ToolResult {
  return coded(
    "IDEMPOTENCY_CAPACITY",
    {
      status: "IDEMPOTENCY_CAPACITY",
      code: "IDEMPOTENCY_CAPACITY",
      capability,
      limit,
      reason: `All ${limit} idempotency slots are held by in-flight executions, so this key cannot be tracked without breaking the retention bound.`,
      next: "Retry once earlier work settles, or call without an idempotency_key to execute without deduplication.",
    },
    true,
  );
}

/**
 * A write whose outcome nobody can establish. Not an error, because an error
 * invites a retry, and a retry here can apply the change a second time.
 */
export function executionIndeterminate(
  capability: string,
  recordId: string,
  detail: string,
  changes: readonly Change[],
): ToolResult {
  return coded(
    "EXECUTION_INDETERMINATE",
    {
      status: "INDETERMINATE",
      code: "EXECUTION_INDETERMINATE",
      capability,
      record_id: recordId,
      detail,
      changes,
      hint: "The write may or may not have landed. Do not retry. Check the application, then have a human reconcile this record.",
    },
    false,
  );
}

export function previewUnavailable(
  capability: string,
  error: string,
): ToolResult {
  return coded(
    "PREVIEW_UNAVAILABLE",
    {
      status: "PREVIEW_UNAVAILABLE",
      code: "PREVIEW_UNAVAILABLE",
      capability,
      error,
      reason:
        "This capability declares a change preview and it failed. A consequential action is not queued for approval without one, because a human would be approving blind.",
      next: "Retry once the underlying data is readable.",
    },
    true,
  );
}

export function executionCancelled(capability: string): ToolResult {
  return coded(
    "EXECUTION_CANCELLED",
    {
      status: "EXECUTION_CANCELLED",
      code: "EXECUTION_CANCELLED",
      capability,
      reason:
        "The runtime was stopped or reset while this execution was in flight.",
      next: "Re-check application state before retrying; the write may or may not have landed.",
    },
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

export function toToolResult(value: unknown): ToolResult {
  if (isReceiptEnvelope(value)) {
    const payload = {
      status: "COMPLETED",
      result: value.value ?? null,
      receipt: value.receipt,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      data: payload,
    };
  }
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
