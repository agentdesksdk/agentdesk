import type { AppContext, Capability, RiskLevel } from "./capability.ts";
import type { Actor } from "./plan.ts";

export type PresentationPhase =
  | "intent_routed"
  | "capability_started"
  | "approval_requested"
  | "capability_completed"
  | "capability_failed";

export type PresentationEvent = {
  phase: PresentationPhase;
  capability: string;
  risk?: RiskLevel;
  /** Who is acting, so a UI can show presence rather than a bare event. */
  actor?: Actor;
  /** Where the affected entity lives, already resolved to a path. */
  route?: string;
  /** Anchor the UI should scroll to and emphasize. */
  reveal?: string;
  /** Short narration for the human. */
  message?: string;
  at: number;
};

export type PresentationListener = (event: PresentationEvent) => void;

/**
 * Separate from the audit bus on purpose. Audit is the governance record
 * and must stay complete and replayable; presentation is transient UI
 * choreography that a headless client can ignore entirely.
 */
export class PresentationBus {
  private readonly listeners = new Set<PresentationListener>();

  subscribe(listener: PresentationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PresentationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("agentdesk presentation listener threw", err);
      }
    }
  }
}

export function resolvePresentation(
  capability: Capability,
  phase: PresentationPhase,
  input: Record<string, unknown>,
  ctx: AppContext,
  at: number,
  actor?: Actor,
): PresentationEvent {
  const event: PresentationEvent = {
    phase,
    capability: capability.name,
    risk: capability.risk,
    at,
  };
  if (actor !== undefined) {
    event.actor = actor;
  }
  const spec = capability.presentation;
  if (!spec) {
    return event;
  }
  const route = spec.route?.(input, ctx);
  if (route !== undefined) {
    event.route = route;
  }
  if (spec.reveal !== undefined) {
    event.reveal = spec.reveal;
  }
  const message =
    typeof spec.message === "function" ? spec.message(input, ctx) : spec.message;
  if (message !== undefined) {
    event.message = message;
  }
  return event;
}
