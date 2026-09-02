import { describe, expect, it } from "vitest";
import {
  CapabilityUnavailableError,
  createAgentDeskRuntime,
  defineCapability,
  receipt,
  RestCommitPartial,
  restStaging,
  StagedCommitRefused,
  type Capability,
  type RestStagingAdapter,
} from "../src/index.ts";

const HUMAN = { id: "operator-1", name: "Amein", kind: "human" as const };
const AGENT = { id: "agent", name: "Agent", kind: "agent" as const };
const BASE = "https://api.meridian.test";

type Logged = { method: string; path: string; headers: Record<string, string>; body?: unknown };

/**
 * A double of the REST surface the adapter uses: GET a row with an ETag or
 * a version field, PUT a row under If-Match, and optionally POST a batch
 * that checks every If-Match before it applies any write. `move` is another
 * writer; `failPut` makes the nth PUT throw after the server applied it,
 * which is what a lost response looks like from the client.
 */
function fakeRest(options: { etags?: boolean; batch?: boolean } = {}) {
  const rows = new Map<string, { row: Record<string, unknown>; version: number }>();
  const requests: Logged[] = [];
  let failPut: number | null = null;
  let puts = 0;
  const etags = options.etags !== false;
  const tag = (version: number) => `"v${version}"`;

  const seed = (path: string, row: Record<string, unknown>, version = 1) => {
    rows.set(path, { row: { ...row }, version });
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const represent = (path: string) => {
    const entry = rows.get(path)!;
    // A field-versioned resource carries its version in the body; an
    // ETag-versioned one carries it only in the header.
    return path.startsWith("/customers/")
      ? { ...entry.row, version: entry.version }
      : { ...entry.row };
  };
  const expected = (path: string) => {
    const entry = rows.get(path)!;
    return path.startsWith("/customers/") ? `"${entry.version}"` : tag(entry.version);
  };
  const apply = (path: string, body: Record<string, unknown>) => {
    const entry = rows.get(path)!;
    const { version: _ignored, ...fields } = body;
    entry.row = { ...fields };
    entry.version += 1;
    return entry.version;
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, path: url.pathname, headers, ...(body !== undefined ? { body } : {}) });

    if (method === "GET") {
      if (!rows.has(url.pathname)) {
        return json(404, { error: "not found" });
      }
      const headersOut = etags ? { etag: tag(rows.get(url.pathname)!.version) } : {};
      return json(200, represent(url.pathname), headersOut);
    }
    if (method === "PUT") {
      puts += 1;
      const attempt = puts;
      if (!rows.has(url.pathname)) {
        return json(404, { error: "not found" });
      }
      if (headers["if-match"] !== expected(url.pathname)) {
        return json(412, { error: "precondition failed" });
      }
      const version = apply(url.pathname, body as Record<string, unknown>);
      if (failPut === attempt) {
        failPut = null;
        throw new TypeError("fetch failed");
      }
      return json(200, represent(url.pathname), etags ? { etag: tag(version) } : {});
    }
    if (method === "POST" && url.pathname === "/batch" && options.batch) {
      const writes = (body as { writes: Array<{ path: string; ifMatch: string; body: Record<string, unknown> }> }).writes;
      const refused = writes.filter((write) => headers && write.ifMatch !== expected(write.path));
      if (refused.length > 0) {
        return json(412, { refused: refused.map((write) => write.path) });
      }
      const acknowledged = writes.map((write) => {
        const version = apply(write.path, write.body);
        return { path: write.path, etag: tag(version) };
      });
      return json(200, { acknowledged });
    }
    return json(405, { error: "method not allowed" });
  };

  return {
    fetch,
    seed,
    requests,
    row: (path: string) => ({ ...rows.get(path)!.row }),
    version: (path: string) => rows.get(path)!.version,
    /** Another writer moved the row. */
    move: (path: string) => {
      rows.get(path)!.version += 1;
    },
    /** The nth PUT is applied by the server, then the response is lost. */
    failPut: (nth: number) => {
      failPut = nth;
    },
    puts: () => requests.filter((request) => request.method === "PUT").length,
  };
}

