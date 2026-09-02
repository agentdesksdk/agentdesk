import {
  indexedDbPersistence,
  memoryPersistence,
  type PersistedRecord,
  type PersistenceAdapter,
} from "@agentdesk/webmcp";
import { rebuildBranch } from "../capabilities/staged.ts";

/** One database per application, so two apps on an origin do not share records. */
export const DATABASE = "meridian-ops";

/**
 * What the page keeps across a reload. Emptying it, for Reset Demo, is the
 * adapter's own `clear`, so nothing here names the SDK's stores or keys.
 */
export type DemoPersistence = {
  kind: "indexeddb" | "memory";
  adapter: PersistenceAdapter;
};

/**
 * Hands a loaded record's artifact back to the runtime. A fork was written
 * down by identity (its capability, input, and clock), so it is staged again
 * from the document as it is now; the staging adapter then settles that
 * fork the way it settles a live one.
 */
export function demoResolveArtifact(record: PersistedRecord): unknown {
  return record.artifact.kind === "reference" ? rebuildBranch(record.artifact.reference) : undefined;
}

type Factory = IDBFactory;

export function createDemoPersistence(
  factory: Factory | undefined = (globalThis as { indexedDB?: Factory }).indexedDB,
): DemoPersistence {
  if (factory === undefined) {
    // No IndexedDB here (jsdom, a locked-down browser): memory stands in,
    // and the page says so in the Inspector.
    const memory = memoryPersistence();
    memory.resolveArtifact = demoResolveArtifact;
    return { kind: "memory", adapter: memory };
  }
  return {
    kind: "indexeddb",
    adapter: indexedDbPersistence({
      name: DATABASE,
      indexedDB: factory,
      resolveArtifact: demoResolveArtifact,
    }),
  };
}
