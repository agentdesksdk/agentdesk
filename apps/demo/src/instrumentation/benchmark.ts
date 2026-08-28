import type { Exposure } from "@agentdesk/webmcp";
import { agentdesk } from "../runtime/agentdesk.ts";

export type BenchRun = {
  id: string;
  mode: Exposure;
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number | null;
  catalogSize: number;
  activeTools: number;
  /** Schema bytes at run start, before any routing. */
  schemaBytesStart: number;
  /** Highest schema bytes observed during the run (the fair task-time figure). */
  schemaBytesPeak: number;
  /** Schema bytes when the run stopped. */
  schemaBytes: number;
  invocations: number;
  staleCalls: number;
  approvals: number;
  heroCompleted: boolean;
};

type BenchState = {
  activeRun: BenchRun | null;
  runs: BenchRun[];
};

const STORAGE_KEY = "agentdesk-benchmark-runs";

function loadRuns(): BenchRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as BenchRun[]) : [];
    return parsed.map((run) => ({
      ...run,
      schemaBytesStart: run.schemaBytesStart ?? run.schemaBytes,
      schemaBytesPeak: run.schemaBytesPeak ?? run.schemaBytes,
    }));
  } catch {
    return [];
  }
}

let state: BenchState = { activeRun: null, runs: loadRuns() };
let auditCursor = 0;
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.runs));
  } catch {
    /* storage may be unavailable in private browsing; runs stay in memory */
  }
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function refreshGauges(run: BenchRun): void {
  const snapshot = agentdesk.getSnapshot();
  run.catalogSize = snapshot.catalogSize;
  run.activeTools = Math.max(run.activeTools, snapshot.nativeTools.length);
  run.schemaBytes = snapshot.schemaBytes;
  run.schemaBytesPeak = Math.max(run.schemaBytesPeak, snapshot.schemaBytes);
}

agentdesk.subscribe((snapshot) => {
  const events = snapshot.audit;
  if (auditCursor > events.length) {
    auditCursor = 0;
  }
  const fresh = events.slice(auditCursor);
  auditCursor = events.length;
  const run = state.activeRun;
  if (!run) {
    return;
  }
  let changed = false;
  if (snapshot.schemaBytes > run.schemaBytesPeak) {
    run.schemaBytesPeak = snapshot.schemaBytes;
    changed = true;
  }
  if (snapshot.nativeTools.length > run.activeTools) {
    run.activeTools = snapshot.nativeTools.length;
    changed = true;
  }
  for (const event of fresh) {
    if (event.kind === "capability_invoked") {
      run.invocations += 1;
      changed = true;
    }
    if (
      event.kind === "capability_unavailable" &&
      event.reasonCode === "CAPABILITY_RETIRED"
    ) {
      run.staleCalls += 1;
      changed = true;
    }
    if (event.kind === "approval_requested") {
      run.approvals += 1;
      changed = true;
    }
    if (
      event.kind === "execution_completed" &&
      event.capability === "refund_shipping"
    ) {
      run.heroCompleted = true;
      changed = true;
    }
  }
  if (changed) {
    refreshGauges(run);
    state = { ...state, activeRun: { ...run } };
    emit();
  }
});

export const benchmark = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getState(): BenchState {
    return state;
  },
  startRun(): void {
    const snapshot = agentdesk.getSnapshot();
    auditCursor = snapshot.audit.length;
    const run: BenchRun = {
      id: `run-${Date.now()}`,
      mode: snapshot.exposure,
      startedAt: Date.now(),
      endedAt: null,
      elapsedMs: null,
      catalogSize: snapshot.catalogSize,
      activeTools: snapshot.nativeTools.length,
      schemaBytesStart: snapshot.schemaBytes,
      schemaBytesPeak: snapshot.schemaBytes,
      schemaBytes: snapshot.schemaBytes,
      invocations: 0,
      staleCalls: 0,
      approvals: 0,
      heroCompleted: false,
    };
    state = { ...state, activeRun: run };
    emit();
  },
  stopRun(): void {
    const run = state.activeRun;
    if (!run) {
      return;
    }
    refreshGauges(run);
    const finished: BenchRun = {
      ...run,
      endedAt: Date.now(),
      elapsedMs: Date.now() - run.startedAt,
    };
    state = { activeRun: null, runs: [finished, ...state.runs].slice(0, 20) };
    persist();
    emit();
  },
  discardActive(): void {
    if (state.activeRun) {
      state = { ...state, activeRun: null };
      emit();
    }
  },
  clearRuns(): void {
    state = { ...state, runs: [] };
    persist();
    emit();
  },
};

/** Same estimator for both modes; explicitly an estimate (~4 bytes/token). */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}
