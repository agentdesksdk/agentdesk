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

/** Mirrors the spec's `RegisteredTool` dictionary. */
export type RegisteredTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  origin: string;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

export type ModelContextLike = EventTarget & {
  registerTool: RegisterToolFn;
  getTools?: (options?: { fromOrigins?: string[] }) => Promise<RegisteredTool[]>;
  executeTool?: (
    tool: RegisteredTool,
    inputObject?: object,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
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
