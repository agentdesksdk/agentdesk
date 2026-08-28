import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const p0Dist = join(root, "apps", "p0", "dist");
const demoDist = join(root, "apps", "demo", "dist");
const target = join(demoDist, "p0");

if (!existsSync(p0Dist) || !existsSync(demoDist)) {
  console.error("run the workspace build first: both dist folders are required");
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(p0Dist, target, { recursive: true });
console.log(`copied P0 harness into ${target}`);
