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
    input?: object | string,
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
      const callOptions = options?.signal ? { signal: options.signal } : undefined;
      // The spec types inputObject as `object` and serializes it
      // internally, but Chrome 152 rejects an object with "Failed to parse
      // input arguments" and requires a pre-serialized JSON string
      // (observed 2026-08-29). Send the string, then fall back to the
      // object so a spec-conformant implementation also works.
      const serialized =
        typeof input === "string" ? input : JSON.stringify(input ?? {});
      try {
        return {
          ok: true,
          output: await native.executeTool(tool, serialized, callOptions),
        };
      } catch (stringErr) {
        // A cancelled call must not be retried, and a caller who supplied
        // their own string gets their error verbatim.
        if (typeof input === "string" || options?.signal?.aborted) {
          return { ok: false, reason: describe(stringErr) };
        }
        try {
          return {
            ok: true,
            output: await native.executeTool(tool, input, callOptions),
          };
        } catch {
          return { ok: false, reason: describe(stringErr) };
        }
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
