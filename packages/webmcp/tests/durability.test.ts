import { describe, expect, it } from "vitest";
import {
  createAgentDeskRuntime,
  defineCapability,
  indexedDbPersistence,
  memoryPersistence,
  receipt,
  type Capability,
  type PersistedRecord,
  type PersistenceAdapter,
  type StagedResolution,
  type StagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };
const AGENT = { id: "agent-1", name: "Ops Agent", kind: "agent" as const };

type Doc = Record<string, unknown>;
type Artifact = {
  name: string;
  before: Doc;
  head: Doc;
  settled: boolean;
  /** Present when the artifact must not be cloneable. */
  handle?: () => void;
};

/**
 * A staging adapter whose commit can throw after it has written, whose
 * artifact can be made uncloneable, and which can name its artifacts with
 * a durable key. Every instance stands for one process lifetime.
 */
function makeAdapter(options: {
  throwAfterWrite?: boolean;
  cloneable?: boolean;
  identify?: boolean;
  initial?: Doc;
} = {}) {
  let live: Doc = { ...(options.initial ?? { count: 0 }) };
  let open: Doc | null = null;
  const artifacts: Artifact[] = [];
  const reconciled: Array<{ artifact: unknown; resolution: StagedResolution }> = [];
  let dispatches = 0;

  const adapter: StagingAdapter<Artifact> = {
    operations: new Set(["touch"]),
    scope: (run) => {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      try {
        return run();
      } finally {
        if (outermost) {
          open = null;
        }
      }
    },
    fork(operation) {
      const outermost = open === null;
      if (open === null) {
        open = { ...live };
      }
      const before = { ...open };
      open.count = Number(open.count ?? 0) + 1;
      const artifact: Artifact = {
        name: operation,
        before,
        head: { ...open },
        settled: false,
        ...(options.cloneable === false ? { handle: () => {} } : {}),
      };
      if (outermost) {
        open = null;
      }
      artifacts.push(artifact);
      return { staged: artifact, result: { count: artifact.head.count } };
    },
    diff: (artifact) =>
      Object.keys(artifact.head)
        .filter((key) => artifact.before[key] !== artifact.head[key])
        .map((key) => ({
          field: key,
          before: artifact.before[key] ?? null,
          after: artifact.head[key],
        })),
    commit: (artifact) => {
      dispatches += 1;
      live = { ...live, ...artifact.head };
      if (options.throwAfterWrite) {
        throw new Error("connection dropped after the write was sent");
      }
      artifact.settled = true;
      return receipt({
        entity: artifact.name,
        changes: adapter.diff(artifact),
        result: { ...artifact.head },
      });
    },
    release: (artifact) => {
      artifact.settled = true;
    },
    reconcile: (artifact, resolution) => {
      reconciled.push({ artifact, resolution });
      if (typeof artifact === "object" && artifact !== null) {
        (artifact as Artifact).settled = true;
      }
    },
    ...(options.identify
      ? { identify: (artifact: Artifact) => ({ branch: `${artifact.name}@${String(artifact.head.count)}` }) }
      : {}),
  };

  return {
    adapter,
    dispatches: () => dispatches,
    reconciled: () => [...reconciled],
    liveState: () => ({ ...live }),
  };
}

const touchThing: Capability = defineCapability({
  name: "touch_thing",
  description: "Stages touch.",
  risk: "WRITE",
  staging: { operation: "touch" },
});

/** The same write behind an approval, so a key travels the approval path. */
const approveThing: Capability = defineCapability({
  name: "approve_thing",
  description: "Stages touch behind an approval.",
  risk: "CONSEQUENTIAL",
  staging: { operation: "touch" },
});

async function boot(
  adapter: StagingAdapter<Artifact>,
  persistence?: PersistenceAdapter,
) {
  const runtime = createAgentDeskRuntime({
    capabilities: [touchThing, approveThing],
    registerTool: async () => {},
    actor: AGENT,
    staging: adapter,
    ...(persistence ? { persistence } : {}),
  });
  await runtime.start();
  return runtime;
}

type Runtime = Awaited<ReturnType<typeof boot>>;

