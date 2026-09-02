import {
  indexedDbPersistence,
  memoryPersistence,
  type PersistedRecord,
  type PersistenceAdapter,
} from "@agentdesk/webmcp";
import { rebuildBranch } from "../capabilities/staged.ts";

/** One database per application, so two apps on an origin do not share records. */
export const DATABASE = "meridian-ops";

/** The SDK adapter's object stores and their keys; cleared, never read, here. */
const STORES: Array<{ name: string; keyPath: string }> = [
  { name: "records", keyPath: "id" },
  { name: "claims", keyPath: "slot" },
];

/** What the page keeps across a reload, and the one way to empty it. */
export type DemoPersistence = {
  kind: "indexeddb" | "memory";
  adapter: PersistenceAdapter;
  /** Removes every record and claim, for Reset Demo. */
  clear: () => Promise<void>;
  /** The memory adapter's stores, when that is what is in use. */
  records?: Map<string, PersistedRecord>;
  claims?: Map<string, unknown>;
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
    return {
      kind: "memory",
      adapter: memory,
      clear: async () => {
        memory.records.clear();
        memory.claims.clear();
      },
      records: memory.records,
      claims: memory.claims,
    };
  }
  return {
    kind: "indexeddb",
    adapter: indexedDbPersistence({
      name: DATABASE,
      indexedDB: factory,
      resolveArtifact: demoResolveArtifact,
    }),
    clear: () => clearDatabase(factory),
  };
}

/**
 * Empties both stores in one transaction, on a connection of its own. The
 * stores are created if the database did not exist yet, with the keys the
 * SDK adapter uses, so its own lazy open at the same version finds them.
 */
function clearDatabase(factory: Factory): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store.name)) {
          db.createObjectStore(store.name, { keyPath: store.keyPath });
        }
      }
    };
    request.onerror = () => reject(request.error ?? new Error("could not open the persisted store"));
    request.onsuccess = () => {
      const db = request.result;
      const present = STORES.map((s) => s.name).filter((name) => db.objectStoreNames.contains(name));
      if (present.length === 0) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(present, "readwrite");
      for (const name of present) {
        tx.objectStore(name).clear();
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("could not clear the persisted store"));
      };
    };
  });
}
