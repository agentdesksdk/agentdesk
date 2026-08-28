import {
  getModelContext,
  probeFeatures,
  type ModelContextLike,
  type RegisteredTool,
  type WebMcpFeatures,
} from "./webmcp-adapter.ts";

/**
 * Consumer side of WebMCP: reading and calling tools that a page (or a
 * permitted cross-origin frame) has registered.
 *
 * Deliberately separate from the runtime. AgentDesk's core job is being a
 * tool *provider* and control plane; consuming tools is a different role
 * and most applications embedding AgentDesk never need it. Import it only
 * if your page also acts as a client.
 *
 * Per-method browser parity is not guaranteed, so every method reports
 * unsupported explicitly rather than throwing an opaque TypeError.
 */
export type WebMcpClient = {
  features: WebMcpFeatures;
  listTools: (options?: {
    fromOrigins?: string[];
  }) => Promise<
    { ok: true; tools: RegisteredTool[] } | { ok: false; reason: string }
  >;
  callTool: (
    tool: RegisteredTool,
    input?: object,
    options?: { signal?: AbortSignal },
  ) => Promise<{ ok: true; output: string } | { ok: false; reason: string }>;
  onToolChange: (listener: () => void) => () => void;
};

export function createWebMcpClient(
  native: ModelContextLike | undefined = getModelContext(),
): WebMcpClient {
  const features = probeFeatures(native);

  return {
    features,

    async listTools(options) {
      if (!native?.getTools) {
        return { ok: false, reason: "getTools is not available in this browser" };
      }
      try {
        // fromOrigins is only meaningful on getTools; omit when unset so
        // engines that reject unknown members are not upset by undefined.
        const tools = await (options?.fromOrigins
          ? native.getTools({ fromOrigins: options.fromOrigins })
          : native.getTools());
        return { ok: true, tools };
      } catch (err) {
        return { ok: false, reason: describe(err) };
      }
    },

    async callTool(tool, input = {}, options) {
      if (!native?.executeTool) {
        return {
          ok: false,
          reason: "executeTool is not available in this browser",
        };
      }
      try {
        // The spec serializes inputObject internally; pass a plain object.
        const output = await native.executeTool(
          tool,
          input,
          options?.signal ? { signal: options.signal } : undefined,
        );
        return { ok: true, output };
      } catch (err) {
        return { ok: false, reason: describe(err) };
      }
    },

    onToolChange(listener) {
      if (!native?.addEventListener) {
        return () => {};
      }
      const handler = () => listener();
      native.addEventListener("toolchange", handler);
      return () => native.removeEventListener("toolchange", handler);
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
