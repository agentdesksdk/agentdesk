import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDist = join(root, "apps", "demo", "dist");

/** Apps served under the demo's host, each at its own base path. */
const embedded = [
  { name: "P0 harness", dist: join(root, "apps", "p0", "dist"), target: join(demoDist, "p0") },
  { name: "Asteria Rescue Control", dist: join(root, "apps", "rescue", "dist"), target: join(demoDist, "rescue") },
];

if (!existsSync(demoDist)) {
  console.error("run the workspace build first: apps/demo/dist is required");
  process.exit(1);
}

for (const app of embedded) {
  if (!existsSync(app.dist)) {
    console.error(`run the workspace build first: ${app.dist} is required`);
    process.exit(1);
  }
  rmSync(app.target, { recursive: true, force: true });
  cpSync(app.dist, app.target, { recursive: true });
  console.log(`copied ${app.name} into ${app.target}`);
}
