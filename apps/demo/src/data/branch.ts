import type { Change } from "@agentdesksdk/webmcp";
import type { Branch, DemoState } from "./types.ts";

type Row = Record<string, unknown>;

/**
 * A write the merge refused. The human's value stands and the agent's is
 * reported, because the human is the authority and silently picking a
 * winner is how an approved change becomes a change nobody approved.
 */
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

const tag = (value: unknown) => JSON.stringify(value) ?? "undefined";
const same = (a: unknown, b: unknown) => tag(a) === tag(b);

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

/** Elements of `from` that `to` no longer contains, compared by value. */
function removed(from: readonly unknown[], to: readonly unknown[]): unknown[] {
  const present = new Set(to.map(tag));
  return from.filter((value) => !present.has(tag(value)));
}

/** Elements of `to` that `from` did not contain, compared by value. */
function added(from: readonly unknown[], to: readonly unknown[]): unknown[] {
  const before = new Set(from.map(tag));
  return to.filter((value) => !before.has(tag(value)));
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
export function deriveEntries(
  base: DemoState,
  head: DemoState,
): ChangeEntry[] {
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
          for (const item of added(a, b)) {
            push({
              field: `${label(id)} ${words(field)} added`,
              before: null,
              after: describe(item),
            });
          }
          // Reported, not implied. A preview that shows only additions lets a
          // human approve a change that also erases something.
          for (const item of removed(a, b)) {
            push({
              field: `${label(id)} ${words(field)} removed`,
              before: describe(item),
              after: null,
            });
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

/**
 * How one array field merges.
 *
 * Union is correct only when neither side removed anything, which is the
 * concurrent-notes case the demo depends on. Any removal is a replacement of
 * the whole field, so it lands when the other side left the field alone and
 * conflicts when both moved it. Treating every array as append-only silently
 * resurrects the values a capability meant to erase.
 */
function mergeArray(
  base: readonly unknown[],
  human: readonly unknown[],
  agent: readonly unknown[],
): { kind: "value"; value: unknown[] } | { kind: "conflict" } {
  if (same(agent, base)) {
    return { kind: "value", value: [...human] };
  }
  if (same(human, base)) {
    return { kind: "value", value: [...agent] };
  }
  if (removed(base, agent).length > 0 || removed(base, human).length > 0) {
    return { kind: "conflict" };
  }
  const known = new Set([...base, ...human].map(tag));
  return {
    kind: "value",
    value: [...human, ...agent.filter((value) => !known.has(tag(value)))],
  };
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
    if (same(a, b)) {
      continue;
    }
    if (Array.isArray(a) && Array.isArray(b) && Array.isArray(h)) {
      const merged = mergeArray(b, h, a);
      if (merged.kind === "conflict") {
        report(field, h, a);
      } else {
        out[field] = merged.value;
      }
      continue;
    }
    if (!same(h, b)) {
      report(field, h, a);
      continue;
    }
    out[field] = a;
  }
  // A field the agent dropped from the row entirely is a removal like any
  // other, and iterating only the agent's keys would keep the human's copy.
  for (const field of Object.keys(base)) {
    if (field in agent || !(field in human)) {
      continue;
    }
    if (same(human[field], base[field])) {
      delete out[field];
    } else {
      report(field, human[field], undefined);
    }
  }
  return out;
}

/**
 * Three-way merge of an agent branch into the human's working copy.
 *
 * Row presence is decided explicitly for every combination of base, human,
 * and agent. A row the agent deleted is deleted, unless the human changed it
 * meanwhile, which is a delete-versus-modify conflict rather than a winner.
 * A field the agent wrote lands. A field only the human moved is preserved.
 * A field both moved comes back as a conflict.
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
    const report = (id: string) => (field: string, h: unknown, a: unknown) => {
      conflicts.push({ collection, key: id, field, human: h, agent: a });
    };

    for (const row of humanRows) {
      const id = String(row[key]);
      const baseRow = baseRows.get(id);
      const agentRow = agentRows.get(id);

      if (agentRow) {
        merged.push(mergeRow(baseRow ?? {}, row, agentRow, report(id)));
        continue;
      }
      if (!baseRow) {
        // The human created it inside the branch's lifetime. The agent never
        // saw it, so its absence says nothing.
        merged.push(row);
        continue;
      }
      if (same(row, baseRow)) {
        // Deleted by the agent, untouched by the human. The deletion lands.
        continue;
      }
      // Deleted by one side and modified by the other. Neither is obviously
      // right, so the row stays and the collision is reported.
      conflicts.push({
        collection,
        key: id,
        field: "(row)",
        human: "modified",
        agent: "deleted",
      });
      merged.push(row);
    }

    const present = new Set(humanRows.map((row) => String(row[key])));
    for (const row of rows(branch.head, collection)) {
      const id = String(row[key]);
      if (present.has(id)) {
        continue;
      }
      if (baseRows.has(id)) {
        // The human deleted a row the agent still holds. The human is the
        // authority, so the deletion stands and the agent's edit is reported
        // only if it actually changed something.
        if (!same(row, baseRows.get(id))) {
          conflicts.push({
            collection,
            key: id,
            field: "(row)",
            human: "deleted",
            agent: "modified",
          });
        }
        continue;
      }
      merged.push(row);
    }
    state[collection] = merged;
  }

  return { state: state as unknown as DemoState, conflicts };
}
