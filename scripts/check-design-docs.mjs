import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const designDir = join(root, "docs", "design");

/**
 * Anchors are read from every documentation tree, not just `docs/design`.
 * The rollback state machine grew a fourth state while `docs/architecture.md`
 * still described three, and this check passed the whole time because it was
 * only ever pointed at one directory.
 */
const ANCHORED_DIRS = [
  designDir,
  join(root, "docs"),
  join(root, "docs", "reviews"),
];

const ANCHOR_BLOCK = /<!--\s*code-anchors\s*\n([\s\S]*?)-->/g;

/**
 * Onboarding examples the compiler owns.
 *
 * The README taught `staging: { adapter, write }` for a release after the
 * runtime started rejecting it, because prose can describe an API that no
 * longer exists. Each entry names a real source file that `pnpm typecheck`
 * compiles, and the region between its markers has to appear in the document
 * verbatim.
 */
const COMPILED_EXAMPLES = [
  {
    doc: "README.md",
    source: join(root, "packages", "webmcp", "examples", "staged-capability.ts"),
    region: "readme",
    why: "the staged-capability example must be the shape the runtime accepts",
  },
];

function checkCompiledExamples() {
  const failures = [];
  for (const { doc, source, region, why } of COMPILED_EXAMPLES) {
    if (!existsSync(source)) {
      failures.push(`${doc}: missing compiled example ${source} (${why})`);
      continue;
    }
    // Carriage returns are stripped first, because a CRLF checkout must not
    // fail a check that is about the text.
    const lf = (value) => value.replaceAll("\r", "");
    const text = lf(readFileSync(source, "utf8"));
    const open = `// #region ${region}
`;
    const start = text.indexOf(open);
    const end = text.indexOf(`// #endregion ${region}`);
    if (start === -1 || end === -1) {
      failures.push(`${source}: no #region ${region} markers`);
      continue;
    }
    const snippet = text.slice(start + open.length, end).trimEnd();
    if (!lf(readFileSync(join(root, doc), "utf8")).includes(snippet)) {
      failures.push(
        `${doc}: the ${region} example has drifted from ${source} (${why})`,
      );
    }
  }
  return failures;
}


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

  ["docs/architecture.md", /INDETERMINATE/, "present", "architecture names the fourth rollback state"],
  ["docs/architecture.md", /reconcileRollback/, "present", "architecture names the only exit from it"],
  ["docs/architecture.md", /rollbackVerification/, "present", "architecture says how a rollback was proven"],
  ["docs/architecture.md", /verifyRollback/, "present", "architecture names the rollback-specific verifier"],
  ["docs/architecture.md", /rollbackEvidence/, "present", "architecture names the deliberate opt-out"],
  ["docs/architecture.md", /the receipt returns to READY/, "absent", "a thrown rollback no longer returns to READY"],
  ["docs/architecture.md", /rollbackState` of READY, ROLLING_BACK, or\s+ROLLED_BACK/, "absent", "the three-state enumeration is stale"],

  ["docs/architecture.md", /##\s*The result protocol/, "present", "architecture states the one result shape"],
  ["docs/architecture.md", /nowPossible/, "present", "architecture names what a result says is possible"],
  ["docs/architecture.md", /blockedCapabilities/, "present", "architecture names what a result says is blocked"],
  ["docs/architecture.md", /Denied is invisible; unavailable is visible/, "present", "architecture states the denied/unavailable line"],
  ["docs/architecture.md", /suggested alternatives/, "absent", "availability carries a checked repair, not a free-text suggestion"],
  ["docs/routing.md", /the runtime's behaviour is unchanged by this document/, "absent", "the runtime now filters denied capabilities before ranking"],
  ["docs/routing.md", /##\s*The report's situation/, "present", "routing states what the report lists as possible and blocked"],

  ["docs/architecture.md", /##\s*Scoped authority grants/, "present", "architecture states the grant contract"],
  ["docs/architecture.md", /A grant never widens policy/, "present", "architecture states that a grant narrows approval only"],
  ["docs/architecture.md", /spent at the execution claim, before the first await/, "present", "architecture states when a use is spent"],
  ["docs/architecture.md", /GRANT_REFUSED/, "absent", "a grant that does not apply falls through to approval; there is no refusal code"],
  ["docs/architecture.md", /A grant that does not apply changes nothing/, "present", "architecture states the fall-through"],
  ["docs/architecture.md", /grant_not_applied/, "present", "architecture names the audit kind for a grant that did not apply"],

  ["docs/architecture.md", /##\s*An approval is bound to a state digest/, "present", "architecture states the state digest contract"],
  ["docs/architecture.md", /requiresNewPreview/, "present", "architecture names the stale approval result"],
  ["docs/architecture.md", /What the digest covers/, "present", "architecture says what the digest covers and why not the whole store"],
  ["docs/architecture.md", /One digest function/, "present", "architecture says single approvals and plans share one digest"],
  ["docs/architecture.md", /digest-free by construction/, "present", "architecture says a grant-authorized execution has no digest"],
  ["docs/architecture.md", /binds state, not output/, "present", "architecture states the edge of the digest guarantee"],

  ["docs/architecture.md", /##\s*The agent sees a projection/, "present", "architecture states the agent view contract"],
  ["docs/architecture.md", /The runtime's view is the outer bound/, "present", "architecture says where the view is declared and which bounds which"],
  ["docs/architecture.md", /withheld wherever it appears/, "present", "architecture states the hidden value backstop"],
  ["docs/architecture.md", /VIEW_UNAVAILABLE/, "present", "architecture names the failed view refusal"],
  ["docs/architecture.md", /The human side is not projected/, "present", "architecture says the snapshot and audit stay whole"],
  ["docs/architecture.md", /shorter than eight characters is\s+protected structurally and by whole value/, "present", "architecture states the in-text matching limit of the backstop"],

  ["docs/architecture.md", /##\s*A receipt says where its proof can be seen/, "present", "architecture states the evidence link contract"],
  ["docs/architecture.md", /Authored wins; otherwise derived; otherwise empty/, "present", "architecture says where evidence comes from"],
  ["docs/architecture.md", /A link crosses through the agent view like every other field/, "present", "architecture says evidence is projected"],
  ["docs/architecture.md", /An\s+authored link is the value/, "present", "architecture says an authored evidence link points at the value"],
  ["docs/architecture.md", /A derived link is page-level/, "present", "architecture says a derived evidence link points at the page"],
  ["docs/architecture.md", /adoptHumanActor/, "present", "architecture names the identity boundary a grant issuer crosses"],
];

const failures = [];

function readDoc(name) {
  const path = name.includes("/") ? join(root, name) : join(designDir, name);
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
const anchoredFiles = ANCHORED_DIRS.filter((dir) => existsSync(dir)).flatMap(
  (dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(dir, f)),
);
for (const path of [...new Set(anchoredFiles)]) {
  const file = path.slice(root.length + 1).replace(/\\/g, "/");
  const body = readFileSync(path, "utf8");
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
        // Whole identifier, not a substring. `includes` kept passing after
        // `expectedRevision` became `expectedRevisionAt`, which is exactly
        // the rename an anchor exists to catch.
        const whole = new RegExp(String.raw`(?<![A-Za-z0-9_$])${symbol}(?![A-Za-z0-9_$])`);
        if (!whole.test(source)) {
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

const exampleFailures = checkCompiledExamples();
if (exampleFailures.length > 0) {
  for (const failure of exampleFailures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

console.log(`design doc check passed (${CLAIMS.length} claims, ${anchorCount} anchors)`);
