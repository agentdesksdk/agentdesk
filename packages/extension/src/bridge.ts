/**
 * The page-to-extension bridge.
 *
 * A page message is a request and never an authorization: it may ask the
 * extension to look again, to remember the reveal anchors the site placed,
 * or to reveal one of them. It may not approve, execute, register, or name
 * a DOM node. Every message is checked on origin and on source before its
 * shape is read, and every refusal is structured and audited.
 *
 * Origin and source are routing facts, not authentication: they say which
 * frame sent a message, not that anyone trustworthy did. That is why the
 * request vocabulary is the whole of what a page can cause. Nothing the
 * bridge accepts changes what the runtime decides, only when it looks.
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

/**
 * What the bridge hands the one audit for a refusal: the reason, and a
 * detail object the runtime does not interpret, carrying the bridge's own
 * sentence, the origin the message came from, and the kind it claimed.
 */
export type BridgeRefused = {
  readonly reason: BridgeRefusalReason;
  readonly detail: { readonly detail: string; readonly origin: string; readonly kind?: string };
};

export type Bridge = {
  /** Stops listening. */
  detach: () => void;
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
  /**
   * Called with every refusal of a message addressed to the bridge. The
   * bridge keeps no log of its own: this is the way into the one audit.
   */
  onRefused?: (refusal: BridgeRefused) => void;
  /** Anchors known before the page registers any. */
  anchors?: readonly string[];
};

/** What a page may ask for. Anything else addressed to the bridge is a forgery. */
const REQUEST_KINDS = new Set(["changed", "anchors", "reveal"]);

/**
 * Keys that would let a message name a DOM node. A reveal names a token the
 * site registered, never a node, so these are refused wherever they sit.
 */
const DOM_TARGET_KEYS = new Set(["selector", "target", "element", "node", "xpath", "css", "query"]);

/**
 * Keys that would let a message claim an authorization. The extension keeps
 * every authorization; a page-supplied one is ignored by refusing the
 * whole message rather than by stripping it, so the page learns it was
 * refused and nothing downstream sees a message that once carried it.
 */
const AUTHORIZATION_KEYS = new Set(["approved", "approval", "actor", "by", "human", "token", "gesture", "grant"]);

/** The reveal token grammar `docs/accessibility.md` fixes, so nothing survives into a selector. */
const ANCHOR = /^[a-z0-9][a-z0-9-]*$/i;

const MAX_DEPTH = 8;

/** The first key from `keys` found anywhere in `value`, as a path. */
function findKey(value: unknown, keys: ReadonlySet<string>, path = "", depth = 0): string | undefined {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findKey(item, keys, `${path}[${index}]`, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (keys.has(key)) {
      return here;
    }
    const found = findKey(inner, keys, here, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function refuse(reason: BridgeRefusalReason, detail: string): BridgeRefusal {
  return { ok: false, reason, detail };
}

export function attachBridge(options: BridgeOptions): Bridge {
  const registered = new Set<string>(options.anchors ?? []);

  const validate = (event: MessageEvent): BridgeAcceptance | BridgeRefusal => {
    // Where it came from, then which window, then what it says. A message
    // from the wrong origin is refused before its shape is read, so its
    // shape cannot be used to probe the bridge from elsewhere.
    if (event.origin !== options.origin) {
      return refuse(
        "origin_mismatch",
        `expected a message from ${options.origin} and got one from ${event.origin || "an unknown origin"}`,
      );
    }
    if (event.source !== options.window) {
      return refuse(
        "source_mismatch",
        event.source === null || event.source === undefined
          ? "the message names no source window"
          : "the message came from a window other than the page's own",
      );
    }
    const data = event.data as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return refuse("malformed", "a bridge message is an object");
    }
    const message = data as Record<string, unknown>;
    if (message.agentdesk !== 1) {
      return refuse("malformed", "a bridge message carries agentdesk: 1");
    }
    const kind = message.kind;
    if (typeof kind !== "string") {
      return refuse("malformed", "a bridge message names its kind");
    }
    if (!REQUEST_KINDS.has(kind)) {
      return refuse(
        "not_a_request",
        `page context may request and never authorize: ${kind} is not something a page can ask for`,
      );
    }
    const claim = findKey(message, AUTHORIZATION_KEYS);
    if (claim !== undefined) {
      return refuse(
        "authorization_claim",
        `a page message may not carry ${claim}; the extension keeps every authorization`,
      );
    }
    const target = findKey(message, DOM_TARGET_KEYS);
    if (target !== undefined) {
      return refuse(
        "dom_target",
        `a page message may not name a DOM node (${target}); it names a reveal anchor the site registered`,
      );
    }
    if (kind === "changed") {
      return { ok: true, request: { agentdesk: 1, kind: "changed" } };
    }
    if (kind === "anchors") {
      const anchors = message.anchors;
      if (!Array.isArray(anchors) || anchors.some((anchor) => typeof anchor !== "string" || !ANCHOR.test(anchor))) {
        return refuse("malformed", "anchors are tokens matching [a-z0-9][a-z0-9-]*");
      }
      return { ok: true, request: { agentdesk: 1, kind: "anchors", anchors: [...(anchors as string[])] } };
    }
    const anchor = message.anchor;
    if (typeof anchor !== "string" || !ANCHOR.test(anchor)) {
      return refuse("malformed", "a reveal anchor is a token matching [a-z0-9][a-z0-9-]*");
    }
    if (!registered.has(anchor)) {
      return refuse("unknown_anchor", `${anchor} is not an anchor the page registered`);
    }
    return { ok: true, request: { agentdesk: 1, kind: "reveal", anchor } };
  };

  const listener = (event: Event): void => {
    const message = event as MessageEvent;
    const data = message.data as unknown;
    // Traffic that never addressed the bridge is not the bridge's to audit:
    // a page talks to itself and to others on the same window.
    if (typeof data !== "object" || data === null || !("agentdesk" in (data as object))) {
      return;
    }
    const decision = validate(message);
    if (!decision.ok) {
      const claimed = (data as { kind?: unknown }).kind;
      options.onRefused?.({
        reason: decision.reason,
        detail: {
          detail: decision.detail,
          origin: message.origin,
          ...(typeof claimed === "string" ? { kind: claimed } : {}),
        },
      });
      return;
    }
    if (decision.request.kind === "anchors") {
      for (const anchor of decision.request.anchors) {
        registered.add(anchor);
      }
    }
    options.onRequest(decision.request);
  };

  options.window.addEventListener("message", listener);

  return {
    detach: () => options.window.removeEventListener("message", listener),
    anchors: () => [...registered].sort(),
    validate,
  };
}
