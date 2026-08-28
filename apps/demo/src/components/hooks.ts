import { useSyncExternalStore } from "react";
import { getState, subscribe } from "../data/store.ts";
import { getRuntimeSnapshot, subscribeRuntime } from "../runtime/agentdesk.ts";
import { benchmark } from "../instrumentation/benchmark.ts";

export function useRuntime() {
  return useSyncExternalStore(subscribeRuntime, getRuntimeSnapshot);
}

export function useDemoStore() {
  return useSyncExternalStore(subscribe, getState);
}

export function useBenchmark() {
  return useSyncExternalStore(benchmark.subscribe, benchmark.getState);
}
