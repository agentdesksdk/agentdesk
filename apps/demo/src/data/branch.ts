import type { Change } from "@agentdesk/webmcp";
import type { Branch, DemoState } from "./types.ts";

type Row = Record<string, unknown>;

/** Conflicting write to one field. The human's value stands; the agent's is reported. */
export type MergeConflict = {
  collection: keyof DemoState;
  key: string;
  field: string;
  human: unknown;
  agent: unknown;
};

const KEYS: Record<keyof DemoState, string> = {
  customers: "id",
  orders: "id",
  products: "sku",
  tickets: "id",
  credits: "id",
  invoices: "id",
};

const LABELS: Record<keyof DemoState, (key: string) => string> = {
  customers: (key) => `Customer ${key}`,
  orders: (key) => `Order #${key}`,
  products: (key) => `Product ${key}`,
  tickets: (key) => `Ticket ${key}`,
  credits: (key) => `Credit ${key}`,
  invoices: (key) => `Invoice ${key}`,
};

const COLLECTIONS = Object.keys(KEYS) as (keyof DemoState)[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const rows = (state: DemoState, collection: keyof DemoState) =>
  state[collection] as unknown as Row[];

const index = (list: readonly Row[], key: string) =>
  new Map(list.map((row) => [String(row[key]), row]));

const words = (field: string) =>
  field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

function describe(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const record = value as Row;
  for (const key of ["text", "name", "reason", "subject"]) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  return JSON.stringify(value);
}

/** A derived change together with the entity it belongs to. */
export type ChangeEntry = { entity: string; change: Change };

/**
 * What a staged run actually did, read off the fork rather than described by
 * hand. This is the diff a human approves, so it has to be derived from the
 * same execution that will land.
 */
export function deriveChanges(base: DemoState, head: DemoState): Change[] {
  return deriveEntries(base, head).map((entry) => entry.change);
}

/** The same diff, addressable by entity so a route can render its own ghost. */
export function deriveEntries(base: DemoState, head: DemoState): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  for (const collection of COLLECTIONS) {
    const key = KEYS[collection];
    const label = LABELS[collection];
    const before = index(rows(base, collection), key);
    for (const row of rows(head, collection)) {
      const id = String(row[key]);
      const entity = `${collection}:${id}`;
      const push = (change: Change) => entries.push({ entity, change });
      const previous = before.get(id);
      if (!previous) {
        push({ field: label(id), before: null, after: "added" });
        continue;
      }
      for (const field of Object.keys(row)) {
        const a = previous[field];
        const b = row[field];
        if (same(a, b)) {
          continue;
        }
        if (Array.isArray(a) && Array.isArray(b)) {
          const known = new Set(a.map((item) => JSON.stringify(item)));
          for (const item of b) {
            if (!known.has(JSON.stringify(item))) {
              push({
                field: `${label(id)} ${words(field)} added`,
                before: null,
                after: describe(item),
              });
            }
          }
          continue;
        }
        push({
          field: `${label(id)} ${words(field)}`,
          before: a ?? null,
          after: b ?? null,
        });
      }
    }
    const after = index(rows(head, collection), key);
    for (const row of rows(base, collection)) {
      const id = String(row[key]);
      if (!after.has(id)) {
        entries.push({
          entity: `${collection}:${id}`,
          change: { field: label(id), before: "present", after: "removed" },
        });
      }
    }
  }
  return entries;
}

// ponytail: every array in DemoState is append-only (notes, tags, items,
// messages), so union-by-value is a correct list merge. A field both sides
// reorder would need real sequence ops; this domain has none.
function mergeList(base: unknown[], human: unknown[], agent: unknown[]): unknown[] {
  const known = new Set([...base, ...human].map((value) => JSON.stringify(value)));
  const out = [...human];
  for (const value of agent) {
    if (!known.has(JSON.stringify(value))) out.push(value);
  }
  return out;
}

function mergeRow(
  base: Row,
  human: Row,
  agent: Row,
  report: (field: string, human: unknown, agent: unknown) => void,
): Row {
  const out: Row = { ...human };
  for (const field of Object.keys(agent)) {
    const b = base[field];
    const h = human[field];
    const a = agent[field];
    if (same(a, b)) continue;
    if (Array.isArray(a) && Array.isArray(b) && Array.isArray(h)) {
      out[field] = mergeList(b, h, a);
      continue;
    }
    if (!same(h, b)) {
      report(field, h, a);
      continue;
    }
    out[field] = a;
  }
  return out;
}

/**
 * Three-way merge of an agent branch into the human's working copy.
 *
 * A field the agent wrote lands. A field only the human moved is preserved.
 * A field both moved stays the human's and comes back as a conflict, because
 * the human is the authority and silently picking a winner is how an approved
 * change turns into a change nobody approved.
 */
export function mergeBranch(
  branch: Branch,
  human: DemoState,
): { state: DemoState; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const state = {} as Record<string, Row[]>;

  for (const collection of COLLECTIONS) {
    const key = KEYS[collection];
    const baseRows = index(rows(branch.base, collection), key);
    const agentRows = index(rows(branch.head, collection), key);
    const humanRows = rows(human, collection);
    const merged: Row[] = [];

    for (const row of humanRows) {
      const id = String(row[key]);
      const branched = agentRows.get(id);
      if (!branched) {
        merged.push(row);
        continue;
      }
      merged.push(
        mergeRow(baseRows.get(id) ?? {}, row, branched, (field, h, a) => {
          conflicts.push({ collection, key: id, field, human: h, agent: a });
        }),
      );
    }

    const present = new Set(humanRows.map((row) => String(row[key])));
    for (const row of rows(branch.head, collection)) {
      const id = String(row[key]);
      if (!present.has(id) && !baseRows.has(id)) merged.push(row);
    }
    state[collection] = merged;
  }

  return { state: state as unknown as DemoState, conflicts };
}
