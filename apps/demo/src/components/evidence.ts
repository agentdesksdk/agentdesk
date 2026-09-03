import type { EvidenceLink } from "@agentdesksdk/webmcp";
import { agentdesk } from "../runtime/agentdesk.ts";

/**
 * A person asked to be shown a link's proof. The request goes through the
 * runtime's own presentation bus, as a replay of the navigate-and-reveal
 * event the runtime emits for a completed write, so the one consumer that
 * reveals a write reveals its proof by the same path. A replay carries no
 * execution id, because nothing executed; that is how the consumer tells
 * a person's request from the runtime's own events.
 */
export function presentProof(capability: string, link: EvidenceLink): void {
  agentdesk.present({
    capability,
    route: link.route,
    ...(link.reveal !== undefined ? { reveal: link.reveal } : {}),
    message: `Showing ${link.label}.`,
  });
}

/**
 * An authored link was written by the capability that made the change, so
 * it names the value; a derived one is only the write's page, because a
 * presentation hint was all the runtime had.
 */
export function proofKind(link: EvidenceLink): "value" | "page" {
  return link.source === "authored" ? "value" : "page";
}

/** "value: Shipping refund on Order #10428", "page: Order #10428". */
export function proofLabel(link: EvidenceLink): string {
  return `${proofKind(link)}: ${link.label}`;
}

/** The control's accessible name: what it shows, and how precise that is. */
export function proofControlName(link: EvidenceLink): string {
  return `Show me proof: ${link.label}, ${
    link.source === "authored" ? "the value that changed" : "the page it changed on"
  }`;
}
