import type { AppContext, Capability, RiskLevel } from "./capability.ts";
import type { Actor } from "./plan.ts";

export type PresentationPhase =
  | "intent_routed"
  | "capability_started"
  | "approval_requested"
  | "capability_completed"
  | "capability_failed";

/**
 * Whether a completed action may take the human's keyboard focus.
 * "on_explicit_request" still requires the runtime to report the execution
 * as human-authorized, so an agent working in the background cannot reach
 * focus by declaring a policy.
 */
export type FocusPolicy = "never" | "on_explicit_request";

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
  /** Application-authored focus policy for `reveal`. Absent means never. */
  focus?: FocusPolicy;
  /** Short screen-reader sentence for the completed action. */
  announce?: string;
  /** Correlates with the audit trail, and bounds focus to once per execution. */
  executionId?: string;
  /** True only when a human authorized this execution through `approve`. */
  humanInitiated?: boolean;
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
  const route = resolveField(capability, "route", () => spec.route?.(input, ctx));
  if (route !== undefined) {
    event.route = route;
  }
  if (spec.reveal !== undefined) {
    event.reveal = spec.reveal;
  }
  if (spec.focus !== undefined) {
    event.focus = spec.focus;
  }
  const announce = resolveField(capability, "announce", () =>
    typeof spec.announce === "function" ? spec.announce(input, ctx) : spec.announce,
  );
  if (announce !== undefined) {
    event.announce = announce;
  }
  const message = resolveField(capability, "message", () =>
    typeof spec.message === "function" ? spec.message(input, ctx) : spec.message,
  );
  if (message !== undefined) {
    event.message = message;
  }
  return event;
}

/**
 * Presentation is optional choreography. An application resolver that throws
 * loses its own field and nothing else, because a completed write must not
 * become a failure because the narration for it could not be built.
 */
function resolveField(
  capability: Capability,
  field: string,
  resolve: () => string | undefined,
): string | undefined {
  try {
    return resolve();
  } catch (err) {
    console.error(
      `agentdesk presentation ${field} for ${capability.name} threw`,
      err,
    );
    return undefined;
  }
}
