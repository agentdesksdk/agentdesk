import type {
  NativeToolDefinition,
  RegisterToolFn,
} from "../src/webmcp-adapter.ts";

export type MockModelContext = {
  tools: Map<string, NativeToolDefinition>;
  aborted: string[];
  registerCalls: string[];
  registerTool: RegisterToolFn;
  execute: (
    name: string,
    input?: object,
  ) => Promise<unknown>;
};

export function createMockModelContext(): MockModelContext {
  const tools = new Map<string, NativeToolDefinition>();
  const aborted: string[] = [];
  const registerCalls: string[] = [];

  const registerTool: RegisterToolFn = async (tool, options) => {
    if (tools.has(tool.name)) {
      throw new Error(`duplicate tool: ${tool.name}`);
    }
    tools.set(tool.name, tool);
    registerCalls.push(tool.name);
    const signal = options?.signal;
    if (signal) {
      const onAbort = () => {
        tools.delete(tool.name);
        aborted.push(tool.name);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort);
    }
  };

  return {
    tools,
    aborted,
    registerCalls,
    registerTool,
    async execute(name, input = {}) {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`not registered: ${name}`);
      }
      return tool.execute(input, { signal: new AbortController().signal });
    },
  };
}