/** One unknown commit, with the runtime stopped afterwards. */
async function incident(persistence?: PersistenceAdapter, options: Parameters<typeof makeAdapter>[0] = {}) {
  const first = makeAdapter({ throwAfterWrite: true, ...options });
  const runtime = await boot(first.adapter, persistence);
  const result = await runtime.invoke("touch_thing", { id: "T-1" });
  expect(result.code).toBe("EXECUTION_INDETERMINATE");
  const [record] = runtime.listUnreconciled();
  expect(record).toBeDefined();
  await runtime.stop();
  return { record: record!, first };
}

describe("durability: an unknown commit survives a restart", () => {
  it("is listed, byte for byte, and refuses the same call on a fresh start with the same adapter", async () => {
    const persistence = memoryPersistence();
    const { record } = await incident(persistence);

    const second = makeAdapter();
    const runtime: Runtime = await boot(second.adapter, persistence);

    const [loaded] = runtime.listUnreconciled();
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(record));
    expect(loaded?.operationKey).toBe(record.operationKey);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(() => {
      (loaded as { detail: string }).detail = "rewritten";
    }).toThrow();

    const repeat = await runtime.invoke("touch_thing", { id: "T-1" });
    expect(repeat.code).toBe("EXECUTION_INDETERMINATE");
    expect(repeat.data?.record_id).toBe(record.id);
    expect(second.dispatches()).toBe(0);
  });

  it("carries the executing actor and the approved changes on the record", async () => {
    const persistence = memoryPersistence();
    const { record } = await incident(persistence);

    expect(record.executedBy).toEqual(AGENT);
    expect(record.changes).toEqual([{ field: "count", before: 0, after: 1 }]);
    const saved = persistence.records.get(record.id);
    expect(saved).toMatchObject({
      version: 1,
      id: record.id,
      kind: "commit_indeterminate",
      capability: "touch_thing",
      operationKey: record.operationKey,
      executedBy: AGENT,
      changes: [{ field: "count", before: 0, after: 1 }],
      artifact: { kind: "value" },
    });
    expect(typeof saved?.seal).toBe("string");
  });

  it("reconciles the rehydrated record exactly once, through the adapter, audited with the human", async () => {
    const persistence = memoryPersistence();
    const { record } = await incident(persistence);
    const second = makeAdapter();
    const runtime = await boot(second.adapter, persistence);

    const settled = runtime.reconcile(record.id, { kind: "commit_applied" }, HUMAN);
    const again = runtime.reconcile(record.id, { kind: "commit_applied" }, HUMAN);

    expect(settled).toEqual({ ok: true });
    expect(again).toMatchObject({ ok: false });
    expect(second.reconciled()).toHaveLength(1);
    expect(second.reconciled()[0]?.resolution).toEqual({ kind: "commit_applied" });
    expect(second.reconciled()[0]?.artifact).toMatchObject({ name: "touch" });
    expect(runtime.listUnreconciled()).toEqual([]);
    const event = runtime.getSnapshot().audit.find((e) => e.kind === "staged_reconciled");
    expect(event).toMatchObject({ recordId: record.id, actor: HUMAN });
    expect(persistence.records.size).toBe(0);

    await runtime.stop();
    const third = await boot(makeAdapter().adapter, persistence);
    expect(third.listUnreconciled()).toEqual([]);
    const fresh = await third.invoke("touch_thing", { id: "T-1" });
    expect(fresh.code).not.toBe("EXECUTION_INDETERMINATE");
  });
});

