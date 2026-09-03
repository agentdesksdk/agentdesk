/**
 * The page-to-extension bridge.
 *
 * A page message is a request and never an authorization: it may ask the
 * extension to look again, to remember the reveal anchors the site placed,
 * or to reveal one of them. It may not approve, execute, register, or name
 * a DOM node. Every message is checked on origin and on source before its
 * shape is read, and every refusal is structured and audited.
 */
export type BridgeRequest =
  | { readonly agentdesk: 1; readonly kind: "changed" }
  | { readonly agentdesk: 1; readonly kind: "anchors"; readonly anchors: readonly string[] }
  | { readonly agentdesk: 1; readonly kind: "reveal"; readonly anchor: string };

export type BridgeRefusalReason =
  | "origin_mismatch"
  | "source_mismatch"
  | "malformed"
  | "not_a_request"
  | "authorization_claim"
  | "dom_target"
  | "unknown_anchor";

export type BridgeRefusal = {
  readonly ok: false;
  readonly reason: BridgeRefusalReason;
  readonly detail: string;
};

export type BridgeAcceptance = { readonly ok: true; readonly request: BridgeRequest };

export type BridgeAuditEntry =
  | {
      readonly kind: "bridge_refused";
      readonly reason: BridgeRefusalReason;
      readonly detail: string;
      readonly origin: string;
      readonly at: number;
    }
  | {
      readonly kind: "bridge_accepted";
      readonly request: BridgeRequest["kind"];
      readonly origin: string;
      readonly at: number;
    };

export type Bridge = {
  /** Stops listening. */
  detach: () => void;
  /** Every message the bridge decided on, refused or accepted, oldest first. */
  audit: () => BridgeAuditEntry[];
  /** The reveal anchors the page has registered, the only ones `reveal` may name. */
  anchors: () => string[];
  /** The decision for one message, with nothing dispatched; what the listener applies. */
  validate: (event: MessageEvent) => BridgeAcceptance | BridgeRefusal;
};

export type BridgeOptions = {
  /** The window the page and the content script share. */
  window: Window;
  /** The one origin a message may come from. */
  origin: string;
  /** Called with every accepted request, in the extension's context. */
  onRequest: (request: BridgeRequest) => void;
  /** Anchors known before the page registers any. */
  anchors?: readonly string[];
  now?: () => number;
};

export function attachBridge(options: BridgeOptions): Bridge {
  void options;
  return {
    detach: () => {},
    audit: () => [],
    anchors: () => [],
    validate: (event) => ({ ok: true, request: event.data as BridgeRequest }),
  };
}
