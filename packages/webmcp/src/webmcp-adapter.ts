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

export type RegisterToolFn = (
  tool: NativeToolDefinition,
  options?: { signal?: AbortSignal },
) => Promise<void>;

export type WebMcpAdapter = {
  supported: boolean;
  registerTool: RegisterToolFn;
};

type ModelContextHost = {
  document?: {
    modelContext?: {
      registerTool: RegisterToolFn;
    };
  };
};

export function createWebMcpAdapter(deps?: {
  registerTool?: RegisterToolFn | null;
}): WebMcpAdapter {
  if (deps?.registerTool === null) {
    return {
      supported: false,
      registerTool: async () => {},
    };
  }
  if (deps?.registerTool) {
    return {
      supported: true,
      registerTool: deps.registerTool,
    };
  }
  const native = (globalThis as ModelContextHost).document?.modelContext;
  if (!native?.registerTool) {
    return {
      supported: false,
      registerTool: async () => {},
    };
  }
  return {
    supported: true,
    registerTool: (tool, options) => native.registerTool(tool, options),
  };
}
