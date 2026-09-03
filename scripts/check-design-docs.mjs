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
  ["docs/architecture.md", /PendingAction\.grant/, "present", "architecture says the pending action carries the considered grant"],
  ["docs/architecture.md", /whose state most\s+recently changed is named/, "present", "architecture states the recency rule for the considered grant"],

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

  ["docs/architecture.md", /##\s*An approval is bound to a gesture/, "present", "architecture states the approval gesture contract"],
  ["docs/architecture.md", /single use/, "present", "architecture says a token is single use"],
  ["docs/architecture.md", /Migration without a flag day/, "present", "architecture says how existing approve calls migrate"],
  ["docs/architecture.md", /The seam WebAuthn plugs into/, "present", "architecture names the seam a stronger gesture uses"],
  ["docs/architecture.md", /untrusted_content_ignored/, "present", "architecture names the audit half of the adversarial note"],
  ["docs/architecture.md", /Minting outside an activation throws/, "present", "architecture says a token requires a user activation"],
  ["docs/architecture.md", /It does not prove which human/, "present", "architecture states what the token does not prove"],
  ["docs/architecture.md", /hands its runtime to untrusted script/, "present", "architecture says a page that exposes its runtime has no gesture guarantee"],
  ["docs/architecture.md", /only the flagged reads between the request and the\s+approval count/, "present", "architecture states the scope of untrusted_content_ignored"],

  ["docs/architecture.md", /##\s*An unknown outcome survives a restart/, "present", "architecture states the durability contract"],
  ["docs/architecture.md", /refused at load and audited/, "present", "architecture says a tampered record is refused rather than trusted"],
  ["docs/architecture.md", /cause: "after_restart"/, "present", "architecture says a claimed key is refused after reload"],
  ["docs/architecture.md", /leaves the record open/, "present", "architecture says an unrebuildable artifact keeps the record open"],
  ["docs/architecture.md", /byte for byte what it was/, "present", "architecture says a runtime without persistence is unchanged"],
  ["docs/reviews/2026-08-31-accepted-unreconciled-records-are-not-durable.md", /Status: \*\*RESOLVED\*\*/, "present", "the accepted-risk record is marked resolved"],
  ["docs/architecture.md", /integrity check against corruption\s+and accidental change, not authentication/, "present", "architecture says what the seal is and is not"],
  ["docs/architecture.md", /the seal proves the evidence did not change on disk/, "absent", "the seal is not described as proof against an adversary"],
  ["docs/architecture.md", /never replayed and never re-executed/, "present", "architecture states refusal after restart as a decided limit"],
  ["docs/architecture.md", /claimed at the request, not at the\s+execution the approval releases later/, "present", "architecture says a key on the approval path is claimed at the request"],
  ["docs/architecture.md", /The runtime never\s+calls `clear`/, "present", "architecture says clear belongs to the page's reset"],
  ["docs/architecture.md", /A page can replay a reveal/, "present", "architecture states runtime.present"],
  ["docs/architecture.md", /no\s+WebMCP tool reaches it/, "present", "architecture says present is not a tool"],
  ["docs/architecture.md", /adoptHumanActor/, "present", "architecture names the identity boundary a grant issuer crosses"],
  ["docs/architecture.md", /A second adapter, over IndexedDB/, "present", "architecture describes the IndexedDB staging adapter"],
  ["docs/architecture.md", /IndexedDB\s+rolls back every write the transaction\s+held/, "present", "architecture says an aborted commit transaction is undone by IndexedDB, not the adapter"],
  ["docs/architecture.md", /every row it read or\s+wrote through the draft, each at its version/, "present", "architecture says what a fork snapshots and what a version is"],
  ["adapter-contract.md", /##\s*What the staging contract did not say/, "present", "adapter contract lists what the staging contract left unsaid"],
  ["adapter-contract.md", /Resolved: a commit that has returned can no longer report a\s+completion that rolled back/, "present", "adapter contract records the synchronous-commit leak as resolved"],
  ["adapter-contract.md", /A commit that has returned cannot become refused or\s+indeterminate/, "absent", "the synchronous-commit leak is no longer stated as open"],
  ["docs/architecture.md", /Its `commit` may\s+return a promise, and the runtime awaits it before it records the outcome/, "present", "architecture says a staged commit is awaited before the outcome is recorded"],
  ["docs/architecture.md", /Its\s+`fork` may return a promise, and the runtime awaits it before `diff`/, "present", "architecture says a staged fork is awaited before diff"],
  ["docs/architecture.md", /`diff` stays synchronous against the fork it was given/, "present", "architecture decides that diff stays synchronous"],
  ["docs/architecture.md", /a repeat under the same key joins the first\s+request's result and forks once/, "present", "architecture decides what a repeat does while a fork is in flight"],
  ["docs/architecture.md", /keeps its mirror and its synchronous fork, by decision/, "present", "architecture decides the IndexedDB adapter keeps its mirror"],
  ["adapter-contract.md", /Resolved: fork has an asynchronous half/, "present", "adapter contract records the synchronous-fork leak as resolved"],
  ["adapter-contract.md", /Fork has no asynchronous half\.\*\*/, "absent", "the synchronous-fork leak is no longer stated as open"],
  ["docs/architecture.md", /the mirror moves when a commit's\s+transaction completes and not before/, "present", "architecture says the IndexedDB mirror follows the transaction"],
  ["docs/architecture.md", /A fork opened while a commit is in flight derives against the rows as\s+they were, without waiting/, "present", "architecture decides what a fork in the same tick derives against"],
  ["docs/architecture.md", /A third adapter, over REST/, "present", "architecture describes the REST staging adapter"],
  ["docs/architecture.md", /refused at fork rather than\s+guessed at/, "present", "architecture says a resource with no version source is refused, not guessed"],
  ["docs/architecture.md", /a 412 after a row\s+was acknowledged is `RestCommitPartial`, which the runtime records as\s+indeterminate/, "present", "architecture says partial application over REST is recorded as indeterminate with the acknowledged rows"],
  ["docs/architecture.md", /\*Nothing is retried\*/, "present", "architecture says the REST adapter never retries a write"],
  ["adapter-contract.md", /###\s*What the REST adapter needed/, "present", "adapter contract lists what the REST adapter needed"],
  ["adapter-contract.md", /Partial application has no vocabulary/, "present", "adapter contract records the partial-application leak"],
  ["adapter-contract.md", /`identify` is consulted only when the artifact does not clone/, "present", "adapter contract records the identify-by-clone-failure leak"],

  ["docs/routing.md", /##\s*[\d.]+% on a real-sized catalog/, "present", "routing states what the scorer measures at on a real-sized catalog"],
  ["docs/routing.md", /scripts\/evals\/runs\/routing-reference/, "present", "routing names the committed routing stress run"],
  ["docs/routing.md", /Hybrid does worse/, "present", "routing says hybrid does worse on the stress catalog, and why"],

  ["frappe-adapter.md", /##\s*What the contract as written cannot express/, "present", "the Frappe design names the contract gaps in the adapter-contract shape"],
  ["frappe-adapter.md", /thrown before any write is dispatched/, "present", "the Frappe design refuses a stale stamp before submit is called"],
  ["frappe-adapter.md", /the stamp is a\s+coarser version than a row digest, in both directions/, "present", "the Frappe design states what the modified stamp does to the digest guarantee"],
  ["frappe-adapter.md", /A response that never arrived is indeterminate/, "present", "the Frappe design treats a lost submit response as indeterminate, not failed"],
  ["docs/routing.md", /##\s*Narrowing in two calls/, "present", "routing states the two-call domain tree"],
  ["docs/routing.md", /absent, it defaults from its domain/, "present", "routing says how a capability declares its subdomain"],
  ["docs/routing.md", /cached by the admitted set/, "present", "routing says how the tree is cached"],
  ["docs/routing.md", /A client that skips the first call loses nothing/, "present", "routing says the single call is unchanged"],
  ["docs/routing.md", /##\s*[\d.]+% with a lexical domain step/, "present", "routing reports the hierarchical scorer against the reference"],
  ["docs/routing.md", /That is not a wide margin/, "present", "routing says plainly what the lexical step did not achieve"],
  ["docs/architecture.md", /##\s*The provider seam/, "present", "architecture states the capability provider seam"],
  ["docs/architecture.md", /One provider, bound once at construction like the staging\s+adapter/, "present", "architecture decides a provider is bound once"],
  ["docs/architecture.md", /`provider\.ts` the only file that constructs the adapter/, "present", "architecture says the provider seam is the only adapter constructor"],
  ["browser-extension.md", /What the seam now satisfies of this document's assumptions/, "present", "the extension design says which assumptions the seam satisfies"],
  ["README.md", /has to be extracted/, "absent", "the design README no longer says the provider seam is still to be extracted"],
];

/**
 * Figures a document quotes from a committed evaluation run are held to
 * that run's report. A claim row can only say the prose contains a number;
 * this says the number is the one the records compute, so a regenerated
 * reference cannot leave a stale percentage in a sentence that still
 * matches its pattern.
 */
const REFERENCE_FIGURES = [
  {
    report: "scripts/evals/runs/routing-reference/report.json",
    // Whole phrases, not bare numbers. Requiring "29.1%" somewhere in the
    // file passed while the sentence said 29.2%, because the heading still
    // carried the old figure. Each phrase is the sentence the figure lives
    // in, so the sentence itself has to agree with the run.
    phrases: (report) => {
      const pct = (v) => `${(v * 100).toFixed(1)}%`;
      const det = report.cells.deterministic.metrics;
      const hyb = report.cells.hybrid.metrics;
      const hit = det.terminalInRoutedSet;
      const hitH = hyb.terminalInRoutedSet;
      const { size, seed } = report.catalog;
      return {
        "docs/routing.md": [
          [`## ${pct(hit.value)} on a real-sized catalog`, "the heading figure"],
          [`for ${pct(hit.value)} of tasks, ${hit.numerator} of ${hit.denominator}`, "the deterministic expected-in-routed-set sentence"],
          [`in ${pct(det.tieAtCut.value)} of tasks the fifth and sixth scores are equal`, "the tie-at-the-cut sentence"],
          [`Hybrid does worse, ${pct(hitH.value)},`, "the hybrid sentence"],
          [`${size} capabilities across twelve domains from seed ${seed}`, "the catalog sentence"],
        ],
        "docs/evaluations.md": [
          [`| Expected capability in the routed set | ${pct(hit.value)} (${hit.numerator} of ${hit.denominator}) | ${pct(hitH.value)} (${hitH.numerator} of ${hitH.denominator}) |`, "the expected-in-routed-set row"],
          [`| Tie at the cut | ${pct(det.tieAtCut.value)} | ${pct(hyb.tieAtCut.value)} |`, "the tie-at-the-cut row"],
          [`${hit.denominator - hit.numerator} of ${hit.denominator} tasks do not route their capability`, "the failing-count sentence"],
          [`${size} capabilities across twelve domains`, "the catalog size"],
          [`a seed, ${seed} in the reference`, "the catalog seed"],
        ],
      };
    },
  },
];

/**
 * The hierarchical cell, reported beside the reference. The deterministic
 * cell of the same run has to agree with the reference, which is what
 * "the single call is unchanged" means in numbers.
 */
REFERENCE_FIGURES.push({
  report: "scripts/evals/runs/routing-2.2/report.json",
  phrases: (report) => {
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const det = report.cells.deterministic.metrics;
    const cell = report.cells["custom:hierarchical"];
    const hit = cell.metrics.terminalInRoutedSet;
    const failing = (c) => new Set(c.failing.map((f) => f.taskId));
    const before = failing(report.cells.deterministic);
    const after = failing(cell);
    const gained = [...before].filter((id) => !after.has(id)).length;
    const lost = [...after].filter((id) => !before.has(id)).length;
    return {
      "docs/routing.md": [
        [`## ${pct(hit.value)} with a lexical domain step`, "the hierarchical heading figure"],
        [`for ${pct(hit.value)} of tasks, ${hit.numerator} of ${hit.denominator}, beside the reference's ${pct(det.terminalInRoutedSet.value)}`, "the hierarchical expected-in-routed-set sentence"],
        [`a tie at the cut in ${pct(cell.metrics.tieAtCut.value)} of tasks against ${pct(det.tieAtCut.value)}`, "the hierarchical tie sentence"],
        [`It gains ${gained} tasks and loses ${lost}`, "the gained-and-lost sentence"],
        [`--scorer ${cell.scorer.path}`, "the scorer path"],
      ],
    };
  },
});

/**
 * The second held-out set: one table from two runs, and a verdict that is
 * the pre-written rule applied to the numbers. The rule is computed here
 * again, so the word in the document has to be the word the numbers give.
 */
REFERENCE_FIGURES.push({
  report: "scripts/evals/runs/routing-holdout-2/report.json",
  phrases: (report) => {
    const other = JSON.parse(
      readFileSync(join(root, "scripts/evals/runs/routing-holdout-2-near-tie-1/report.json"), "utf8"),
    );
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const dec = (v) => v.toFixed(2);
    const det = report.cells.deterministic.metrics;
    const hyb = report.cells.hybrid.metrics;
    const hier = report.cells["custom:hierarchical"];
    const one = other.cells["custom:hierarchical-near-tie-1.0"];
    if (JSON.stringify(det) !== JSON.stringify(other.cells.deterministic.metrics)) {
      throw new Error("the two held-out runs disagree on their deterministic cell, so they are not one comparison");
    }
    const hit = (c) => c.metrics.terminalInRoutedSet;
    const count = (c) => `${pct(hit(c).value)} (${hit(c).numerator} of ${hit(c).denominator})`;
    const failing = (c) => new Set(c.failing.map((f) => f.taskId));
    const gained = (c) => [...failing(report.cells.deterministic)].filter((id) => !failing(c).has(id)).length;
    const lost = (c) => [...failing(c)].filter((id) => !failing(report.cells.deterministic).has(id)).length;
    const confirmed = hit(hier).value >= det.terminalInRoutedSet.value && hier.metrics.tieAtCut.value <= det.tieAtCut.value;
    return {
      "docs/evaluations.md": [
        [`| Expected capability in the routed set | ${count(report.cells.deterministic)} | ${count(report.cells.hybrid)} | ${count(hier)} | ${count(one)} | measured |`, "the held-out expected-in-routed-set row"],
        [`| Tie at the cut | ${pct(det.tieAtCut.value)} | ${pct(hyb.tieAtCut.value)} | ${pct(hier.metrics.tieAtCut.value)} | ${pct(one.metrics.tieAtCut.value)} | measured |`, "the held-out tie-at-the-cut row"],
        [`| Rank of the expected capability, when routed (mean) | ${dec(det.terminalRank.mean)} | ${dec(hyb.terminalRank.mean)} | ${dec(hier.metrics.terminalRank.mean)} | ${dec(one.metrics.terminalRank.mean)} | measured |`, "the held-out rank row"],
        [`it gains ${gained(hier)} tasks and loses ${lost(hier)}`, "the default's gains and losses"],
        [`gaining ${gained(one)} and losing ${lost(one)}`, "the 1.0 variant's gains and losses"],
        [`**Verdict: ${confirmed ? "confirmed" : "not confirmed"}.**`, "the verdict the rule gives on these numbers"],
        [`${report.catalog.size} capabilities`, "the held-out catalog size"],
        [`seed ${report.catalog.seed}`, "the held-out seed"],
      ],
    };
  },
});

/** A phrase as a pattern: literal text, with any run of whitespace allowed where the prose wraps. */
function loose(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.split(/\s+/).join(String.raw`\s+`));
}

function checkReferenceFigures() {
  const found = [];
  for (const { report, phrases } of REFERENCE_FIGURES) {
    const path = join(root, report);
    if (!existsSync(path)) {
      found.push(`${report} is missing; documents quote figures from it`);
      continue;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    for (const [doc, list] of Object.entries(phrases(parsed))) {
      const body = readDoc(doc);
      if (body === null) {
        found.push(`${doc} is missing (quotes ${report})`);
        continue;
      }
      for (const [phrase, what] of list) {
        if (!loose(phrase).test(body)) {
          found.push(`${doc} does not state "${phrase}", ${what} computed from ${report}; the prose is stale against the run`);
        }
      }
    }
  }
  return found;
}

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

failures.push(...checkReferenceFigures());

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
