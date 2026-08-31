import type { Change, CapabilityName, RiskLevel } from "./capability.ts";

export type ActionId = string & { readonly __brand: "ActionId" };

export type PendingAction = {
  id: ActionId;
  capability: CapabilityName;
  input: Record<string, unknown>;
  risk: RiskLevel;
  summary: string;
  /** What this call would change, shown to the human before approving. */
  preview: Change[];
  createdAt: number;
};

export type ActionRecord =
  | { status: "PENDING"; action: PendingAction }
  | { status: "EXECUTING"; action: PendingAction }
  | {
      status: "APPROVED_EXECUTED";
      action: PendingAction;
      result: unknown;
      resolvedAt: number;
    }
  | { status: "REJECTED"; action: PendingAction; resolvedAt: number }
  | { status: "FAILED"; action: PendingAction; error: string; resolvedAt: number }
  | {
      /**
       * The commit threw after it may already have written. Nothing here
       * says the change did not land, which is exactly why it is not
       * FAILED, and the approved diff is retained for reconciliation.
       */
      status: "INDETERMINATE";
      action: PendingAction;
      detail: string;
      recordId: string;
      resolvedAt: number;
    }
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

  /**
   * Creates a pending action. The input is deep-cloned so later mutation of
   * the caller's object cannot change what the human approved. An identical
   * request (same capability, structurally equal input) that is still
   * pending is returned as-is instead of creating a duplicate approval.
   */
  request(
    capability: CapabilityName,
    input: Record<string, unknown>,
    risk: RiskLevel,
    summary: string,
    preview: Change[],
    createdAt: number,
  ): PendingAction {
    const snapshot = structuredClone(input);
    const storedPreview = structuredClone(preview) as Change[];
    const fingerprint = JSON.stringify(snapshot);
    for (const record of this.records.values()) {
      if (
        record.status === "PENDING" &&
        record.action.capability === capability &&
        JSON.stringify(record.action.input) === fingerprint
      ) {
        return record.action;
      }
    }
    const id = `APR-${this.nextId++}` as ActionId;
    const action: PendingAction = {
      id,
      capability,
      input: snapshot,
      risk,
      summary,
      preview: storedPreview,
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

  /**
   * Atomically transitions PENDING -> EXECUTING. Exactly one caller wins;
   * concurrent claimants get undefined and must not execute.
   */
  claim(id: string): PendingAction | undefined {
    const record = this.records.get(id);
    if (record?.status !== "PENDING") {
      return undefined;
    }
    this.records.set(id, { status: "EXECUTING", action: record.action });
    return record.action;
  }

  resolve(id: string, record: ActionRecord): void {
    this.records.set(id, record);
  }

  /**
   * Detached copies. A UI holds these; handing out the live records would
   * let a consumer rewrite `input` or `preview` after the human reviewed
   * them and before `approve()` executes.
   */
  pending(): PendingAction[] {
    const actions: PendingAction[] = [];
    for (const record of this.records.values()) {
      if (record.status === "PENDING") {
        actions.push(structuredClone(record.action));
      }
    }
    return actions;
  }

  clear(): void {
    this.records.clear();
  }
}
