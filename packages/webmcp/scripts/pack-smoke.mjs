import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Packs the tarball, unpacks it into a throwaway node_modules, and imports
 * it with plain Node. This is what a real consumer gets, and it is the
 * thing the workspace bundler would otherwise hide: if `dist` is missing
 * from the tarball or the exports map is wrong, this fails.
 */
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "agentdesk-pack-"));
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

function run(cmd, args, cwd) {
  const shell = isWindows && cmd.endsWith(".cmd");
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe", shell });
}

try {
  const packed = run(npm, ["pack", "--pack-destination", work], pkgDir)
    .trim()
    .split("\n")
    .pop()
    .trim();

  const target = join(work, "node_modules", "@agentdesk", "webmcp");
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", join(work, packed), "-C", target, "--strip-components=1"], work);

  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ name: "smoke", private: true, type: "module" }, null, 2),
  );

  writeFileSync(
    join(work, "smoke.mjs"),
    `
import {
  createAgentDeskRuntime,
  defineCapability,
  receipt,
} from "@agentdesk/webmcp";
import assert from "node:assert/strict";

const tools = new Map();
const runtime = createAgentDeskRuntime({
  registerTool: async (tool) => tools.set(tool.name, tool),
  capabilities: [
    defineCapability({
      name: "refund_shipping",
      description: "Refund the shipping fee for an order",
      risk: "CONSEQUENTIAL",
      inputSchema: {
        type: "object",
        required: ["order_id"],
        properties: { order_id: { type: "string" } },
      },
      previewChanges: () => [
        { field: "refunded", before: false, after: true },
      ],
      execute: (input) =>
        receipt({
          entity: \`Order #\${input.order_id}\`,
          changes: [{ field: "refunded", before: false, after: true }],
          result: { ok: true },
        }),
    }),
  ],
});

await runtime.start();
assert.deepEqual([...tools.keys()].sort(), [
  "find_capabilities",
  "get_action_status",
  "get_context",
  "invoke_capability",
]);

const queued = await runtime.invoke("refund_shipping", { order_id: "10428" });
assert.equal(queued.code, "APPROVAL_REQUIRED");
assert.equal(queued.data.approvalEvidence, "diff");
assert.equal(queued.data.will_change.length, 1);

const rejected = await runtime.invoke("refund_shipping", { order_id: 10428 });
assert.equal(rejected.code, "VALIDATION_FAILED");

const id = runtime.getSnapshot().pending[0].id;
const done = await runtime.approve(id);
const payload = JSON.parse(done.content[0].text);
assert.equal(payload.status, "COMPLETED");
assert.equal(payload.receipt.entity, "Order #10428");

console.log("pack smoke ok: built package imported and pipeline ran under plain Node");
`,
  );

  process.stdout.write(run(process.execPath, ["smoke.mjs"], work));
} finally {
  rmSync(work, { recursive: true, force: true });
}
