import type { EvidenceLink } from "@agentdesk/webmcp";

/** A person asked to be shown a link's proof. */
export type ProofRequest = { link: EvidenceLink; at: number };

export type ProofListener = (request: ProofRequest) => void;

const listeners = new Set<ProofListener>();

/**
 * The proof stream. Every "Show me proof" control publishes here, and the
 * presence component is the one subscriber, so a request takes the same
 * navigate-and-reveal path the runtime's presentation events take. The SDK
 * exposes no way to emit a presentation event on demand; this is the seam
 * that closes when it does.
 */
export function subscribeProof(listener: ProofListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function showProof(link: EvidenceLink): void {
  const request: ProofRequest = { link, at: Date.now() };
  for (const listener of listeners) {
    try {
      listener(request);
    } catch (err) {
      console.error("agentdesk proof listener threw", err);
    }
  }
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
