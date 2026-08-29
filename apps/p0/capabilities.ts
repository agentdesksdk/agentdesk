import {
  defineCapability,
  unavailable,
  AVAILABLE,
  type Capability,
} from "@agentdesk/webmcp";

/**
 * Kept free of DOM access so a test can construct them. Definition-time
 * contract violations used to surface only as a blank page in a browser.
 */
export const p0Capabilities: Capability[] = [
  defineCapability({
    name: "hello_dynamic_tool",
    title: "Hello dynamic tool",
    description:
      "Dynamically routed demo tool. Greets the given name deterministically.",
    intents: ["hello", "greet", "say hi"],
    keywords: ["hello", "greet", "dynamic"],
    routes: ["/"],
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "Who to greet" },
      },
    },
    availability: (ctx) =>
      ctx.state.helloRetired === true
        ? unavailable(
            "CAPABILITY_RETIRED",
            "hello_dynamic_tool was retired from this context.",
          )
        : AVAILABLE,
    execute: (input) => ({
      greeting: `Hello, ${typeof input.name === "string" ? input.name : "world"}!`,
      deterministic: true,
    }),
  }),
  defineCapability({
    name: "request_demo_approval",
    title: "Request demo approval",
    description:
      "Consequential demo action. Returns APPROVAL_REQUIRED immediately; a human approves or rejects in the page afterwards.",
    risk: "CONSEQUENTIAL",
    // The demo action mutates nothing, so there is no diff to show. That
    // has to be declared rather than inferred from a missing preview.
    approvalEvidence: "summary",
    intents: ["approval", "consequential"],
    keywords: ["approval", "demo", "request"],
    routes: ["/"],
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Optional note shown to the approver" },
      },
    },
    describeApproval: (input) =>
      `Demo approval${typeof input.note === "string" ? `: ${input.note}` : ""}`,
    execute: () => ({ demo_action: "executed after human approval" }),
  }),
  defineCapability({
    name: "ping",
    title: "Ping",
    description: "Compatibility-path ping. Call through invoke_capability.",
    keywords: ["ping", "pong"],
    routes: ["/"],
    execute: () => "pong",
  }),
  defineCapability({
    name: "alpha_scene_tool",
    title: "Alpha scene tool",
    description: "Native tool only available on the /alpha scene.",
    surface: "native",
    available: (ctx) => ctx.route === "/alpha",
    execute: () => ({ scene: "alpha" }),
  }),
  defineCapability({
    name: "beta_scene_tool",
    title: "Beta scene tool",
    description: "Native tool only available on the /beta scene.",
    surface: "native",
    available: (ctx) => ctx.route === "/beta",
    execute: () => ({ scene: "beta" }),
  }),
];
