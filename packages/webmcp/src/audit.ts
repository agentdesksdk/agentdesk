import type { RiskLevel } from "./capability.ts";
import type { Receipt } from "./results.ts";

export type AuditEvent =
  | { kind: "context_changed"; route: string; exposure: string; at: number }
  | {
      kind: "capability_routed";
      query: string;
      matched: string[];
      activated: string[];
      catalogSize: number;
      at: number;
    }
  | { kind: "tool_registered"; tool: string; at: number }
  | { kind: "tool_retired"; tool: string; at: number }
  | {
      kind: "capability_invoked";
      capability: string;
      risk: RiskLevel;
      via: "native" | "invoke";
      at: number;
    }
  | {
      kind: "capability_unavailable";
      capability: string;
      reasonCode: string;
      at: number;
    }
  | {
      kind: "policy_denied";
      capability: string;
      reason: string;
      at: number;
    }
  | {
      kind: "approval_requested";
      capability: string;
      actionId: string;
      risk: RiskLevel;
      summary: string;
      at: number;
    }
  | { kind: "approval_approved"; actionId: string; capability: string; at: number }
  | { kind: "approval_rejected"; actionId: string; capability: string; at: number }
  | {
      kind: "execution_started";
      capability: string;
      executionId: string;
      at: number;
    }
  | {
      kind: "execution_completed";
      capability: string;
      executionId: string;
      receipt?: Receipt;
      at: number;
    }
  | {
      kind: "execution_failed";
      capability: string;
      executionId: string;
      error: string;
      at: number;
    };

const MAX_EVENTS = 1000;

export type AuditListener = (event: AuditEvent) => void;

export class AuditBus {
  private events: AuditEvent[] = [];
  private readonly listeners = new Set<AuditListener>();

  subscribe(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  append(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("agentdesk audit listener threw", err);
      }
    }
  }

  /** Detached copy; mutating a snapshot cannot rewrite history. */
  list(): readonly AuditEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export function now(): number {
  return Date.now();
}
