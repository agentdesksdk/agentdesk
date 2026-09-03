import { describe, expect, it } from "vitest";
import { createAgentDeskRuntime, type ToolResult } from "@agentdesksdk/webmcp";
import { p0Capabilities } from "../capabilities.ts";

/**
 * The harness is a plain browser entry with no framework, so a
 * definition-time throw used to show up only as a page stuck on
 * "Checking WebMCP…" with zero registered tools. These run the same
 * startup path headlessly.
 */
describe("P0 harness startup", () => {
  it("constructs every capability without throwing", () => {
    expect(p0Capabilities.length).toBeGreaterThan(0);
    for (const capability of p0Capabilities) {
      expect(capability.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("every consequential capability declares its approval evidence", () => {
    for (const capability of p0Capabilities) {
      if (capability.risk === "CONSEQUENTIAL") {
        expect(["diff", "summary"]).toContain(capability.approvalEvidence);
      }
    }
  });

  it("starts a runtime and registers the bootstrap tools", async () => {
    const tools = new Map<string, unknown>();
    const runtime = createAgentDeskRuntime({
      capabilities: p0Capabilities,
      registerTool: async (tool) => {
        tools.set(tool.name, tool);
      },
    });
    await runtime.start();
    expect([...tools.keys()].sort()).toEqual([
      "find_capabilities",
      "get_action_status",
      "get_context",
      "invoke_capability",
    ]);
    expect(runtime.getSnapshot().started).toBe(true);
  });

  it("runs the manual checklist the page documents", async () => {
    const runtime = createAgentDeskRuntime({
      capabilities: p0Capabilities,
      registerTool: async () => {},
    });
    await runtime.start();

    const hello = await runtime.invoke("hello_dynamic_tool", { name: "P0" });
    expect(JSON.parse(hello.content[0]!.text)).toEqual({
      greeting: "Hello, P0!",
      deterministic: true,
    });

    const compat = await runtime.invoke("invoke_capability", { name: "ping" });
    expect(compat.content[0]!.text).toBe("pong");

    const approval = await runtime.invoke("request_demo_approval", {
      note: "startup test",
    });
    expect(approval.code).toBe("APPROVAL_REQUIRED");
    expect(approval.data?.approvalEvidence).toBe("summary");

    const id = runtime.getSnapshot().pending[0]!.id;
    const executed = await runtime.approve(id, { id: "operator", name: "Operator", kind: "human" });
    expect(JSON.parse(executed.content[0]!.text)).toEqual({
      demo_action: "executed after human approval",
    });

    await runtime.setContext({ route: "/", state: { helloRetired: true } });
    const retired: ToolResult = await runtime.invoke("hello_dynamic_tool", {
      name: "P0",
    });
    expect(retired.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(retired.data?.reasonCode).toBe("CAPABILITY_RETIRED");
  });
});
