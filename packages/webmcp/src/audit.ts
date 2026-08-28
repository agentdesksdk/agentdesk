import type { RiskLevel } from "./capability.ts";

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
      kind: "approval_requested";
      capability: string;
      actionId: string;
      risk: RiskLevel;
      summary: string;
      at: number;
    }
  | { kind: "approval_approved"; actionId: string; capability: string; at: number }
  | { kind: "approval_rejected"; actionId: string; capability: string; at: number }
  | { kind: "execution_started"; capability: string; at: number }
  | { kind: "execution_completed"; capability: string; at: number }
  | { kind: "execution_failed"; capability: string; error: string; at: number };

export class AuditBus {
  private events: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.events.push(event);
  }

  list(): readonly AuditEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }
}

export function now(): number {
  return Date.now();
}
