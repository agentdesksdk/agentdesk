import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRoutingCatalog, DOMAINS, generateCatalog } from "../routing/catalog.mjs";

/**
 * The stress catalog is generated, not hand-authored, so the same seed has
 * to produce the same catalog on every host and every run. It is built to
 * break a lexical scorer: about four hundred capabilities across a dozen
 * domains that share vocabulary on purpose.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const dist = join(repoRoot, "packages", "webmcp", "dist", "index.js");
const sdk = existsSync(dist) ? await import(pathToFileURL(dist).href) : null;

test("the generator is deterministic for a seed", () => {
  const first = generateCatalog(2026);
  const second = generateCatalog(2026);
  assert.deepEqual(first, second, "the same seed must produce the same catalog");
  assert.ok(first.specs.length > 0, "the catalog is not empty");
  const other = generateCatalog(7);
  assert.notDeepEqual(other.specs, first.specs, "a different seed must produce a different catalog");
  assert.equal(first.seed, 2026, "the catalog records the seed it was generated from");
});

test("about four hundred capabilities across a dozen domains, every name unique", () => {
  const { specs, domains } = generateCatalog(2026);
  assert.ok(specs.length >= 380 && specs.length <= 420, `expected about 400 capabilities, got ${specs.length}`);
  assert.equal(domains.length, 12);
  assert.deepEqual(domains, [...DOMAINS]);
  const names = specs.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "capability names must be unique");
  for (const domain of domains) {
    const inDomain = specs.filter((s) => s.domain === domain).length;
    assert.ok(inDomain >= 25, `${domain} has only ${inDomain} capabilities`);
  }
});

test("every capability carries the routing metadata a scorer reads", () => {
  const { specs } = generateCatalog(2026);
  for (const spec of specs) {
    assert.match(spec.name, /^[a-z][a-z0-9_]*$/, `${spec.name} is not a capability name`);
    assert.ok(typeof spec.title === "string" && spec.title.length > 0, `${spec.name} has no title`);
    assert.ok(typeof spec.description === "string" && spec.description.length > 20, `${spec.name} has a thin description`);
    assert.ok(Array.isArray(spec.intents) && spec.intents.length >= 2, `${spec.name} has fewer than two intents`);
    assert.ok(Array.isArray(spec.keywords) && spec.keywords.length >= 2, `${spec.name} has fewer than two keywords`);
    assert.ok(["READ", "WRITE", "CONSEQUENTIAL"].includes(spec.risk), `${spec.name} has no risk`);
  }
});

test("the vocabulary overlaps across domains on purpose", () => {
  // A keyword that appears in only one domain routes cleanly. The catalog
  // exists to measure what happens when it does not, so a meaningful share
  // of keywords has to live in three or more domains.
  const { specs } = generateCatalog(2026);
  const domainsByKeyword = new Map();
  for (const spec of specs) {
    for (const keyword of spec.keywords) {
      if (!domainsByKeyword.has(keyword)) domainsByKeyword.set(keyword, new Set());
      domainsByKeyword.get(keyword).add(spec.domain);
    }
  }
  const shared = [...domainsByKeyword.values()].filter((set) => set.size >= 3).length;
  assert.ok(shared >= 12, `only ${shared} keywords are shared by three or more domains`);
});

test("every generated capability defines through the published SDK", { skip: sdk ? false : "dist not built" }, () => {
  const { capabilities, specs } = buildRoutingCatalog(sdk.defineCapability, 2026);
  assert.equal(capabilities.length, specs.length);
  for (const capability of capabilities) {
    assert.ok(capability.intents.length >= 2, `${capability.name} lost its intents`);
    assert.ok(capability.keywords.length >= 2, `${capability.name} lost its keywords`);
    assert.equal(typeof capability.domain, "string", `${capability.name} lost its domain`);
  }
});