describe("durability: an artifact that cannot be serialized", () => {
  it("is re-identified through the adapter's key and rebuilt by resolveArtifact", async () => {
    const persistence = memoryPersistence();
    persistence.resolveArtifact = (record: PersistedRecord) =>
      record.artifact.kind === "reference"
        ? { name: "touch", rebuiltFrom: record.artifact.reference, settled: false }
        : undefined;
    const { record } = await incident(persistence, { cloneable: false, identify: true });
    expect(persistence.records.get(record.id)?.artifact).toEqual({
      kind: "reference",
      reference: { branch: "touch@1" },
    });

    const second = makeAdapter();
    const runtime = await boot(second.adapter, persistence);
    const settled = runtime.reconcile(record.id, { kind: "commit_not_applied" }, HUMAN);

    expect(settled).toEqual({ ok: true });
    expect(second.reconciled()[0]?.artifact).toMatchObject({ rebuiltFrom: { branch: "touch@1" } });
    expect(runtime.listUnreconciled()).toEqual([]);
  });

  it("leaves the record open and says so when the resolver cannot rebuild it", async () => {
    const persistence = memoryPersistence();
    persistence.resolveArtifact = () => undefined;
    const { record } = await incident(persistence, { cloneable: false, identify: true });

    const second = makeAdapter();
    const runtime = await boot(second.adapter, persistence);
    const attempt = runtime.reconcile(record.id, { kind: "commit_applied" }, HUMAN);

    expect(attempt).toMatchObject({ ok: false });
    expect((attempt as { reason: string }).reason).toMatch(/rebuil|resolve/i);
    expect(second.reconciled()).toHaveLength(0);
    expect(runtime.listUnreconciled().map((entry) => entry.id)).toEqual([record.id]);
    expect(persistence.records.has(record.id)).toBe(true);
    expect(
      runtime.getSnapshot().audit.some((event) => event.kind === "staged_reconcile_failed"),
    ).toBe(true);
  });

  it("records an artifact that was neither cloneable nor identified as lost, and still guards", async () => {
    const persistence = memoryPersistence();
    const { record } = await incident(persistence, { cloneable: false });
    expect(persistence.records.get(record.id)?.artifact).toEqual({ kind: "lost" });

    const second = makeAdapter();
    const runtime = await boot(second.adapter, persistence);
    const repeat = await runtime.invoke("touch_thing", { id: "T-1" });
    expect(repeat.code).toBe("EXECUTION_INDETERMINATE");
    expect(second.dispatches()).toBe(0);
  });
});

describe("durability: what is loaded is what was saved", () => {
  it("refuses a saved record whose evidence was tampered with, and audits the refusal", async () => {
    const persistence = memoryPersistence();
    const { record } = await incident(persistence);
    const saved = persistence.records.get(record.id);
    expect(saved).toBeDefined();
    saved!.changes = [{ field: "count", before: 0, after: 999 }];

    const runtime = await boot(makeAdapter().adapter, persistence);

    expect(runtime.listUnreconciled()).toEqual([]);
    const refused = runtime.getSnapshot().audit.find((event) => event.kind === "staged_reconcile_failed");
    expect(refused).toMatchObject({ recordId: record.id });
    expect((refused as { detail: string }).detail).toMatch(/seal|tamper|evidence/i);
  });

  it("changes nothing when no persistence is declared", async () => {
    const { record } = await incident();

    const second = makeAdapter();
    const runtime = await boot(second.adapter);

    expect(runtime.listUnreconciled()).toEqual([]);
    const repeat = await runtime.invoke("touch_thing", { id: "T-1" });
    expect(repeat.data?.record_id).not.toBe(record.id);
    expect(second.dispatches()).toBe(1);
  });
});