function makeAdapter(server = fakeRest(), options: { batch?: boolean } = {}) {
  server.seed("/orders/O-1", { id: "O-1", status: "processing", total: 40 }, 3);
  server.seed("/orders/O-2", { id: "O-2", status: "processing", total: 15 }, 1);
  server.seed("/customers/C-1", { id: "C-1", status: "active" }, 1);
  const adapter = restStaging({
    baseUrl: BASE,
    fetch: server.fetch,
    headers: { authorization: "Bearer test" },
    resources: {
      orders: { path: (id) => `/orders/${id}`, version: "etag" },
      customers: { path: (id) => `/customers/${id}`, version: { field: "version" } },
    },
    ...(options.batch ? { batch: { path: "/batch", atomic: true as const } } : {}),
    operations: {
      cancel: {
        rows: (input) => [{ resource: "orders", id: String(input.id) }],
        run: (draft, input) => {
          const id = String(input.id);
          const order = draft.get("orders", id)!;
          draft.put("orders", { ...order, status: "cancelled" });
          return receipt({ entity: `orders:${id}`, changes: [], undoable: false, result: { id } });
        },
      },
      flag: {
        rows: (input) => [{ resource: "orders", id: String(input.id) }],
        run: (draft, input) => {
          const id = String(input.id);
          draft.put("orders", { ...draft.get("orders", id)!, flagged: true });
          return receipt({ entity: `orders:${id}`, changes: [], undoable: false, result: { id } });
        },
      },
      cancel_pair: {
        rows: () => [
          { resource: "orders", id: "O-1" },
          { resource: "orders", id: "O-2" },
        ],
        run: (draft) => {
          draft.put("orders", { ...draft.get("orders", "O-1")!, status: "cancelled" });
          draft.put("orders", { ...draft.get("orders", "O-2")!, status: "cancelled" });
          return receipt({ entity: "orders:O-1", changes: [], undoable: false, result: {} });
        },
      },
      suspend_customer: {
        rows: () => [{ resource: "customers", id: "C-1" }],
        run: (draft) => {
          draft.put("customers", { ...draft.get("customers", "C-1")!, status: "suspended" });
          return receipt({ entity: "customers:C-1", changes: [], undoable: false, result: {} });
        },
      },
    },
  });
  return { adapter, server };
}

const directCapability = (name: string, operation: string): Capability =>
  defineCapability({
    name,
    description: `Stages ${operation} without approval.`,
    risk: "WRITE",
    staging: { operation },
  });

const ifMatch = (requests: Logged[]) =>
  requests.filter((request) => request.method === "PUT").map((request) => [request.path, request.headers["if-match"]]);

describe("the REST staging adapter records a version for every row it stages", () => {
  it("fork records each row's version from its ETag, fetched with the declared headers", async () => {
    const { adapter, server } = makeAdapter();

    await adapter.prepare("cancel", { id: "O-1" });
    const { staged } = adapter.fork("cancel", { id: "O-1" });

    expect(staged.base).toEqual([
      { resource: "orders", id: "O-1", version: '"v3"', row: { id: "O-1", status: "processing", total: 40 } },
    ]);
    expect(server.requests).toEqual([
      { method: "GET", path: "/orders/O-1", headers: { authorization: "Bearer test" } },
    ]);
    expect(adapter.identify(staged)).toEqual({ fork: staged.id, operation: "cancel", input: { id: "O-1" } });
  });

  it("fork records a version from the field a resource declares", async () => {
    const { adapter } = makeAdapter();

    await adapter.prepare("suspend_customer", {});
    const { staged } = adapter.fork("suspend_customer", {});

    expect(staged.base).toEqual([
      { resource: "customers", id: "C-1", version: "1", row: { id: "C-1", status: "active", version: 1 } },
    ]);
  });

  it("refuses to stage a resource that offers neither an ETag nor a version field", async () => {
    const { adapter } = makeAdapter(fakeRest({ etags: false }));

    await expect(adapter.prepare("cancel", { id: "O-1" })).rejects.toThrow(/ETag|version/);
    expect(() => adapter.fork("cancel", { id: "O-1" })).toThrow(/prepare/);
  });

  it("diff reports exactly the changed fields", async () => {
    const { adapter } = makeAdapter();
    await adapter.prepare("cancel", { id: "O-1" });

    const { staged } = adapter.fork("cancel", { id: "O-1" });

    expect(adapter.diff(staged)).toEqual([
      { field: "orders:O-1.status", before: "processing", after: "cancelled" },
    ]);
  });
});

