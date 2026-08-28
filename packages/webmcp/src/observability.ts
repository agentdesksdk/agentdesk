import type { AuditEvent } from "./audit.ts";

/**
 * Version of the exported event envelope. Bump on breaking shape changes
 * so downstream collectors can branch instead of guessing.
 */
export const OBSERVABILITY_SCHEMA_VERSION = "agentdesk.audit.v1";

export type ObservabilityEvent = {
  schema: typeof OBSERVABILITY_SCHEMA_VERSION;
  /** Audit event kind, e.g. "execution_completed". */
  name: AuditEvent["kind"];
  /** Epoch milliseconds. */
  timestamp: number;
  /** Present on execution events; correlates start/completed/failed. */
  executionId?: string;
  capability?: string;
  attributes: Record<string, unknown>;
};

export type ObservabilityExporter = (event: ObservabilityEvent) => void;

const OMIT = new Set(["kind", "at"]);

/**
 * Projects an internal audit event onto a stable, flat envelope suitable
 * for OpenTelemetry, Datadog, or a log pipeline. The SDK deliberately
 * ships no vendor dependency: attach one exporter and map it yourself.
 *
 *   runtime.subscribeAudit(toOtelSpanEvent)
 */
export function toObservabilityEvent(event: AuditEvent): ObservabilityEvent {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!OMIT.has(key)) {
      attributes[key] = value;
    }
  }
  const out: ObservabilityEvent = {
    schema: OBSERVABILITY_SCHEMA_VERSION,
    name: event.kind,
    timestamp: event.at,
    attributes,
  };
  if ("executionId" in event && typeof event.executionId === "string") {
    out.executionId = event.executionId;
  }
  if ("capability" in event && typeof event.capability === "string") {
    out.capability = event.capability;
  }
  return out;
}
