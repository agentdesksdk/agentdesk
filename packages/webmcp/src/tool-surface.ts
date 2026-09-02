import type { Capability } from "./capability.ts";
import { AuditBus, now } from "./audit.ts";
import { toolRetired, type ToolResult } from "./results.ts";
import type { NativeToolDefinition, WebMcpAdapter } from "./webmcp-adapter.ts";

export type { ToolResult } from "./results.ts";

export type NativeExecutor = (
  capability: Capability,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResult>;

type ActiveTool = {
  fingerprint: string;
  bytes: number;
  controller: AbortController;
  kind: "live" | "tombstone";
};

const SURFACE_BUILTINS = new Set([
  "get_context",
  "find_capabilities",
  "invoke_capability",
  "get_action_status",
]);

const encoder = new TextEncoder();

export class ToolSurfaceManager {
  private readonly active = new Map<string, ActiveTool>();
  private chain: Promise<void> = Promise.resolve();

  /**
   * `retired` builds the result a tombstone returns. The runtime supplies
   * one that reports where the retired capability now stands, because only
   * the runtime can read policy and availability. Without it the tombstone
   * still answers, with empty lists and `find_capabilities` as the repair.
   */
  constructor(
    private readonly adapter: WebMcpAdapter,
    private readonly audit: AuditBus,
    private readonly executor: NativeExecutor,
    private readonly notify?: () => void,
    private readonly exposedTo?: string[],
    private readonly retired: (name: string) => ToolResult = (name) =>
      toolRetired(name, {
        nowPossible: [],
        blockedCapabilities: [],
        evidence: [],
        repair: { capability: "find_capabilities" },
      }),
  ) {}

  private registerOptions(controller: AbortController) {
    return this.exposedTo && this.exposedTo.length > 0
      ? { signal: controller.signal, exposedTo: this.exposedTo }
      : { signal: controller.signal };
  }

  nativeNames(): string[] {
    return [...this.active.entries()]
      .filter(([, tool]) => tool.kind === "live")
      .map(([name]) => name)
      .sort();
  }

  tombstoneNames(): string[] {
    return [...this.active.entries()]
      .filter(([, tool]) => tool.kind === "tombstone")
      .map(([name]) => name)
      .sort();
  }

  /** Bytes of the serialized definitions currently registered, tombstones included. */
  schemaBytes(): number {
    let total = 0;
    for (const tool of this.active.values()) {
      total += tool.bytes;
    }
    return total;
  }

  reconcile(desired: readonly Capability[]): Promise<void> {
    const run = async () => {
      if (!this.adapter.supported) {
        this.active.clear();
        return;
      }
      const wanted = new Map<string, Capability>();
      for (const capability of desired) {
        wanted.set(capability.name, capability);
      }

      for (const [name, active] of this.active) {
        const next = wanted.get(name);
        if (next && fingerprint(next) === active.fingerprint && active.kind === "live") {
          continue;
        }
        if (!next && active.kind === "tombstone") {
          continue;
        }
        active.controller.abort();
        this.active.delete(name);
        this.audit.append({
          kind: "tool_retired",
          tool: name,
          at: now(),
        });
        if (
          active.kind === "live" &&
          !next &&
          !SURFACE_BUILTINS.has(name)
        ) {
          await this.registerTombstone(name);
        }
      }

      for (const [name, capability] of wanted) {
        const current = this.active.get(name);
        if (current?.kind === "live") {
          continue;
        }
        if (current?.kind === "tombstone") {
          current.controller.abort();
          this.active.delete(name);
        }
        await this.registerLive(capability);
      }
    };

    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  clearTombstones(): Promise<void> {
    const run = async () => {
      for (const [name, active] of this.active) {
        if (active.kind !== "tombstone") {
          continue;
        }
        active.controller.abort();
        this.active.delete(name);
        this.audit.append({
          kind: "tool_retired",
          tool: name,
          at: now(),
        });
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async clear(): Promise<void> {
    const run = async () => {
      for (const [name, active] of this.active) {
        active.controller.abort();
        this.audit.append({
          kind: "tool_retired",
          tool: name,
          at: now(),
        });
      }
      this.active.clear();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  private async registerLive(capability: Capability): Promise<void> {
    const controller = new AbortController();
    const tool = toNativeTool(capability, this.executor);
    await this.adapter.registerTool(tool, this.registerOptions(controller));
    const print = fingerprint(capability);
    this.active.set(capability.name, {
      fingerprint: print,
      bytes: encoder.encode(print).length,
      controller,
      kind: "live",
    });
    this.audit.append({
      kind: "tool_registered",
      tool: capability.name,
      at: now(),
    });
  }

  private async registerTombstone(name: string): Promise<void> {
    const controller = new AbortController();
    const tool: NativeToolDefinition = {
      name,
      description: `${name} is no longer available. Call find_capabilities and retry.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async () => {
        this.audit.append({
          kind: "capability_unavailable",
          capability: name,
          reasonCode: "CAPABILITY_RETIRED",
          at: now(),
        });
        this.notify?.();
        return this.retired(name);
      },
    };
    await this.adapter.registerTool(tool, this.registerOptions(controller));
    const print = JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    });
    this.active.set(name, {
      fingerprint: `tombstone:${name}`,
      bytes: encoder.encode(print).length,
      controller,
      kind: "tombstone",
    });
    this.audit.append({
      kind: "tool_registered",
      tool: name,
      at: now(),
    });
  }
}

function fingerprint(capability: Capability): string {
  return JSON.stringify({
    name: capability.name,
    title: capability.title,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: capability.annotations,
  });
}

function toNativeTool(
  capability: Capability,
  executor: NativeExecutor,
): NativeToolDefinition {
  const tool: NativeToolDefinition = {
    name: capability.name,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: capability.annotations,
    // The spec hands every execution an AbortSignal; forward it so a
    // cancelled client call actually cancels the handler's work.
    execute: async (input, options) => {
      const args = asRecord(input);
      return executor(capability, args, options?.signal);
    },
  };
  if (capability.title !== undefined) {
    tool.title = capability.title;
  }
  return tool;
}

function asRecord(input: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    record[key] = value;
  }
  return record;
}
