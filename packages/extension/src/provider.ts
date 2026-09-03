import {
  createWebMcpAdapter,
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

export function extensionProvider(options: ExtensionProviderOptions): ExtensionProvider {
  const bridge = attachBridge({
    window: options.window,
    origin: options.manifest.origin,
    onRequest: () => {},
  });
  return {
    kind: "extension",
    capabilities: () => [],
    adapter: createWebMcpAdapter({ registerTool: options.registerTool }),
    subscribe: () => () => {},
    bridge,
    replace: () => {},
    detach: () => bridge.detach(),
  };
}
