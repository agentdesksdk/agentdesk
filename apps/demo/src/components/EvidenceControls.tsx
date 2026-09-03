import type { EvidenceLink } from "@agentdesksdk/webmcp";
import { presentProof, proofControlName, proofLabel } from "./evidence.ts";

/**
 * One control per evidence link. Each names what it proves and whether
 * that is the value (authored) or the page (derived), as text, so the
 * two are told apart without colour. A press replays the link through the
 * runtime, which needs the capability the receipt belongs to.
 */
export function EvidenceControls({
  capability,
  links,
}: {
  capability: string;
  links: readonly EvidenceLink[];
}) {
  if (links.length === 0) {
    return null;
  }
  return (
    <>
      {links.map((link, index) => (
        <button
          key={`${link.route}#${link.reveal ?? ""}#${index}`}
          type="button"
          className="undo proof"
          aria-label={proofControlName(link)}
          onClick={() => presentProof(capability, link)}
        >
          Show me proof <span className="proof-kind">{proofLabel(link)}</span>
        </button>
      ))}
    </>
  );
}