describe("the REST staging adapter commits under If-Match", () => {
  it("sends every write with If-Match on the recorded version and completes when all are acknowledged", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel_pair", {});
    const { staged } = adapter.fork("cancel_pair", {});

    await adapter.commit(staged, () => adapter.fork("cancel_pair", {}));

    expect(ifMatch(server.requests)).toEqual([
      ["/orders/O-1", '"v3"'],
      ["/orders/O-2", '"v1"'],
    ]);
    expect(server.row("/orders/O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40 });
    expect(server.row("/orders/O-2")).toEqual({ id: "O-2", status: "cancelled", total: 15 });
    expect(staged.acknowledged).toEqual([
      { resource: "orders", id: "O-1", version: '"v4"' },
      { resource: "orders", id: "O-2", version: '"v2"' },
    ]);
  });

  it("quotes a field version as the entity tag it sends", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("suspend_customer", {});
    const { staged } = adapter.fork("suspend_customer", {});

    await adapter.commit(staged, () => adapter.fork("suspend_customer", {}));

    expect(ifMatch(server.requests)).toEqual([["/customers/C-1", '"1"']]);
    expect(server.row("/customers/C-1")).toEqual({ id: "C-1", status: "suspended" });
    expect(staged.acknowledged).toEqual([{ resource: "customers", id: "C-1", version: "2" }]);
  });

  it("a 412 on the first write refuses APPROVAL_STALE with nothing written and no retry", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel_pair", {});
    const { staged } = adapter.fork("cancel_pair", {});
    server.move("/orders/O-1");

    let refusal: unknown;
    try {
      await adapter.commit(staged, () => adapter.fork("cancel_pair", {}));
    } catch (err) {
      refusal = err;
    }

    expect(refusal).toBeInstanceOf(CapabilityUnavailableError);
    expect((refusal as CapabilityUnavailableError).unavailability.reasonCode).toBe("APPROVAL_STALE");
    expect(server.puts()).toBe(1);
    expect(server.row("/orders/O-1")).toEqual({ id: "O-1", status: "processing", total: 40 });
    expect(server.row("/orders/O-2")).toEqual({ id: "O-2", status: "processing", total: 15 });
    expect(staged.acknowledged).toEqual([]);
  });

  it("a 412 on the second write after the first was acknowledged is indeterminate, naming the acknowledged rows", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel_pair", {});
    const { staged } = adapter.fork("cancel_pair", {});
    server.move("/orders/O-2");

    let outcome: unknown;
    try {
      await adapter.commit(staged, () => adapter.fork("cancel_pair", {}));
    } catch (err) {
      outcome = err;
    }

    expect(outcome).toBeInstanceOf(RestCommitPartial);
    expect(outcome).not.toBeInstanceOf(StagedCommitRefused);
    expect(outcome).not.toBeInstanceOf(CapabilityUnavailableError);
    const partial = outcome as RestCommitPartial;
    expect(partial.acknowledged).toEqual([{ resource: "orders", id: "O-1", version: '"v4"' }]);
    expect(partial.refused).toEqual({ resource: "orders", id: "O-2" });
    expect(partial.unsent).toEqual([]);
    expect(partial.message).toMatch(/orders O-1/);
    expect(partial.message).toMatch(/orders O-2/);
    expect(server.puts()).toBe(2);
    expect(server.row("/orders/O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40 });
    expect(server.row("/orders/O-2")).toEqual({ id: "O-2", status: "processing", total: 15 });
  });

  it("a network failure after the first write was sent is indeterminate, with the row in flight named as unknown", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel_pair", {});
    const { staged } = adapter.fork("cancel_pair", {});
    server.failPut(2);

    let outcome: unknown;
    try {
      await adapter.commit(staged, () => adapter.fork("cancel_pair", {}));
    } catch (err) {
      outcome = err;
    }

    expect(outcome).toBeInstanceOf(RestCommitPartial);
    const partial = outcome as RestCommitPartial;
    expect(partial.acknowledged).toEqual([{ resource: "orders", id: "O-1", version: '"v4"' }]);
    expect(partial.unknown).toEqual({ resource: "orders", id: "O-2" });
    expect(partial.message).toMatch(/fetch failed/);
    // Nothing is retried: the second PUT was attempted exactly once.
    expect(server.puts()).toBe(2);
  });

  it("a network failure on the first write is indeterminate too, because an error does not prove the write did not land", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel", { id: "O-1" });
    const { staged } = adapter.fork("cancel", { id: "O-1" });
    server.failPut(1);

    let outcome: unknown;
    try {
      await adapter.commit(staged, () => adapter.fork("cancel", { id: "O-1" }));
    } catch (err) {
      outcome = err;
    }

    expect(outcome).toBeInstanceOf(RestCommitPartial);
    expect((outcome as RestCommitPartial).acknowledged).toEqual([]);
    expect((outcome as RestCommitPartial).unknown).toEqual({ resource: "orders", id: "O-1" });
    expect(server.puts()).toBe(1);
  });

  it("release drops the fork, and a commit after release refuses", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel", { id: "O-1" });
    const { staged } = adapter.fork("cancel", { id: "O-1" });

    adapter.release(staged);

    await expect(adapter.commit(staged, () => adapter.fork("cancel", { id: "O-1" }))).rejects.toThrow(
      StagedCommitRefused,
    );
    expect(server.puts()).toBe(0);
  });

  it("uses one batched request where the backend offers one, and a 412 there refuses with nothing written", async () => {
    const { adapter, server } = makeAdapter(fakeRest({ batch: true }), { batch: true });
    await adapter.prepare("cancel_pair", {});
    const { staged } = adapter.fork("cancel_pair", {});

    await adapter.commit(staged, () => adapter.fork("cancel_pair", {}));

    const posts = server.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      writes: [
        { method: "PUT", path: "/orders/O-1", ifMatch: '"v3"', body: { id: "O-1", status: "cancelled", total: 40 } },
        { method: "PUT", path: "/orders/O-2", ifMatch: '"v1"', body: { id: "O-2", status: "cancelled", total: 15 } },
      ],
    });
    expect(server.puts()).toBe(0);
    expect(server.row("/orders/O-2")).toEqual({ id: "O-2", status: "cancelled", total: 15 });

    await adapter.prepare("flag", { id: "O-1" });
    const again = adapter.fork("flag", { id: "O-1" });
    server.move("/orders/O-1");
    let refusal: unknown;
    try {
      await adapter.commit(again.staged, () => adapter.fork("flag", { id: "O-1" }));
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(CapabilityUnavailableError);
    expect(server.row("/orders/O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40 });
  });

  it("a fork staged inside a scope after another commits under the version that commit was given", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.prepare("cancel", { id: "O-1" });
    await adapter.prepare("flag", { id: "O-1" });

    const [first, second] = adapter.scope(() => [
      adapter.fork("cancel", { id: "O-1" }),
      adapter.fork("flag", { id: "O-1" }),
    ]);

    expect(adapter.diff(second.staged)).toEqual([{ field: "orders:O-1.flagged", before: null, after: true }]);
    expect(second.staged.base[0]).toMatchObject({ follows: first.staged.id });
    await adapter.commit(first.staged, () => adapter.fork("cancel", { id: "O-1" }));
    await adapter.commit(second.staged, () => adapter.fork("flag", { id: "O-1" }));

    expect(ifMatch(server.requests)).toEqual([
      ["/orders/O-1", '"v3"'],
      ["/orders/O-1", '"v4"'],
    ]);
    expect(server.row("/orders/O-1")).toEqual({ id: "O-1", status: "cancelled", total: 40, flagged: true });
  });
});

