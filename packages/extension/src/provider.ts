import {
  createWebMcpAdapter,
  defineCapability,
  type Capability,
  type CapabilityProvider,
  type RegisterToolFn,
} from "@agentdesk/webmcp";
import { attachBridge, type Bridge } from "./bridge.ts";
import type { ExtensionManifest } from "./manifest.ts";

export type ExtensionProviderOptions = {
  manifest: ExtensionManifest;
  /**
   * The extension's own registration: the isolated world's model context,
   * or a test's double. Never the page's, and never relayed through it.
   */
  registerTool: RegisterToolFn;
  /** The window the page and the content script share. */
  window: Window;
  /** Called when the page asks to reveal an anchor it registered. */
  onReveal?: (anchor: string) => void;
  now?: () => number;
};

export type ExtensionProvider = CapabilityProvider & {
  readonly bridge: Bridge;
  /** The extension replaced what it holds for the site; the runtime is told. */
  replace: (manifest: ExtensionManifest) => void;
  detach: () => void;
};

/**
 * The extension context as a `CapabilityProvider`.
 *
 * Capabilities come from the manifest the extension holds for the site,
 * handlers included, so nothing the page says becomes a capability. The
 * adapter is the extension's own `registerTool`, so registration never
 * crosses into page script. `subscribe` fires when the page reports a
 * change through the bridge, or when the extension replaces the manifest;
 * either way the runtime reads `capabilities()` again, and a manifest whose
 * capabilities are a function answers from the DOM as it is now.
 */
export function extensionProvider(options: ExtensionProviderOptions): ExtensionProvider {
  let manifest = options.manifest;
  const listeners = new Set<() => void>();
  const announce = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const bridge = attachBridge({
    window: options.window,
    origin: manifest.origin,
    ...(manifest.anchors !== undefined ? { anchors: manifest.anchors } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    onRequest: (request) => {
      if (request.kind === "changed") {
        announce();
      } else if (request.kind === "reveal") {
        options.onReveal?.(request.anchor);
      }
      // `anchors` is remembered by the bridge itself.
    },
  });

  const capabilities = (): readonly Capability[] => {
    const specs = typeof manifest.capabilities === "function" ? manifest.capabilities() : manifest.capabilities;
    return specs.map((spec) => defineCapability(spec));
  };

  return {
    kind: "extension",
    capabilities,
    adapter: createWebMcpAdapter({ registerTool: options.registerTool }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bridge,
    replace: (next) => {
      if (next.origin !== manifest.origin) {
        throw new Error(
          `a provider is bound to ${manifest.origin}; a manifest for ${next.origin} needs a provider of its own`,
        );
      }
      manifest = next;
      announce();
    },
    detach: () => {
      listeners.clear();
      bridge.detach();
    },
  };
}
