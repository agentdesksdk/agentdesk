import type { EvidenceLink } from "@agentdesk/webmcp";

/** A person asked to be shown a link's proof. */
export type ProofRequest = { link: EvidenceLink; at: number };

export type ProofListener = (request: ProofRequest) => void;

export function subscribeProof(_listener: ProofListener): () => void {
  return () => {};
}

export function showProof(_link: EvidenceLink): void {}

export function proofLabel(_link: EvidenceLink): string {
  return "";
}

export function proofControlName(_link: EvidenceLink): string {
  return "";
}
