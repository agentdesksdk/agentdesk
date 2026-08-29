import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const designDir = join(root, "docs", "design");

const ANCHOR_BLOCK = /<!--\s*code-anchors\s*\n([\s\S]*?)-->/g;

/**
 * Each row is one claim a design document has to keep making, or one stale
 * claim it must never make again. The review that produced this table cited
 * three code locations that had already moved, which is why anchors below
 * name symbols rather than line numbers.
 */
const CLAIMS = [
  ["README.md", /before the hackathon submission ships/, "absent", "stale schedule gate replaced by milestone gates"],
  ["README.md", /##\s*Milestone gates/, "present", "measurable gates replace the schedule statement"],
  ["README.md", /adapter-contract\.md/, "present", "README indexes the adapter contract spec"],
  ["README.md", /operation-plan\.md/, "present", "README indexes the operation plan spec"],

  ["browser-extension.md", /`owned`/, "present", "correction 1: owned enforcement mode named"],
  ["browser-extension.md", /`augment`/, "present", "correction 1: augment enforcement mode named"],
  ["browser-extension.md", /they are the highest-trust source/, "absent", "correction 6: single trust axis removed"],

  ["browser-extension.md", /matches:\s*\["<all_urls>"\]/, "absent", "correction 2: no broad host match in the entrypoint"],
  ["browser-extension.md", /optional_host_permissions/, "present", "correction 2: per-origin grant retained"],

  ["browser-extension.md", /no MAIN world, bootstrap contract registered/, "absent", "correction 3: impossible milestone removed"],
  ["browser-extension.md", /courier/, "present", "correction 3: MAIN-world courier branch stated"],

  ["browser-extension.md", /closer to a rename than a rewrite/, "absent", "correction 7: extraction is real refactoring"],
  ["browser-extension.md", /CapabilityProvider/, "present", "correction 7: provider boundary named"],

  ["browser-extension.md", /completion accounting/, "present", "correction 8: submitted values are recorded"],

  ["auto-sdk.md", /`POST`\/`PUT`\/`PATCH`\s+write/, "absent", "correction 5: unsafe verb-to-WRITE mapping removed"],
  ["auto-sdk.md", /mutability/, "present", "correction 5: mutability axis named"],
  ["auto-sdk.md", /consequence/, "present", "correction 5: consequence axis named"],
  ["auto-sdk.md", /Any mutation is CONSEQUENTIAL/, "present", "correction 5: safe default stated"],

  ["auto-sdk.md", /CapabilityManifestEntry/, "present", "correction 4: manifest entry type named"],
  ["auto-sdk.md", /compileManifestEntry/, "present", "correction 4: compiler named"],
  ["auto-sdk.md", /mostly a rename plus an entry point/, "absent", "correction 7: extraction is real refactoring"],
  ["auto-sdk.md", /CapabilityProvider/, "present", "correction 7: provider boundary named"],

  ["adapter-contract.md", /##\s*Discovery/, "present", "adapter contract covers discovery"],
  ["adapter-contract.md", /##\s*Compilation/, "present", "adapter contract covers compilation"],
  ["adapter-contract.md", /##\s*Execution/, "present", "adapter contract covers execution"],
  ["adapter-contract.md", /##\s*Authentication/, "present", "adapter contract covers authentication"],
  ["adapter-contract.md", /##\s*Request binding/, "present", "adapter contract covers request binding"],
  ["adapter-contract.md", /##\s*Validation/, "present", "adapter contract covers validation"],
  ["adapter-contract.md", /##\s*Receipts/, "present", "adapter contract covers receipts"],
  ["adapter-contract.md", /##\s*Drift detection/, "present", "adapter contract covers drift detection"],

  ["operation-plan.md", /expectedRevision/, "present", "operation plan builds on the shipped plan type"],
  ["operation-plan.md", /docs\/architecture\.md/, "present", "operation plan defers to shipped documentation"],
];

const failures = [];

function readDoc(name) {
  const path = join(designDir, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

for (const [doc, pattern, mode, why] of CLAIMS) {
  const body = readDoc(doc);
  if (body === null) {
    failures.push(`${doc} is missing (${why})`);
    continue;
  }
  const found = pattern.test(body);
  if (mode === "present" && !found) {
    failures.push(`${doc} should match ${pattern} (${why})`);
  }
  if (mode === "absent" && found) {
    failures.push(`${doc} still matches ${pattern} (${why})`);
  }
}

let anchorCount = 0;
for (const file of readdirSync(designDir).filter((f) => f.endsWith(".md"))) {
  const body = readFileSync(join(designDir, file), "utf8");
  for (const [, block] of body.matchAll(ANCHOR_BLOCK)) {
    for (const line of block.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const [relPath, ...symbols] = line.split(/\s+/);
      const target = join(root, relPath);
      if (!existsSync(target)) {
        failures.push(`${file} anchors ${relPath}, which does not exist`);
        continue;
      }
      const source = readFileSync(target, "utf8");
      for (const symbol of symbols) {
        anchorCount += 1;
        if (!source.includes(symbol)) {
          failures.push(`${file} anchors ${relPath} \`${symbol}\`, which is gone`);
        }
      }
    }
  }
}

if (anchorCount === 0) {
  failures.push("no code anchors found; design docs must anchor the code they describe");
}

if (failures.length > 0) {
  console.error(`design doc check FAILED (${failures.length})`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`design doc check passed (${CLAIMS.length} claims, ${anchorCount} anchors)`);
