import type { Capability } from "./capability.ts";
import {
  createWebMcpAdapter,
  type RegisterToolFn,
  type WebMcpAdapter,
} from "./webmcp-adapter.ts";

/**
 * Where a runtime's capabilities come from, and the registration seam they
 * are published through.
 *
 * A provider supplies capabilities, a way to read them again when they
 * change, and the adapter the runtime's tool surface drives. It supplies
 * nothing else: policy, approval, routing, audit, results, and the surface
 * itself stay the runtime's, so two providers governed by one runtime are
 * governed the same way.
 */
export type CapabilityProvider = {
  /** What kind of source this is: `native` for the SDK's own, `extension` later. */
  readonly kind: string;
  /**
   * The capabilities supplied right now. Read once at construction and
   * again whenever the provider announces a change.
   */
  capabilities: () => readonly Capability[];
  /**
   * The registration seam. The one WebMCP-specific object, constructed by
   * the provider and driven only by the runtime's `ToolSurfaceManager`.
   */
  readonly adapter: WebMcpAdapter;
  /**
   * Announces that `capabilities()` would answer differently now. Returns
   * the unsubscribe. A provider whose catalog is fixed for its lifetime
   * omits it.
   */
  subscribe?: (listener: () => void) => () => void;
  /**
   * Receives what the runtime hands every provider at start: a way to put
   * a refusal into the operator's audit. Returns the disconnect, called at
   * stop. A provider that refuses nothing omits it.
   */
  connect?: (hooks: ProviderHooks) => void | (() => void);
};

/** What a provider refused, in its own words; the runtime interprets none of it. */
export type ProviderRefusal = {
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
};

/** What the runtime hands a provider at start. */
export type ProviderHooks = {
  /** Records a `provider_refused` audit event under this provider's kind. */
  refused: (refusal: ProviderRefusal) => void;
};

export type NativeProviderOptions = {
  capabilities?: readonly Capability[];
  /** Inject a registration function, or `null` to declare WebMCP absent. */
  registerTool?: RegisterToolFn | null;
  /** An adapter already built; takes precedence over `registerTool`. */
  adapter?: WebMcpAdapter;
};

/**
 * The shipped path as the first provider: the capabilities the application
 * declared, published through the page's own model context or through the
 * `registerTool` a test or a page injects. Its catalog never changes.
 */
export function nativeProvider(options: NativeProviderOptions = {}): CapabilityProvider {
  const capabilities = Object.freeze([...(options.capabilities ?? [])]);
  const adapter =
    options.adapter ??
    createWebMcpAdapter(
      options.registerTool !== undefined ? { registerTool: options.registerTool } : undefined,
    );
  return {
    kind: "native",
    capabilities: () => capabilities,
    adapter,
  };
}
