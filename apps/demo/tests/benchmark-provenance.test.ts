// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  vi.resetModules();
});

describe("timed benchmark provenance", () => {
  it("resets the application to the canonical seed before recording", async () => {
    const store = await import("../src/data/store.ts");
    store.mutate((state) => {
      state.orders.find((order) => order.id === "10428")!.status = "cancelled";
    });
    const { benchmark, BENCHMARK_SEED } = await import(
      "../src/instrumentation/benchmark.ts"
    );

    await benchmark.startRun();

    expect(
      store.getCommittedState().orders.find((order) => order.id === "10428")!
        .status,
    ).toBe("processing");
    expect(benchmark.getState().activeRun?.seedFingerprint).toBe(BENCHMARK_SEED);
    benchmark.discardActive();
  });

  it("marks old revisions, catalogs, and seeds as incomparable", async () => {
    const {
      BENCHMARK_CATALOG,
      BENCHMARK_REVISION,
      BENCHMARK_SCENARIO,
      BENCHMARK_SEED,
      isComparableRun,
    } = await import("../src/instrumentation/benchmark.ts");
    const current = {
      benchmarkRevision: BENCHMARK_REVISION,
      scenario: BENCHMARK_SCENARIO,
      catalogFingerprint: BENCHMARK_CATALOG,
      seedFingerprint: BENCHMARK_SEED,
    } as Parameters<typeof isComparableRun>[0];

    expect(isComparableRun(current)).toBe(true);
    expect(isComparableRun({ ...current, benchmarkRevision: 1 })).toBe(false);
    expect(isComparableRun({ ...current, catalogFingerprint: "old" })).toBe(
      false,
    );
    expect(isComparableRun({ ...current, seedFingerprint: "dirty" })).toBe(
      false,
    );
  });
});
