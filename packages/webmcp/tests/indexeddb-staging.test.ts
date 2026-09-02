import { describe, expect, it } from "vitest";
import {
  CapabilityUnavailableError,
  createAgentDeskRuntime,
  defineCapability,
  indexedDbPersistence,
  indexedDbStaging,
  receipt,
  StagedCommitRefused,
  type Capability,
  type IndexedDbFork,
  type IndexedDbStagingAdapter,
  type StagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };
const AGENT = { id: "agent", name: "Agent", kind: "agent" as const };

const DB = "meridian";
const ORDERS = "orders";
const STAGING = "agentdesk_staging";

type Table = Map<string, Record<string, unknown>>;

/**
 * A double of the IndexedDB surface the staging adapter uses, in the shape
 * `durability.test.ts` uses for the persistence adapter, plus what staging
 * needs and persistence did not: a transaction that buffers its writes and
 * lands them together on completion, `abort()` that drops them, an upgrade
 * that fires when the requested version is newer, and a `cut()` that makes
 * the next readwrite transaction hang forever, which is what a page that
 * unloads mid-commit looks like from the other side. Not a browser, and says
 * so: no fake-indexeddb shim is in the workspace lockfile.
 */
function fakeIndexedDb() {
  const databases = new Map<string, { version: number; stores: Map<string, Table> }>();
  const transactions: Array<{ names: string[]; mode: string }> = [];
  let cut = false;

  const seed = (name: string, rows: Record<string, Record<string, unknown>[]>) => {
    const stores = new Map<string, Table>();
    for (const [store, values] of Object.entries(rows)) {
      stores.set(store, new Map(values.map((row) => [String(row.id), structuredClone(row)])));
    }
    databases.set(name, { version: 0, stores });
  };

  const table = (name: string, store: string): Table => databases.get(name)!.stores.get(store)!;

  const factory = {
    open(name: string, version = 1) {
      const existing = databases.get(name);
      const db = existing ?? { version: 0, stores: new Map<string, Table>() };
      databases.set(name, db);
      const upgrade = version > db.version;
      db.version = version;
      const handle = {
        objectStoreNames: { contains: (store: string) => db.stores.has(store) },
        createObjectStore: (store: string) => {
          db.stores.set(store, new Map());
        },
        transaction: (names: string | string[], mode = "readonly") => {
          const list = Array.isArray(names) ? [...names] : [names];
          transactions.push({ names: list, mode });
          const hung = mode === "readwrite" && cut;
          if (hung) {
            cut = false;
          }
          const overlay = new Map<string, Map<string, Record<string, unknown> | null>>();
          const writes: Array<() => void> = [];
          let pending = 0;
          let aborted = false;
          let done = false;
          const tx: {
            oncomplete?: (event: unknown) => void;
            onabort?: (event: unknown) => void;
            onerror?: (event: unknown) => void;
            error?: unknown;
            abort: () => void;
            objectStore: (store: string) => unknown;
          } = {
            abort: () => {
              if (aborted || done) {
                return;
              }
              aborted = true;
              writes.length = 0;
              queueMicrotask(() => tx.onabort?.({ target: tx }));
            },
            objectStore: (store: string) => {
              if (!list.includes(store)) {
                throw new Error(`NotFoundError: ${store} is not in this transaction's scope`);
              }
              const rows = db.stores.get(store)!;
              const seen = overlay.get(store) ?? new Map<string, Record<string, unknown> | null>();
              overlay.set(store, seen);
              const view = (key: string) =>
                seen.has(key) ? (seen.get(key) ?? undefined) : rows.get(key);
              const request = <T,>(read: () => T, write?: () => void) => {
                const req: {
                  result?: T;
                  error?: unknown;
                  onsuccess?: (event: unknown) => void;
                  onerror?: (event: unknown) => void;
                } = {};
                pending += 1;
                queueMicrotask(() => {
                  pending -= 1;
                  if (hung || aborted) {
                    return;
                  }
                  try {
                    req.result = read();
                    if (write) {
                      writes.push(write);
                    }
                    req.onsuccess?.({ target: req });
                  } catch (err) {
                    req.error = err;
                    req.onerror?.({ target: req });
                  }
                  queueMicrotask(() => {
                    if (done || aborted || pending > 0) {
                      return;
                    }
                    done = true;
                    for (const land of writes) {
                      land();
                    }
                    tx.oncomplete?.({ target: tx });
                  });
                });
                return req;
              };
              return {
                put: (value: Record<string, unknown>) => {
                  const key = String(value.id);
                  return request(
                    () => {
                      seen.set(key, structuredClone(value));
                      return key;
                    },
                    () => rows.set(key, structuredClone(value)),
                  );
                },
                get: (key: string) => request(() => structuredClone(view(key))),
                getAll: () =>
                  request(() => {
                    const all = new Map(rows);
                    for (const [key, value] of seen) {
                      if (value === null) {
                        all.delete(key);
                      } else {
                        all.set(key, value);
                      }
                    }
                    return [...all.values()].map((row) => structuredClone(row));
                  }),
                delete: (key: string) =>
                  request(
                    () => {
                      seen.set(key, null);
                    },
                    () => rows.delete(key),
                  ),
                clear: () =>
                  request(
                    () => {
                      for (const key of rows.keys()) {
                        seen.set(key, null);
                      }
                    },
                    () => rows.clear(),
                  ),
              };
            },
          };
          return tx;
        },
        close: () => {},
      };
      const req: {
        result?: typeof handle;
        onsuccess?: (event: unknown) => void;
        onerror?: (event: unknown) => void;
        onupgradeneeded?: (event: unknown) => void;
      } = {};
      queueMicrotask(() => {
        req.result = handle;
        if (upgrade) {
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };

  return {
    factory,
    seed,
    table,
    transactions,
    /** The next readwrite transaction never settles: the page went away. */
    cut: () => {
      cut = true;
    },
  };
}

type Row = { id: string; version?: number; [field: string]: unknown };

const ORDER_ROWS: Row[] = [
  { id: "O-1", status: "processing", total: 40, version: 3 },
  { id: "O-2", status: "processing", total: 15, version: 1 },
];

function makeAdapter(db = fakeIndexedDb(), seeded = true) {
  if (seeded) {
    db.seed(DB, { [ORDERS]: ORDER_ROWS });
  }
  const adapter = indexedDbStaging({
    name: DB,
    indexedDB: db.factory,
    stores: [ORDERS],
    operations: {
      cancel: (draft, input) => {
        const id = String(input.id);
        const order = draft.get(ORDERS, id);
        if (order === undefined) {
          throw new Error(`no order ${id}`);
        }
        draft.put(ORDERS, { ...order, status: "cancelled" });
        return receipt({ entity: `orders:${id}`, changes: [], undoable: false, result: { id } });
      },
      flag: (draft, input) => {
        const id = String(input.id);
        const order = draft.get(ORDERS, id)!;
        draft.put(ORDERS, { ...order, flagged: true });
        return receipt({ entity: `orders:${id}`, changes: [], undoable: false, result: { id } });
      },
      /** Reads one order to decide about another, so the read is in the fork's base too. */
      cancel_pair: (draft) => {
        const first = draft.get(ORDERS, "O-1")!;
        const second = draft.get(ORDERS, "O-2")!;
        draft.put(ORDERS, { ...first, status: "cancelled" });
        draft.put(ORDERS, { ...second, status: "cancelled" });
        return receipt({ entity: "orders:O-1", changes: [], undoable: false, result: {} });
      },
    },
  });
  return { adapter, db };
}

const stagedCapability = (name: string, operation: string): Capability =>
  defineCapability({
    name,
    description: `Stages ${operation}.`,
    risk: "CONSEQUENTIAL",
    staging: { operation },
  });

const directCapability = (name: string, operation: string): Capability =>
  defineCapability({
    name,
    description: `Stages ${operation} without approval.`,
    risk: "WRITE",
    staging: { operation },
  });

/**
 * The demo's `armCommitFault` shape: the commit is dispatched and then
 * something throws, so the runtime cannot know whether it landed.
 */
function throwsAfterCommit(adapter: IndexedDbStagingAdapter): StagingAdapter<IndexedDbFork> {
  return {
    ...adapter,
    commit: (fork, restage) => {
      adapter.commit(fork, restage);
      throw new Error("The connection dropped after the write was sent; the commit's outcome is unknown.");
    },
  };
}

describe("the IndexedDB staging adapter holds the fork, diff, commit, release contract", () => {
  it("fork then diff reports exactly the changed fields, and touches nothing live", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();

    const { staged } = adapter.fork("cancel", { id: "O-1" });

    expect(adapter.diff(staged)).toEqual([
      { field: "orders:O-1.status", before: "processing", after: "cancelled" },
    ]);
    expect(adapter.read(ORDERS, "O-1")).toEqual(ORDER_ROWS[0]);
    await adapter.flush();
    expect(db.table(DB, ORDERS).get("O-1")).toEqual(ORDER_ROWS[0]);
    // The fork is durable under its own id, which is what identify hands out.
    expect(adapter.identify(staged)).toEqual({ fork: staged.id, operation: "cancel" });
    expect([...db.table(DB, STAGING).keys()]).toEqual([staged.id]);
  });

  it("commit applies every staged row in one transaction and bumps each row's version", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const { staged } = adapter.fork("cancel_pair", {});
    await adapter.flush();
    const before = db.transactions.length;

    adapter.commit(staged, () => adapter.fork("cancel_pair", {}));
    await adapter.flush();

    expect(db.table(DB, ORDERS).get("O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40, version: 4 });
    expect(db.table(DB, ORDERS).get("O-2")).toEqual({ id: "O-2", status: "cancelled", total: 15, version: 2 });
    expect(db.table(DB, STAGING).size).toBe(0);
    const writes = db.transactions.slice(before).filter((tx) => tx.mode === "readwrite");
    expect(writes).toEqual([{ names: [ORDERS, STAGING], mode: "readwrite" }]);
  });

  it("commit refuses when a base row's version moved between fork and commit, and writes nothing", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const first = adapter.fork("cancel", { id: "O-1" });
    const second = adapter.fork("flag", { id: "O-1" });
    adapter.commit(first.staged, () => adapter.fork("cancel", { id: "O-1" }));
    await adapter.flush();
    const before = db.transactions.length;

    let refusal: unknown;
    try {
      adapter.commit(second.staged, () => adapter.fork("flag", { id: "O-1" }));
    } catch (err) {
      refusal = err;
    }
    await adapter.flush();

    expect(refusal).toBeInstanceOf(CapabilityUnavailableError);
    expect((refusal as CapabilityUnavailableError).unavailability.reasonCode).toBe("APPROVAL_STALE");
    const landed = { id: "O-1", status: "cancelled", total: 40, version: 4 };
    expect(adapter.read(ORDERS, "O-1")).toEqual(landed);
    expect(db.table(DB, ORDERS).get("O-1")).toEqual(landed);
    // The only write after the refusal is the release of the fork itself.
    expect(
      db.transactions.slice(before).filter((tx) => tx.mode === "readwrite" && tx.names.includes(ORDERS)),
    ).toEqual([]);
    // The refused fork is released, not left for someone to approve later.
    expect(db.table(DB, STAGING).size).toBe(0);
  });

  it("a row moved by another writer aborts the transaction, and IndexedDB lands none of it", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const { staged } = adapter.fork("cancel_pair", {});
    // Another tab wrote O-2 straight into the database. This process's mirror
    // cannot see it, so only the transaction's own check can.
    db.table(DB, ORDERS).set("O-2", { id: "O-2", status: "shipped", total: 15, version: 2 });

    adapter.commit(staged, () => adapter.fork("cancel_pair", {}));
    await expect(adapter.flush()).rejects.toThrow(/O-2/);

    expect(db.table(DB, ORDERS).get("O-1")).toEqual(ORDER_ROWS[0]);
    expect(db.table(DB, ORDERS).get("O-2")).toEqual({ id: "O-2", status: "shipped", total: 15, version: 2 });
  });

  it("release drops the fork, and a commit after release refuses", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const { staged } = adapter.fork("cancel", { id: "O-1" });
    await adapter.flush();
    expect(db.table(DB, STAGING).size).toBe(1);

    adapter.release(staged);
    await adapter.flush();
    expect(db.table(DB, STAGING).size).toBe(0);

    expect(() => adapter.commit(staged, () => adapter.fork("cancel", { id: "O-1" }))).toThrow(
      StagedCommitRefused,
    );
    await adapter.flush();
    expect(adapter.read(ORDERS, "O-1")).toEqual(ORDER_ROWS[0]);
    expect(db.table(DB, ORDERS).get("O-1")).toEqual(ORDER_ROWS[0]);
  });

  it("a commit cut off by an unload leaves the fork durable and the rows untouched", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const { staged } = adapter.fork("cancel", { id: "O-1" });
    await adapter.flush();

    db.cut();
    adapter.commit(staged, () => adapter.fork("cancel", { id: "O-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(db.table(DB, ORDERS).get("O-1")).toEqual(ORDER_ROWS[0]);
    expect(db.table(DB, STAGING).has(staged.id)).toBe(true);

    const reopened = makeAdapter(db, false).adapter;
    await reopened.open();
    const rebuilt = reopened.resolveArtifact({
      version: 1,
      id: "UNREC-1",
      kind: "commit_indeterminate",
      capability: "cancel_thing",
      detail: "unloaded",
      changes: [],
      at: 1,
      artifact: { kind: "reference", reference: { fork: staged.id, operation: "cancel" } },
      seal: "unchecked",
    });
    expect(rebuilt?.id).toBe(staged.id);
    expect(reopened.diff(rebuilt!)).toEqual([
      { field: "orders:O-1.status", before: "processing", after: "cancelled" },
    ]);
    reopened.reconcile(rebuilt!, { kind: "commit_not_applied" });
    await reopened.flush();
    expect(db.table(DB, STAGING).size).toBe(0);
  });
});

describe("an interrupted commit is re-identified after reload", () => {
  it("persists the fork id, rebuilds the fork through resolveArtifact, and settles it", async () => {
    const { adapter: first, db } = makeAdapter();
    await first.open();
    const records = indexedDbPersistence({
      name: "meridian-records",
      indexedDB: db.factory,
      resolveArtifact: first.resolveArtifact,
    });
    const runtime = createAgentDeskRuntime({
      capabilities: [directCapability("cancel_thing", "cancel")],
      registerTool: async () => {},
      actor: AGENT,
      staging: throwsAfterCommit(first),
      persistence: records,
    });
    await runtime.start();

    const result = await runtime.invoke("cancel_thing", { id: "O-1" });
    expect(result.code).toBe("EXECUTION_INDETERMINATE");
    const [record] = runtime.listUnreconciled();
    await first.flush();
    await runtime.stop();

    const saved = db.table("meridian-records", "records").get(record!.id) as {
      artifact: { kind: string; reference?: { fork?: unknown } };
    };
    expect(saved.artifact.kind).toBe("reference");
    const forkId = saved.artifact.reference?.fork;
    expect(typeof forkId).toBe("string");
    // The write did land; only the report was lost. The commit's own
    // transaction deleted the fork, so its absence is what says so.
    expect(db.table(DB, ORDERS).get("O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40, version: 4 });
    expect(db.table(DB, STAGING).has(forkId as string)).toBe(false);

    const second = makeAdapter(db, false).adapter;
    await second.open();
    const reloaded = createAgentDeskRuntime({
      capabilities: [directCapability("cancel_thing", "cancel")],
      registerTool: async () => {},
      actor: AGENT,
      staging: second,
      persistence: indexedDbPersistence({
        name: "meridian-records",
        indexedDB: db.factory,
        resolveArtifact: second.resolveArtifact,
      }),
    });
    await reloaded.start();

    expect(reloaded.listUnreconciled().map((entry) => entry.id)).toEqual([record!.id]);
    const repeat = await reloaded.invoke("cancel_thing", { id: "O-1" });
    expect(repeat.code).toBe("EXECUTION_INDETERMINATE");

    const settled = reloaded.reconcile(record!.id, { kind: "commit_applied" }, HUMAN);
    expect(settled).toEqual({ ok: true });
    await second.flush();
    expect(reloaded.listUnreconciled()).toEqual([]);
    expect(db.table(DB, STAGING).size).toBe(0);
    expect(db.table("meridian-records", "records").size).toBe(0);
  });
});

describe("the staged reviews from 2026-08-31, where adapter-generic, hold against IndexedDB", () => {
  async function runtimeOver(adapter: IndexedDbStagingAdapter, capabilities: Capability[]) {
    const runtime = createAgentDeskRuntime({
      capabilities,
      registerTool: async () => {},
      actor: AGENT,
      staging: adapter,
    });
    await runtime.start();
    return runtime;
  }

  it("stages without touching live state", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const runtime = await runtimeOver(adapter, [stagedCapability("cancel_thing", "cancel")]);

    const result = await runtime.invoke("cancel_thing", { id: "O-1" });

    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.data?.approvalEvidence).toBe("derived");
    expect(result.data?.will_change).toEqual([
      { field: "orders:O-1.status", before: "processing", after: "cancelled" },
    ]);
    await adapter.flush();
    expect(adapter.read(ORDERS, "O-1")).toEqual(ORDER_ROWS[0]);
    expect(db.table(DB, ORDERS).get("O-1")).toEqual(ORDER_ROWS[0]);
  });

  it("discards the proposal when the human rejects", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const runtime = await runtimeOver(adapter, [stagedCapability("cancel_thing", "cancel")]);
    await runtime.invoke("cancel_thing", { id: "O-1" });
    await adapter.flush();
    expect(db.table(DB, STAGING).size).toBe(1);

    runtime.reject(runtime.getSnapshot().pending[0]!.id, HUMAN);
    await adapter.flush();

    expect(db.table(DB, STAGING).size).toBe(0);
    expect(db.table(DB, ORDERS).get("O-1")).toEqual(ORDER_ROWS[0]);
  });

  it("lands the reviewed change when the human approves", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const runtime = await runtimeOver(adapter, [stagedCapability("cancel_thing", "cancel")]);
    await runtime.invoke("cancel_thing", { id: "O-1" });

    const approved = await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);
    await adapter.flush();

    expect(approved.isError).toBeFalsy();
    expect(db.table(DB, ORDERS).get("O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40, version: 4 });
    expect(db.table(DB, STAGING).size).toBe(0);
  });

  it("refuses a stale approval when the row moved after the human read it", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const runtime = await runtimeOver(adapter, [
      stagedCapability("cancel_thing", "cancel"),
      directCapability("flag_thing", "flag"),
    ]);
    await runtime.invoke("cancel_thing", { id: "O-1" });
    await runtime.invoke("flag_thing", { id: "O-1" });

    const approved = await runtime.approve(runtime.getSnapshot().pending[0]!.id, HUMAN);
    await adapter.flush();

    expect(approved.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(approved.data?.reasonCode).toBe("APPROVAL_STALE");
    expect(db.table(DB, ORDERS).get("O-1")).toEqual({ id: "O-1", status: "processing", total: 40, flagged: true, version: 4 });
  });

  it("derives a plan's second operation against the first's staged head, and commits both", async () => {
    const { adapter, db } = makeAdapter();
    await adapter.open();
    const runtime = await runtimeOver(adapter, [
      stagedCapability("cancel_thing", "cancel"),
      stagedCapability("flag_thing", "flag"),
    ]);

    const plan = await runtime.prepare({
      operations: [
        { capability: "cancel_thing", input: { id: "O-1" } },
        { capability: "flag_thing", input: { id: "O-1" } },
      ],
    });

    expect(plan.operations[0]?.preview).toEqual([
      { field: "orders:O-1.status", before: "processing", after: "cancelled" },
    ]);
    expect(plan.operations[1]?.preview).toEqual([
      { field: "orders:O-1.flagged", before: null, after: true },
    ]);
    runtime.approvePlan(plan.id, HUMAN);
    const committed = await runtime.commitPlan(plan.id);
    await adapter.flush();
    expect(committed.ok).toBe(true);
    expect(db.table(DB, ORDERS).get("O-1")).toEqual({
      id: "O-1",
      status: "cancelled",
      total: 40,
      flagged: true,
      version: 5,
    });
    expect(db.table(DB, STAGING).size).toBe(0);
  });

  it("refuses to start when a capability names an operation the adapter has not got", async () => {
    const { adapter } = makeAdapter();
    await adapter.open();
    const runtime = createAgentDeskRuntime({
      capabilities: [stagedCapability("refund_thing", "refund")],
      registerTool: async () => {},
      actor: AGENT,
      staging: adapter,
    });

    await expect(runtime.start()).rejects.toThrow(/refund/);
  });
});
