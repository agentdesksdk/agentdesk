import type { CapabilityName, RiskLevel } from "./capability.ts";

export type ActionId = string & { readonly __brand: "ActionId" };

export type PendingAction = {
  id: ActionId;
  capability: CapabilityName;
  input: Record<string, unknown>;
  risk: RiskLevel;
  summary: string;
  createdAt: number;
};

export type ActionRecord =
  | { status: "PENDING"; action: PendingAction }
  | {
      status: "APPROVED_EXECUTED";
      action: PendingAction;
      result: unknown;
      resolvedAt: number;
    }
  | { status: "REJECTED"; action: PendingAction; resolvedAt: number }
  | { status: "FAILED"; action: PendingAction; error: string; resolvedAt: number }
  | {
      status: "FAILED_UNAVAILABLE";
      action: PendingAction;
      reasonCode: string;
      reason: string;
      resolvedAt: number;
    };

export type ActionStatus = ActionRecord["status"];

export class ApprovalManager {
  private nextId = 1001;
  private readonly records = new Map<string, ActionRecord>();

  request(
    capability: CapabilityName,
    input: Record<string, unknown>,
    risk: RiskLevel,
    summary: string,
    createdAt: number,
  ): PendingAction {
    const id = `APR-${this.nextId++}` as ActionId;
    const action: PendingAction = {
      id,
      capability,
      input,
      risk,
      summary,
      createdAt,
    };
    this.records.set(id, { status: "PENDING", action });
    return action;
  }

  get(id: string): ActionRecord | undefined {
    return this.records.get(id);
  }

  /** Returns the action only if it is still pending. */
  pendingAction(id: string): PendingAction | undefined {
    const record = this.records.get(id);
    return record?.status === "PENDING" ? record.action : undefined;
  }

  resolve(id: string, record: ActionRecord): void {
    this.records.set(id, record);
  }

  pending(): PendingAction[] {
    const actions: PendingAction[] = [];
    for (const record of this.records.values()) {
      if (record.status === "PENDING") {
        actions.push(record.action);
      }
    }
    return actions;
  }

  clear(): void {
    this.records.clear();
  }
}