describe("an interrupted REST commit is re-identifiable after a reload", () => {
  it("records the partial outcome with the acknowledged rows, and resolveArtifact rebuilds the fork by id", async () => {
    const { adapter, server } = makeAdapter();
    const runtime = createAgentDeskRuntime({
      capabilities: [directCapability("cancel_pair_thing", "cancel_pair")],
      registerTool: async () => {},
      actor: AGENT,
      staging: adapter,
    });
    await runtime.start();
    await adapter.prepare("cancel_pair", {});
    server.move("/orders/O-2");

    const result = await runtime.invoke("cancel_pair_thing", {});

    expect(result.code).toBe("EXECUTION_INDETERMINATE");
    const [record] = runtime.listUnreconciled();
    expect(record?.detail).toMatch(/orders O-1/);
    expect(record?.detail).toMatch(/acknowledged/);
    expect(record?.changes).toEqual([
      { field: "orders:O-1.status", before: "processing", after: "cancelled" },
      { field: "orders:O-2.status", before: "processing", after: "cancelled" },
    ]);

    const reloaded = makeAdapter(server).adapter;
    const reference = adapter.identify(adapter.resolveArtifact({
      version: 1,
      id: record!.id,
      kind: "commit_indeterminate",
      capability: "cancel_pair_thing",
      detail: record!.detail,
      changes: [],
      at: 1,
      artifact: { kind: "reference", reference: { fork: "unknown", operation: "cancel_pair", input: {} } },
      seal: "unchecked",
    })!);
    expect(reference).toEqual({ fork: "unknown", operation: "cancel_pair", input: {} });
    const rebuilt = reloaded.resolveArtifact({
      version: 1,
      id: record!.id,
      kind: "commit_indeterminate",
      capability: "cancel_pair_thing",
      detail: record!.detail,
      changes: [],
      at: 1,
      artifact: { kind: "reference", reference: { fork: "fork-from-before", operation: "cancel_pair", input: {} } },
      seal: "unchecked",
    });
    expect(rebuilt?.id).toBe("fork-from-before");
    expect(rebuilt?.operation).toBe("cancel_pair");
    reloaded.reconcile(rebuilt!, { kind: "commit_applied" });
    expect(reloaded.resolveArtifact({
      version: 1,
      id: "UNREC-9",
      kind: "commit_indeterminate",
      capability: "gone",
      detail: "",
      changes: [],
      at: 1,
      artifact: { kind: "reference", reference: { fork: "x", operation: "not_an_operation", input: {} } },
      seal: "unchecked",
    })).toBeUndefined();
    const settled = runtime.reconcile(record!.id, { kind: "commit_applied" }, HUMAN);
    expect(settled).toEqual({ ok: true });
  });
});

describe("declaring a batch endpoint is declaring its all-or-none behaviour", () => {
  it("refuses a batch without the integrator's word that it is atomic", () => {
    const build = () =>
      restStaging({
        baseUrl: BASE,
        resources: {},
        operations: {},
        // @ts-expect-error a batch endpoint has to be declared atomic, on the integrator's word
        batch: { path: "/batch" },
      });
    expect(typeof build).toBe("function");
  });
});
