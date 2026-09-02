import type { HumanActor } from "./plan.ts";

/**
 * A human gesture, as something the runtime can verify rather than an
 * assertion it has to take on trust.
 *
 * A page token is issued by the runtime on a human click, through an API
 * only page code can reach, and is verified and consumed at approve time.
 * WebAuthn is the stronger option behind the same seam: a second member of
 * this union carrying an assertion, verified by a second verifier, with no
 * change to `approve` or `approvePlan` or their callers.
 */
export type ApprovalGesture = {
  kind: "page-token";
  id: string;
  secret: string;
};

/** What a token is issued for. One token approves one thing. */
export type GestureBinding = { actionId: string } | { planId: string };

export type GestureVerdict =
  | { ok: true; id: string; by: HumanActor }
  | { ok: false; reason: string };

export function isApprovalGesture(value: unknown): value is ApprovalGesture {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "page-token" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}

/** Sixty seconds. Long enough to click, short enough that a leaked token is stale. */
export const GESTURE_TTL_MS = 60_000;

type Issued = {
  secret: string;
  binding: GestureBinding;
  by: HumanActor;
  expiresAt: number;
  spent: boolean;
};

function sameBinding(a: GestureBinding, b: GestureBinding): boolean {
  return "actionId" in a
    ? "actionId" in b && a.actionId === b.actionId
    : "planId" in b && a.planId === b.planId;
}

function randomSecret(): string {
  const bytes = new Uint8Array(16);
  const random = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => void } }).crypto;
  if (random?.getRandomValues) {
    random.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tokens the runtime issued and has not yet consumed. In memory, like every
 * other record here; a token does not survive a reload, which is the point
 * of a token that stands for a click.
 *
 * A token is bound to one action or one plan, is single use, and expires.
 * Any verification attempt that presents the right secret spends it,
 * whatever the verdict, so a token that was tried against the wrong action
 * cannot then be tried against the right one.
 */
export class GestureStore {
  private readonly issued = new Map<string, Issued>();
  private nextId = 1;

  issue(binding: GestureBinding, by: HumanActor, at: number): ApprovalGesture {
    const id = `GST-${this.nextId++}`;
    const secret = randomSecret();
    this.issued.set(id, {
      secret,
      binding: { ...binding },
      by: { ...by },
      expiresAt: at + GESTURE_TTL_MS,
      spent: false,
    });
    return { kind: "page-token", id, secret };
  }

  consume(gesture: ApprovalGesture, binding: GestureBinding, at: number): GestureVerdict {
    const record = this.issued.get(gesture.id);
    if (record === undefined || record.secret !== gesture.secret) {
      return { ok: false, reason: "the approval token is not one this runtime issued" };
    }
    if (record.spent) {
      return { ok: false, reason: `the approval token ${gesture.id} was already used` };
    }
    record.spent = true;
    if (record.expiresAt <= at) {
      return { ok: false, reason: `the approval token ${gesture.id} has expired` };
    }
    if (!sameBinding(record.binding, binding)) {
      return {
        ok: false,
        reason: `the approval token ${gesture.id} was issued for a different approval`,
      };
    }
    return { ok: true, id: gesture.id, by: { ...record.by } };
  }

  clear(): void {
    this.issued.clear();
  }
}
