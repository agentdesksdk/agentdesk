import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateCatalog } from "../routing/catalog.mjs";
import { loadRoutingTasks } from "../routing/load.mjs";
import { metadataTokens, OVERLAP_THRESHOLD, STOPWORDS, tokenOverlap } from "../routing/overlap.mjs";
import { ROUTING_TASK_SCHEMA_VERSION } from "../routing/schema.mjs";

/**
 * The held-out task set is authored from what a person knows, a capability's
 * name and what it does, and not from its intents and keywords. That rule
 * is enforced by a number: the share of a prompt's content tokens that
 * appear in the expected capability's routing metadata. A task above the
 * threshold is refused by the loader, because a prompt that quotes the
 * metadata measures the author's copying and not the scorer.
 */
const here = dirname(fileURLToPath(import.meta.url));
const evals = join(here, "..");
const repoRoot = resolve(evals, "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;
const tokenize = sdk?.tokenize ?? ((text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

const { specs } = generateCatalog(2026);

const spec = {
  name: "refund_shipping_fee",
  title: "Refund shipping fee",
  description: "Refund the shipping fee charged on an order.",
  domain: "billing",
  intents: ["refund shipping fee", "refund the shipping"],
  keywords: ["refund", "shipping", "fee", "postage"],
  risk: "CONSEQUENTIAL",
};

function withJsonl(name, lines, assertion) {
  const path = join(evals, "test", name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  try {
    assertion(path);
  } finally {
    rmSync(path, { force: true });
  }
}

const task = (id, prompt, expected = "refund_shipping_fee") => ({
  schemaVersion: ROUTING_TASK_SCHEMA_VERSION,
  id,
  prompt,
  expected,
});

test("the threshold is stated and strictly between zero and one", () => {
  assert.ok(OVERLAP_THRESHOLD > 0 && OVERLAP_THRESHOLD < 1, `threshold ${OVERLAP_THRESHOLD} is not a rule`);
  assert.ok(STOPWORDS.length > 10, "stopwords are what stop 'the' from counting as overlap");
});

test("metadata tokens are the intents, keywords, domain, and name, tokenized the router's way", () => {
  const tokens = metadataTokens(spec, tokenize);
  for (const expected of ["refund", "shipping", "fee", "postage", "billing"]) {
    assert.ok(tokens.has(expected), `${expected} is routing metadata and must count`);
  }
  assert.ok(!tokens.has("charged"), "the description is not routing metadata; a person may know it");
});

test("a prompt that quotes an intent overlaps completely; a messy one does not", () => {
  const quoted = tokenOverlap("refund shipping fee", spec, tokenize);
  assert.equal(quoted.ratio, 1);
  assert.deepEqual([...quoted.matched].sort(), ["fee", "refund", "shipping"]);

  const messy = tokenOverlap(
    "the customer on 10428 says we charged her for delivery she never asked for, can we give that money back",
    spec,
    tokenize,
  );
  assert.ok(messy.ratio < OVERLAP_THRESHOLD, `messy phrasing scored ${messy.ratio}`);
  assert.ok(messy.promptTokens.length >= 8, "content tokens are counted, not words");
  assert.ok(!messy.promptTokens.includes("the"), "stopwords are excluded from the denominator");
});

test("a task above the threshold is refused by the loader, naming the task and the figure", () => {
  withJsonl("tmp-routing-leak.jsonl", [task("leak", "refund the shipping fee")], (path) =>
    assert.throws(
      () => loadRoutingTasks(path, [spec], { repoRoot, tokenize }),
      (err) => {
        assert.match(err.message, /leak/, "the task is named");
        assert.match(err.message, /overlap/i, "the rule is named");
        assert.match(err.message, /\d/, "the figure is printed");
        return true;
      },
    ),
  );
});

test("a task under the threshold loads and carries its overlap figure", () => {
  withJsonl(
    "tmp-routing-ok.jsonl",
    [task("ok", "customer wants the delivery charge on 10428 back")],
    (path) => {
      const loaded = loadRoutingTasks(path, [spec], { repoRoot, tokenize });
      assert.equal(loaded.length, 1);
      assert.equal(typeof loaded[0].overlap.ratio, "number");
      assert.ok(loaded[0].overlap.ratio < OVERLAP_THRESHOLD);
      assert.equal(loaded[0].overlap.threshold, OVERLAP_THRESHOLD);
    },
  );
});

test("a task naming a capability the catalog does not hold is refused", () => {
  withJsonl("tmp-routing-unknown.jsonl", [task("ghost", "do the thing", "no_such_capability")], (path) =>
    assert.throws(() => loadRoutingTasks(path, [spec], { repoRoot, tokenize }), /no_such_capability/),
  );
});

test("the shipped held-out task set loads under the threshold against the generated catalog", () => {
  const tasks = loadRoutingTasks(join(evals, "routing", "tasks", "routing.v1.tasks.jsonl"), specs, { repoRoot, tokenize });
  assert.ok(tasks.length >= 40, `expected at least 40 held-out tasks, got ${tasks.length}`);
  const names = new Set(specs.map((s) => s.name));
  const domains = new Set();
  for (const t of tasks) {
    assert.ok(names.has(t.expected), `${t.id} expects ${t.expected}, which the catalog does not hold`);
    assert.ok(t.overlap.ratio <= OVERLAP_THRESHOLD, `${t.id} overlaps ${t.overlap.ratio}`);
    domains.add(specs.find((s) => s.name === t.expected).domain);
  }
  assert.ok(domains.size >= 8, `the task set reaches only ${domains.size} domains`);
});
