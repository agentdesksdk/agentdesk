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
  | "APPROVAL_STALE"
  | "VIEW_UNAVAILABLE";

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
  stateVersion?: string,
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
  // Written last, by the runtime, so nothing a preview carried can set it.
  if (stateVersion !== undefined) {
    data.stateVersion = stateVersion;
  }
  return coded("APPROVAL_REQUIRED", answered(data, situation), false);
}

/**
 * The state the person approved is not the state that is there now. Nothing
 * was written. The repair is the same request again, because the fix is a
 * new preview of current state for a person to look at.
 */
export function approvalStale(
  capability: string,
  actionId: string,
  versions: { expected: string; observed: string },
  situation: Refusal,
): ToolResult {
  return coded(
    "APPROVAL_STALE",
    answered(
      {
        status: "APPROVAL_STALE",
        code: "APPROVAL_STALE",
        capability,
        approval_id: actionId,
        reasonCode: "APPROVAL_STALE",
        reason:
          "The state this approval was reviewed against has moved, so the approved change no longer describes what would happen. Nothing was written.",
        requiresNewPreview: true,
        stateVersion: { ...versions },
        next: "Request the action again to get a preview of current state, then approve that.",
      },
      situation,
    ),
    true,
  );
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
 * Where a person can go and look. `route` is a page in the application,
 * `reveal` an opaque anchor the application registered on one of its own
 * elements, never a selector. This is exactly what a page needs to navigate
 * and highlight, and nothing more.
 */
export type AuthoredEvidenceLink = {
  label: string;
  route: string;
  reveal?: string;
  /** Set by the runtime, never by a capability; the type says so. */
  source?: never;
};

/**
 * A link as the runtime records it. `source` says which it is: an authored
 * link points at the value that changed, because the author knew where it
 * lives; a derived link points at the write's page, because a presentation
 * hint is all the runtime had. A consequential capability should author
 * its links.
 */
export type EvidenceLink = Omit<AuthoredEvidenceLink, "source"> & {
  source: "authored" | "derived";
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
  /**
   * Where the proof of this write can be seen. Authored here, or derived by
   * the runtime from the capability's presentation hints when absent.
   */
  evidence?: EvidenceLink[];
};

const RECEIPT = Symbol.for("agentdesk.receipt");

type ReceiptEnvelope = {
  [RECEIPT]: true;
  receipt: Receipt;
  value: unknown;
};

/**
 * Wraps a handler's return value with a verifiable change receipt. Authored
 * evidence is checked here, at authoring time, because a link a page cannot
 * follow is an author's mistake and the author is the one who can fix it.
 */
export function receipt(
  spec: Omit<Receipt, "evidence"> & {
    evidence?: AuthoredEvidenceLink[];
    result: unknown;
  },
): unknown {
  const { result, ...rest } = spec;
  if (rest.evidence !== undefined) {
    if (!Array.isArray(rest.evidence)) {
      throw new TypeError("receipt evidence must be an array of links");
    }
    for (const link of rest.evidence) {
      if (typeof link !== "object" || link === null) {
        throw new TypeError("a receipt evidence link must be an object");
      }
      if (typeof link.label !== "string" || link.label.trim() === "") {
        throw new TypeError("a receipt evidence link needs a non-empty label");
      }
      if (typeof link.route !== "string" || !link.route.startsWith("/")) {
        throw new TypeError(
          `a receipt evidence link needs a route starting with "/", received ${JSON.stringify(link.route)}`,
        );
      }
      if (link.reveal !== undefined && typeof link.reveal !== "string") {
        throw new TypeError("a receipt evidence link's reveal must be a string when present");
      }
    }
  }
  const envelope: ReceiptEnvelope = {
    [RECEIPT]: true,
    // The author's links are carried as written; the runtime stamps their
    // source when it settles the receipt, and nothing an author set survives.
    receipt: rest as Receipt,
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

/**
 * `cause` says why the key cannot be honoured. `different_input` is the
 * live conflict. `after_restart` is a key claimed before a restart: the
 * claim survived but its result did not, and the write may have landed, so
 * the call is refused rather than repeated.
 */
export function idempotencyConflict(
  capability: string,
  key: string,
  situation: Refusal,
  cause: "different_input" | "after_restart" = "different_input",
): ToolResult {
  return coded(
    "IDEMPOTENCY_CONFLICT",
    answered(
      {
        status: "IDEMPOTENCY_CONFLICT",
        code: "IDEMPOTENCY_CONFLICT",
        capability,
        idempotency_key: key,
        cause,
        reason:
          cause === "after_restart"
            ? "This idempotency key was already used for this capability before a restart. Its result is not available and the write may have landed, so the call is refused rather than repeated."
            : "This idempotency key was already used for this capability with different input.",
        next:
          cause === "after_restart"
            ? `Ask a person to query the receipts for ${capability}; the receipt in evidence, when there is one, is the earlier write. Use a new idempotency_key only once you know it did not land.`
            : "Use a new idempotency_key, or resend the original input to get the original result.",
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

/**
 * The agent view projection failed, so nothing it would have projected is
 * shown. `completed` says whether a write landed before the view failed,
 * so an agent does not retry a write whose only failure was in showing it.
 */
export function viewUnavailable(
  capability: string,
  completed: boolean,
  situation: Refusal,
): ToolResult {
  return coded(
    "VIEW_UNAVAILABLE",
    answered(
      {
        status: "VIEW_UNAVAILABLE",
        code: "VIEW_UNAVAILABLE",
        capability,
        completed,
        reasonCode: "AGENT_VIEW_FAILED",
        reason: completed
          ? "The execution completed. Its result is withheld because the agent view projection failed; a person can read it in the receipt."
          : "The agent view projection failed, so nothing is shown.",
        next: completed
          ? "Do not retry the write. Ask a person to check the receipt and the projection."
          : "Ask a person to check the projection, then call again.",
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