describe("durability: an idempotency claim survives a restart", () => {
  it("replays the exact settled result after reload without re-executing", async () => {
    const persistence = memoryPersistence();
    const first = makeAdapter();
    const runtime = await boot(first.adapter, persistence);
    const call = { name: "touch_thing", input: { id: "T-1" }, idempotency_key: "once" };
    const done = await runtime.invoke("invoke_capability", call);
    expect(done.data?.status).toBe("COMPLETED");
    await runtime.stop();

    const second = makeAdapter();
    const again = await boot(second.adapter, persistence);
    const repeat = await again.invoke("invoke_capability", call);
    const differently = await again.invoke("invoke_capability", {
      ...call,
      input: { id: "T-2" },
    });

    expect(repeat).toEqual(done);
    expect(differently.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(second.dispatches()).toBe(0);
  });

  it("replays the earlier write's receipt as part of the exact result", async () => {
    const persistence = memoryPersistence();
    const first = makeAdapter();
    const runtime = await boot(first.adapter, persistence);
    const call = { name: "touch_thing", input: { id: "T-1" }, idempotency_key: "once" };
    const done = await runtime.invoke("invoke_capability", call);
    const receiptId = (done.data?.evidence as Array<{ kind: string; id: string }>).find(
      (item) => item.kind === "receipt",
    )?.id;
    expect(receiptId).toMatch(/^RCPT-/);
    await runtime.stop();

    const again = await boot(makeAdapter().adapter, persistence);
    const repeat = await again.invoke("invoke_capability", call);

    expect(repeat).toEqual(done);
    expect(persistence.claims.get("touch_thing:once")?.receiptId).toBe(receiptId);
  });
});

describe("durability: a key through the approval path", () => {
  const call = { name: "approve_thing", input: { id: "T-1" }, idempotency_key: "once" };

  function approvalsRequested(runtime: Runtime): number {
    return runtime
      .getSnapshot()
      .audit.filter((event) => event.kind === "approval_requested").length;
  }

  it("refuses the same call while the record is open, before any restart, without a second approval", async () => {
    const persistence = memoryPersistence();
    const first = makeAdapter({ throwAfterWrite: true });
    const runtime = await boot(first.adapter, persistence);
    const asked = await runtime.invoke("invoke_capability", call);
    expect(asked.code).toBe("APPROVAL_REQUIRED");
    const actionId = runtime.getSnapshot().pending[0]!.id;
    const approved = await runtime.approve(actionId, HUMAN);
    expect(approved.code).toBe("EXECUTION_INDETERMINATE");
    const [record] = runtime.listUnreconciled();
    expect(record).toBeDefined();
    expect(approvalsRequested(runtime)).toBe(1);

    const again = await runtime.invoke("invoke_capability", call);

    expect(again.code).toBe("EXECUTION_INDETERMINATE");
    expect(again.data?.record_id).toBe(record!.id);
    expect(approvalsRequested(runtime)).toBe(1);
    expect(runtime.getSnapshot().pending).toEqual([]);
    expect(first.dispatches()).toBe(1);
  });

  it("refuses the same call with the same key after a restart, naming the record, before any approval is asked", async () => {
    const persistence = memoryPersistence();
    const first = makeAdapter({ throwAfterWrite: true });
    const runtime = await boot(first.adapter, persistence);
    await runtime.invoke("invoke_capability", call);
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);
    const [record] = runtime.listUnreconciled();
    expect(record).toBeDefined();
    await runtime.stop();

    const second = makeAdapter();
    const again = await boot(second.adapter, persistence);
    const repeat = await again.invoke("invoke_capability", call);

    expect(repeat.code).toBe("EXECUTION_INDETERMINATE");
    expect(repeat.data?.record_id).toBe(record!.id);
    expect(approvalsRequested(again)).toBe(0);
    expect(again.getSnapshot().pending).toEqual([]);
    expect(second.dispatches()).toBe(0);
    expect(persistence.claims.has("approve_thing:once")).toBe(true);
  });

  it("replays the pending approval for a repeat with the same key rather than opening a second one", async () => {
    const persistence = memoryPersistence();
    const runtime = await boot(makeAdapter().adapter, persistence);

    const asked = await runtime.invoke("invoke_capability", call);
    const repeat = await runtime.invoke("invoke_capability", call);

    expect(asked.code).toBe("APPROVAL_REQUIRED");
    expect(repeat.code).toBe("APPROVAL_REQUIRED");
    expect(repeat.data?.approval_id).toBe(asked.data?.approval_id);
    expect(approvalsRequested(runtime)).toBe(1);
    expect(runtime.getSnapshot().pending).toHaveLength(1);
  });

  it("refuses the same key after a restarted indeterminate record is reconciled", async () => {
    const persistence = memoryPersistence();
    const first = makeAdapter({ throwAfterWrite: true });
    const runtime = await boot(first.adapter, persistence);
    await runtime.invoke("invoke_capability", call);
    await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);
    const [record] = runtime.listUnreconciled();
    await runtime.stop();

    const second = makeAdapter();
    const again = await boot(second.adapter, persistence);
    expect(again.reconcile(record!.id, { kind: "commit_applied" }, HUMAN)).toEqual({ ok: true });
    const repeat = await again.invoke("invoke_capability", call);

    expect(repeat.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(repeat.data?.cause).toBe("after_restart");
    expect(approvalsRequested(again)).toBe(0);
    expect(second.dispatches()).toBe(0);
  });
});

