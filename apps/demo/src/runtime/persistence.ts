import {
  memoryPersistence,
  type PersistedRecord,
  type PersistenceAdapter,
} from "@agentdesk/webmcp";

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

export function demoResolveArtifact(_record: PersistedRecord): unknown {
  return undefined;
}

export function createDemoPersistence(): DemoPersistence {
  const memory = memoryPersistence();
  return {
    kind: "memory",
    adapter: memory,
    clear: async () => {},
    records: memory.records,
    claims: memory.claims,
  };
}
