import type { RiskLevel, Unavailability } from "./capability.ts";

export type ToolCode =
  | "TOOL_RETIRED"
  | "APPROVAL_REQUIRED"
  | "CAPABILITY_UNAVAILABLE";

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
): ToolResult {
  return coded(
    "APPROVAL_REQUIRED",
    {
      status: "APPROVAL_REQUIRED",
      code: "APPROVAL_REQUIRED",
      approval_id: actionId,
      actionId,
      capability,
      risk,
      summary,
      hint: "A human must approve this action in the application UI. Do not wait on this call; check get_action_status with the approval_id later.",
    },
    false,
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
  if (isToolResult(value)) {
    return value;
  }
  return textResult(typeof value === "string" ? value : JSON.stringify(value));
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
