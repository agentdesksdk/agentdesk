import type { DirectCapabilitySpec } from "@agentdesk/webmcp";

/**
 * What the extension holds for one site. The capabilities are the
 * extension's own, handlers included; nothing in a manifest comes from the
 * page. `capabilities` may be a function so a scanner can answer from the
 * DOM it shares with the page each time the runtime reads it.
 */
export type ExtensionManifest = {
  /** The origin this manifest governs, and the only origin the bridge accepts a message from. */
  readonly origin: string;
  readonly capabilities: readonly DirectCapabilitySpec[] | (() => readonly DirectCapabilitySpec[]);
  /**
   * Opaque reveal anchors the site placed on its own elements as
   * `data-reveal` tokens. The only DOM the bridge will ever be asked to
   * name, and it names them by token, never by selector.
   */
  readonly anchors?: readonly string[];
};
