/**
 * Mirrors the spec's `ModelContextTool` dictionary. Annotations are
 * exactly the two keys the spec defines; there are no others.
 */
export type NativeToolDefinition = {
  name: string;
  description: string;
  title?: string;
  inputSchema: object;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (
    input: object,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
};

/**
 * Mirrors `ModelContextRegisterToolOptions`. `signal` unregisters the tool
 * when aborted; `exposedTo` restricts which origins may see it.
 */
export type RegisterToolOptions = {
  signal?: AbortSignal;
  exposedTo?: string[];
};

export type RegisterToolFn = (
  tool: NativeToolDefinition,
  options?: RegisterToolOptions,
) => Promise<void>;

export type WebMcpAdapter = {
  supported: boolean;
  registerTool: RegisterToolFn;
  /**
   * Which parts of the WebMCP surface this browser actually exposes.
   * Per-method parity is not guaranteed by the spec, so probe rather
   * than assume.
   */
  features: WebMcpFeatures;
};

export type WebMcpFeatures = {
  registerTool: boolean;
  getTools: boolean;
  executeTool: boolean;
  toolChangeEvent: boolean;
};

/**
 * Mirrors the spec's `RegisteredTool` dictionary.
 *
 * `inputSchema` is a union because two generations are in the field at once.
 * webmcp#241 made it a JSON Schema object, rolling out from Chrome 154; every
 * earlier build, and 154's same-document tools, still return the serialized
 * JSON string it replaced. Read it with `readInputSchema` rather than
 * assuming either arm.
 *
 * `title` is not a safe `??` fallback. The spec defaults it to the empty
 * string when a tool registers no title, and `""` does not fall through, so
 * a display name is `tool.title || tool.name`.
 */
export type RegisteredTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object | string;
  origin: string;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

export type ModelContextLike = EventTarget & {
  registerTool: RegisterToolFn;
  getTools?: (options?: { fromOrigins?: string[] }) => Promise<RegisteredTool[]>;
  /**
   * A Chromium extension rather than a member of the standard
   * `ModelContext`, so it is feature-detected everywhere it is used. It
   * resolves `null` when a tool produces no textual output.
   */
  executeTool?: (
    tool: RegisteredTool,
    inputObject?: object | string,
    options?: { signal?: AbortSignal },
  ) => Promise<string | null>;
};

type ModelContextHost = {
  document?: { modelContext?: ModelContextLike };
};

const UNSUPPORTED: WebMcpFeatures = {
  registerTool: false,
  getTools: false,
  executeTool: false,
  toolChangeEvent: false,
};

export function getModelContext(): ModelContextLike | undefined {
  return (globalThis as ModelContextHost).document?.modelContext;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * `exposedTo` widens who can see a tool, so a malformed or downgraded
 * entry is a security-relevant configuration error, not a preference.
 * WebMCP is `[SecureContext]`, so an http origin cannot legitimately be a
 * peer. Throws rather than filtering: silently dropping an entry would
 * leave the author believing an origin was granted access.
 */
export function assertSafeOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    if (origin === "*" || origin.includes("*")) {
      throw new Error(
        `exposedTo does not accept wildcards, received ${origin}`,
      );
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`exposedTo entry is not a valid origin: ${origin}`);
    }
    if (url.origin !== origin.replace(/\/$/, "")) {
      throw new Error(
        `exposedTo entries must be bare origins with no path, received ${origin}`,
      );
    }
    const isLoopback = LOOPBACK.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      throw new Error(
        `exposedTo requires a secure origin, received ${origin}`,
      );
    }
  }
}

export function probeFeatures(
  native: ModelContextLike | undefined = getModelContext(),
): WebMcpFeatures {
  if (!native) {
    return { ...UNSUPPORTED };
  }
  return {
    registerTool: typeof native.registerTool === "function",
    getTools: typeof native.getTools === "function",
    executeTool: typeof native.executeTool === "function",
    toolChangeEvent: typeof native.addEventListener === "function",
  };
}

export function createWebMcpAdapter(deps?: {
  registerTool?: RegisterToolFn | null;
}): WebMcpAdapter {
  if (deps?.registerTool === null) {
    return {
      supported: false,
      registerTool: async () => {},
      features: { ...UNSUPPORTED },
    };
  }
  if (deps?.registerTool) {
    return {
      supported: true,
      registerTool: deps.registerTool,
      features: { ...UNSUPPORTED, registerTool: true },
    };
  }
  const native = getModelContext();
  if (!native?.registerTool) {
    return {
      supported: false,
      registerTool: async () => {},
      features: { ...UNSUPPORTED },
    };
  }
  return {
    supported: true,
    registerTool: (tool, options) => native.registerTool(tool, options),
    features: probeFeatures(native),
  };
}