describe("durability: clear forgets everything the adapter kept", () => {
  it("empties the memory adapter", async () => {
    const persistence = memoryPersistence();
    await incident(persistence);
    expect(persistence.records.size).toBe(1);
    await persistence.saveIdempotencyClaim({ version: 1, slot: "touch_thing:k", fingerprint: "{}", at: 1 });

    await persistence.clear();

    expect(await persistence.loadOpenRecords()).toEqual([]);
    expect(await persistence.loadIdempotencyClaims()).toEqual([]);
  });
});

describe("durability: the IndexedDB adapter", () => {
  /**
   * A small double of the IndexedDB API surface the adapter uses: open with
   * upgrade, transactions, object stores with put, get, getAll, and delete,
   * and requests that complete on a later tick. Not a browser, and says so:
   * no fake-indexeddb shim is in the workspace lockfile.
   */
  function fakeIndexedDb() {
    const databases = new Map<string, Map<string, Map<string, unknown>>>();
    const request = <T,>(work: () => T) => {
      const req: {
        result?: T;
        error?: unknown;
        onsuccess?: (event: unknown) => void;
        onerror?: (event: unknown) => void;
      } = {};
      queueMicrotask(() => {
        try {
          req.result = work();
          req.onsuccess?.({ target: req });
        } catch (err) {
          req.error = err;
          req.onerror?.({ target: req });
        }
      });
      return req;
    };
    const factory = {
      open(name: string) {
        const stores = databases.get(name) ?? new Map<string, Map<string, unknown>>();
        const fresh = !databases.has(name);
        databases.set(name, stores);
        const db = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => {
            stores.set(store, new Map());
          },
          transaction: (names: string | string[]) => ({
            objectStore: (store: string) => {
              void names;
              const table = stores.get(store)!;
              return {
                put: (value: { id?: string; slot?: string }) =>
                  request(() => {
                    table.set(value.id ?? value.slot ?? "", structuredClone(value));
                  }),
                get: (key: string) => request(() => structuredClone(table.get(key))),
                getAll: () => request(() => [...table.values()].map((v) => structuredClone(v))),
                delete: (key: string) =>
                  request(() => {
                    table.delete(key);
                  }),
                clear: () =>
                  request(() => {
                    table.clear();
                  }),
              };
            },
          }),
          close: () => {},
        };
        const req: {
          result?: typeof db;
          onsuccess?: (event: unknown) => void;
          onerror?: (event: unknown) => void;
          onupgradeneeded?: (event: unknown) => void;
        } = {};
        queueMicrotask(() => {
          req.result = db;
          if (fresh) {
            req.onupgradeneeded?.({ target: req });
          }
          req.onsuccess?.({ target: req });
        });
        return req as unknown as IDBOpenDBRequest;
      },
    };
    return { factory, databases };
  }

  it("round-trips records and claims, and a settled record does not come back", async () => {
    const { factory } = fakeIndexedDb();
    const adapter = indexedDbPersistence({ name: "agentdesk-test", indexedDB: factory });
    const record = (id: string): PersistedRecord => ({
      version: 1,
      id,
      kind: "commit_indeterminate",
      capability: "touch_thing",
      detail: "connection dropped",
      changes: [{ field: "count", before: 0, after: 1 }],
      at: 1,
      operationKey: `touch_thing:{"id":"${id}"}`,
      artifact: { kind: "value", value: { name: "touch" } },
      seal: "sv-test",
    });

    await adapter.saveRecord(record("UNREC-1"));
    await adapter.saveRecord(record("UNREC-2"));
    await adapter.settleRecord("UNREC-1");
    await adapter.saveIdempotencyClaim({ version: 1, slot: "touch_thing:once", fingerprint: "{}", at: 1 });

    const reopened = indexedDbPersistence({ name: "agentdesk-test", indexedDB: factory });
    const open = await reopened.loadOpenRecords();
    const claims = await reopened.loadIdempotencyClaims();

    expect(open.map((entry) => entry.id)).toEqual(["UNREC-2"]);
    expect(open[0]).toEqual(record("UNREC-2"));
    expect(claims).toEqual([{ version: 1, slot: "touch_thing:once", fingerprint: "{}", at: 1 }]);

    await reopened.clear();
    expect(await reopened.loadOpenRecords()).toEqual([]);
    expect(await reopened.loadIdempotencyClaims()).toEqual([]);
  });
});
