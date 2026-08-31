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
/**
 * How `executeTool` input is encoded. The spec types it as `object` and
 * serializes internally, but Chrome 152 rejects an object with "Failed to
 * parse input arguments" and requires a pre-serialized JSON string
 * (observed 2026-08-29), so `string` is the default.
 */
export type InputEncoding = "string" | "object";

export type WebMcpClientOptions = {
  encoding?: InputEncoding;
};

export type NegotiationRequest = {
  /** Must be declared `readOnlyHint`; negotiation may invoke it twice. */
  tool: RegisteredTool;
  /** Arguments the probe requires. Defaults to `{}`. */
  input?: object;
};

export type WebMcpClient = {
  features: WebMcpFeatures;
  /** The encoding used for every call. Never changed by `callTool`. */
  readonly encoding: InputEncoding;
  /**
   * Opt-in encoding discovery. Requires a tool the caller has declared
   * `readOnlyHint`, because it may invoke that tool twice. `callTool`
   * never negotiates, so a write is never used to probe the browser.
   *
   * Supply `input` when the probe takes required arguments; empty input
   * would be rejected on both attempts and look like neither encoding
   * works.
   */
  negotiateEncoding: (
    request: NegotiationRequest,
  ) => Promise<
    { ok: true; encoding: InputEncoding } | { ok: false; reason: string }
  >;
  listTools: (options?: {
    fromOrigins?: string[];
  }) => Promise<
    { ok: true; tools: RegisteredTool[] } | { ok: false; reason: string }
  >;
  callTool: (
    tool: RegisteredTool,
    input?: object | string,
    options?: { signal?: AbortSignal },
  ) => Promise<
    { ok: true; output: string | null } | { ok: false; reason: string }
  >;
  onToolChange: (listener: () => void) => () => void;
};

export function createWebMcpClient(
  native: ModelContextLike | undefined = getModelContext(),
  options: WebMcpClientOptions = {},
): WebMcpClient {
  const features = probeFeatures(native);
  let encoding: InputEncoding = options.encoding ?? "string";

  const serialize = (
    input: object | string,
  ): { ok: true; value: object | string } | { ok: false; reason: string } => {
    if (typeof input === "string" || encoding === "object") {
      return { ok: true, value: input };
    }
    try {
      const text = JSON.stringify(input ?? {});
      if (text === undefined) {
        return { ok: false, reason: "input did not serialize to JSON" };
      }
      return { ok: true, value: text };
    } catch (err) {
      return {
        ok: false,
        reason: `could not serialize input: ${describe(err)}`,
      };
    }
  };

  return {
    features,

    get encoding() {
      return encoding;
    },

    async negotiateEncoding({ tool: probe, input = {} }) {
      if (!native?.executeTool) {
        return {
          ok: false,
          reason: "executeTool is not available in this browser",
        };
      }
      // Negotiation calls a tool twice in the worst case, so it may only
      // run against a tool the caller has declared read-only. The
      // requested operation is never used to discover the encoding.
      if (probe.annotations?.readOnlyHint !== true) {
        return {
          ok: false,
          reason: `${probe.name} is not declared readOnlyHint; negotiation may invoke the probe twice, so it must be a read-only tool`,
        };
      }
      let text: string;
      try {
        text = JSON.stringify(input ?? {}) ?? "{}";
      } catch (err) {
        return {
          ok: false,
          reason: `could not serialize probe input: ${describe(err)}`,
        };
      }
      for (const candidate of ["string", "object"] as const) {
        try {
          await native.executeTool(
            probe,
            candidate === "string" ? text : input,
            undefined,
          );
          encoding = candidate;
          return { ok: true, encoding };
        } catch {
          continue;
        }
      }
      return {
        ok: false,
        reason: `neither encoding was accepted by ${probe.name}; the probe input may also be invalid for that tool`,
      };
    },

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
      const prepared = serialize(input);
      if (!prepared.ok) {
        return prepared;
      }
      // Exactly one invocation, always. Error text cannot prove a handler
      // did not already commit, so the encoding is settled before the call
      // rather than discovered by retrying the caller's operation.
      try {
        return {
          ok: true,
          output: await native.executeTool(
            tool,
            prepared.value,
            options?.signal ? { signal: options.signal } : undefined,
          ),
        };
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

/**
 * Reads a registered tool's input schema across both generations.
 *
 * Chrome 149 through 153, and 154's same-document tools, return the schema
 * as a serialized JSON string; webmcp#241 replaced that with an object from
 * 154 onward. A consumer that assumes either arm breaks on the other half of
 * the field, and a bare `JSON.parse` on the string arm turns a malformed
 * schema into a thrown exception in the middle of tool discovery.
 *
 * Both arms are judged by the same check, because a schema that is invalid
 * as an object is invalid serialized too. Validity that depended on the
 * transport encoding would defeat the point of normalizing the generations.
 *
 * Only an omitted member is absence. An explicit `null` is a value the
 * browser sent, and reading it as omission would hide a malformed response.
 */
export function readInputSchema(
  tool: Pick<RegisteredTool, "name" | "inputSchema">,
):
  | { ok: true; schema: object | undefined }
  | { ok: false; reason: string } {
  const raw = tool.inputSchema;
  if (raw === undefined) {
    return { ok: true, schema: undefined };
  }

  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        reason: `${tool.name} reported an input schema string that is not JSON: ${describe(err)}`,
      };
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: `${tool.name} reported an input schema that is not a JSON object`,
    };
  }
  return { ok: true, schema: value };
}
