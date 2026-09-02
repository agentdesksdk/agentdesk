import { readFileSync } from "node:fs";

/**
 * Refuses a release whose tag disagrees with the package.
 *
 * The release workflow runs on `v*` tags and publishes whatever version
 * `packages/webmcp/package.json` carries. If someone tags `v0.3.0` on a
 * commit that still says 0.2.0, npm would either republish 0.2.0 (rejected,
 * version already exists) or, worse, succeed with a version nobody tagged.
 * This step makes the disagreement the failure, before anything installs.
 *
 * Usage: node .github/workflows/check-release-tag.mjs <tag>
 * The tag is the workflow's `GITHUB_REF_NAME`, e.g. `v0.2.0`.
 */
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error("check-release-tag: no tag given (argv[2] or GITHUB_REF_NAME)");
  process.exit(2);
}

const manifestPath = new URL("../../packages/webmcp/package.json", import.meta.url);
const { name, version } = JSON.parse(readFileSync(manifestPath, "utf8"));
const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;

console.log(`tag:              ${tag}  (version ${tagVersion})`);
console.log(`${name}: ${version}`);

if (tagVersion !== version) {
  console.error(
    `check-release-tag: refusing to publish, tag ${tag} does not match package version ${version}`,
  );
  process.exit(1);
}

console.log("check-release-tag: tag matches package version");
