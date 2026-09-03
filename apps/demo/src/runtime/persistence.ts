import {
  indexedDbPersistence,
  memoryPersistence,
  type PersistedIdempotencyClaim,
  type PersistedRecord,
  type PersistedRuntimeCheckpoint,
  type PersistenceAdapter,
  type StagedProposalSnapshot,
  type PersistedArtifact,
} from "@agentdesksdk/webmcp";
import { rebuildBranch } from "../capabilities/staged.ts";

/** One database per application, so two apps on an origin do not share records. */
export const DATABASE = "meridian-ops";

/**
 * What the page keeps across a reload. Emptying it, for Reset Demo, is the
 * adapter's own `clear`, so nothing here names the SDK's stores or keys.
 */
export type DemoPersistence = {
  kind: "localstorage" | "indexeddb" | "memory";
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

export function demoResolveProposalArtifact(
  proposal: StagedProposalSnapshot<PersistedArtifact>,
): unknown {
  return proposal.artifact.kind === "reference"
    ? rebuildBranch(proposal.artifact.reference)
    : undefined;
}

const CLAIMS_KEY = "agentdesk-meridian-claims-v1";
const CHECKPOINT_KEY = "agentdesk-meridian-checkpoint-v1";
const RECORDS_KEY = "agentdesk-meridian-records-v1";

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readJson<T>(key: string, storage = browserStorage()): T | undefined {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown, storage = browserStorage()): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // The IndexedDB adapter below remains the fallback.
  }
}

function removeStored(key: string, storage = browserStorage()): void {
  try {
    storage?.removeItem(key);
  } catch {
    // A reset still clears the underlying adapter.
  }
}

/**
 * A synchronous adapter for the static demo. Every durable transition lands
 * before the tool result returns, so reloading immediately cannot outrun an
 * IndexedDB transaction that was still queued in the page being replaced.
 */
function localStoragePersistence(storage: Storage): PersistenceAdapter {
  return {
    saveRecord(record) {
      const records = readJson<PersistedRecord[]>(RECORDS_KEY, storage) ?? [];
      writeJson(
        RECORDS_KEY,
        [...records.filter((candidate) => candidate.id !== record.id), structuredClone(record)],
        storage,
      );
    },
    settleRecord(id) {
      const records = readJson<PersistedRecord[]>(RECORDS_KEY, storage) ?? [];
      writeJson(RECORDS_KEY, records.filter((record) => record.id !== id), storage);
    },
    loadOpenRecords() {
      return readJson<PersistedRecord[]>(RECORDS_KEY, storage) ?? [];
    },
    saveIdempotencyClaim(claim) {
      const claims = readJson<PersistedIdempotencyClaim[]>(CLAIMS_KEY, storage) ?? [];
      const next = claims.filter((candidate) => candidate.slot !== claim.slot);
      next.push(structuredClone(claim));
      writeJson(CLAIMS_KEY, next.slice(-512), storage);
    },
    loadIdempotencyClaims() {
      return readJson<PersistedIdempotencyClaim[]>(CLAIMS_KEY, storage) ?? [];
    },
    saveCheckpoint(checkpoint) {
      writeJson(CHECKPOINT_KEY, checkpoint, storage);
    },
    loadCheckpoint() {
      return readJson<PersistedRuntimeCheckpoint>(CHECKPOINT_KEY, storage);
    },
    clear() {
      removeStored(RECORDS_KEY, storage);
      removeStored(CLAIMS_KEY, storage);
      removeStored(CHECKPOINT_KEY, storage);
    },
    resolveArtifact: demoResolveArtifact,
    resolveProposalArtifact: demoResolveProposalArtifact,
  };
}

type Factory = IDBFactory;

export function createDemoPersistence(
  factory: Factory | undefined = (globalThis as { indexedDB?: Factory }).indexedDB,
  storage: Storage | undefined = browserStorage(),
): DemoPersistence {
  if (storage !== undefined) {
    return { kind: "localstorage", adapter: localStoragePersistence(storage) };
  }
  if (factory === undefined) {
    // No IndexedDB here (jsdom, a locked-down browser): memory stands in,
    // and the page says so in the Inspector.
    const memory = memoryPersistence();
    memory.resolveArtifact = demoResolveArtifact;
    memory.resolveProposalArtifact = demoResolveProposalArtifact;
    return { kind: "memory", adapter: memory };
  }
  const base = indexedDbPersistence({
    name: DATABASE,
    indexedDB: factory,
    resolveArtifact: demoResolveArtifact,
    resolveProposalArtifact: demoResolveProposalArtifact,
  });
  return {
    kind: "indexeddb",
    adapter: base,
  };
}
