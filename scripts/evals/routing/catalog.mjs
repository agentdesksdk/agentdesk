/**
 * A generated stress catalog: about four hundred capabilities across a
 * dozen domains, with vocabulary shared on purpose, because shared
 * vocabulary is what breaks a lexical scorer. Everything is derived from
 * the tables below and a seeded generator, so the same seed yields the
 * same catalog on every host, and nothing in it is hand-authored to suit
 * a task.
 *
 * The shape of each capability is what the SDK's routing reads: name,
 * title, description, domain, intents, keywords, risk, relationships. A
 * plain-data `generateCatalog` is what tests and the overlap figure use;
 * `buildRoutingCatalog` defines the same specs through the published SDK.
 */

export const DOMAINS = Object.freeze([
  "orders",
  "shipping",
  "billing",
  "invoices",
  "payments",
  "customers",
  "accounts",
  "inventory",
  "catalog",
  "returns",
  "support",
  "reports",
]);

/**
 * Verbs with a risk class, two spoken synonyms for intents, and a
 * description template. `{o}` is the object, `{os}` its plural.
 */
const VERBS = Object.freeze({
  list: { risk: "READ", syn: ["show", "browse"], describe: "List {os} matching a filter, newest first." },
  find: { risk: "READ", syn: ["look up", "search"], describe: "Find a {o} by id or by free text." },
  get: { risk: "READ", syn: ["open", "view"], describe: "Fetch one {o} with every field and its history." },
  export: { risk: "READ", syn: ["download", "pull"], describe: "Export {os} as a CSV file for the finance team." },
  create: { risk: "WRITE", syn: ["add", "raise"], describe: "Create a new {o} from the fields supplied." },
  update: { risk: "WRITE", syn: ["edit", "change"], describe: "Change fields on an existing {o}." },
  assign: { risk: "WRITE", syn: ["hand", "route"], describe: "Assign a {o} to a person or a team." },
  hold: { risk: "WRITE", syn: ["pause", "freeze"], describe: "Put a {o} on hold so nothing moves it forward." },
  release: { risk: "WRITE", syn: ["resume", "unfreeze"], describe: "Take a {o} off hold and let it proceed." },
  schedule: { risk: "WRITE", syn: ["plan", "book"], describe: "Schedule a {o} for a later time." },
  merge: { risk: "WRITE", syn: ["combine", "dedupe"], describe: "Merge two {os} into one and keep the older id." },
  reopen: { risk: "WRITE", syn: ["restore", "revive"], describe: "Reopen a {o} that was closed." },
  cancel: { risk: "CONSEQUENTIAL", syn: ["void", "call off"], describe: "Cancel a {o} that is still open. Cannot be undone." },
  delete: { risk: "CONSEQUENTIAL", syn: ["remove", "purge"], describe: "Permanently delete a {o} and everything attached to it." },
  refund: { risk: "CONSEQUENTIAL", syn: ["reimburse", "pay back"], describe: "Refund a {o} to the customer's original payment method." },
  close: { risk: "CONSEQUENTIAL", syn: ["finish", "resolve"], describe: "Close a {o} so nothing further happens on it." },
  archive: { risk: "CONSEQUENTIAL", syn: ["retire", "file away"], describe: "Archive a {o} out of the active list." },
  approve: { risk: "CONSEQUENTIAL", syn: ["accept", "sign off"], describe: "Approve a pending {o} so it takes effect." },
});

/**
 * Objects per domain, each with the verbs that make sense for it and the
 * single-word synonyms a person might use instead. The overlap is
 * deliberate: order, shipment, invoice, refund, charge, customer, account,
 * note, label, and statement each live in several domains.
 */
const OBJECTS = Object.freeze({
  orders: [
    { o: "order", syn: ["purchase", "po"], verbs: ["list", "find", "get", "create", "update", "hold", "release", "cancel", "archive", "export", "assign", "merge"] },
    { o: "order line", syn: ["item", "line"], verbs: ["list", "get", "create", "update", "delete"] },
    { o: "order note", syn: ["comment", "remark"], verbs: ["list", "get", "create", "update", "delete"] },
    { o: "backorder", syn: ["backlog"], verbs: ["list", "get", "create", "update", "release", "cancel"] },
    { o: "shipment", syn: ["parcel", "package"], verbs: ["list", "get", "create", "update", "hold", "release", "cancel"] },
    { o: "order hold", syn: ["block"], verbs: ["list", "create", "release"] },
    { o: "order export", syn: ["dump"], verbs: ["create", "schedule"] },
  ],
  shipping: [
    { o: "shipment", syn: ["parcel", "package"], verbs: ["list", "find", "get", "create", "update", "hold", "release", "cancel", "export", "assign"] },
    { o: "shipping label", syn: ["label", "sticker"], verbs: ["create", "get", "delete", "export"] },
    { o: "carrier", syn: ["courier", "forwarder"], verbs: ["list", "get", "create", "assign", "update", "archive"] },
    { o: "delivery", syn: ["dropoff", "handover"], verbs: ["list", "schedule", "get", "update", "hold", "cancel", "reopen"] },
    { o: "shipping rate", syn: ["rate", "tariff"], verbs: ["list", "get", "create", "update", "delete", "archive"] },
    { o: "tracking number", syn: ["tracking", "waybill"], verbs: ["find", "get", "create", "update"] },
    { o: "order", syn: ["purchase"], verbs: ["find", "get"] },
  ],
  billing: [
    { o: "invoice", syn: ["bill"], verbs: ["list", "find", "get", "create", "update", "approve", "cancel", "export", "archive", "hold", "release"] },
    { o: "charge", syn: ["fee", "cost"], verbs: ["list", "get", "create", "update", "approve", "refund", "delete"] },
    { o: "credit note", syn: ["credit", "memo"], verbs: ["list", "create", "get", "approve", "cancel", "export"] },
    { o: "shipping fee", syn: ["postage", "freight"], verbs: ["get", "update", "refund"] },
    { o: "billing cycle", syn: ["cycle", "period"], verbs: ["get", "update", "schedule", "close"] },
    { o: "statement", syn: ["summary"], verbs: ["list", "get", "create", "schedule", "export"] },
    { o: "refund", syn: ["reimbursement"], verbs: ["list", "get", "approve"] },
  ],
  invoices: [
    { o: "invoice", syn: ["bill"], verbs: ["list", "find", "get", "export", "archive", "reopen", "merge", "approve", "hold"] },
    { o: "invoice line", syn: ["line", "row"], verbs: ["list", "get", "create", "update", "delete"] },
    { o: "invoice pdf", syn: ["pdf", "document"], verbs: ["get", "create", "export"] },
    { o: "due date", syn: ["deadline", "terms"], verbs: ["list", "get", "update"] },
    { o: "payment terms", syn: ["terms", "net"], verbs: ["get", "update", "approve"] },
    { o: "statement", syn: ["summary"], verbs: ["create", "schedule", "archive"] },
    { o: "reminder", syn: ["nudge", "dunning"], verbs: ["list", "get", "create", "schedule", "cancel", "delete"] },
    { o: "invoice batch", syn: ["batch", "run"], verbs: ["list", "create", "get", "approve", "cancel", "export"] },
  ],
  payments: [
    { o: "payment", syn: ["transaction", "txn"], verbs: ["list", "find", "get", "create", "cancel", "refund", "export", "hold", "release", "approve"] },
    { o: "refund", syn: ["reimbursement"], verbs: ["list", "create", "get", "cancel", "approve", "export"] },
    { o: "chargeback", syn: ["dispute"], verbs: ["list", "get", "update", "approve", "close", "export"] },
    { o: "payment method", syn: ["card", "wallet"], verbs: ["list", "get", "create", "delete"] },
    { o: "payout", syn: ["settlement", "transfer"], verbs: ["list", "get", "schedule", "approve", "cancel", "export"] },
    { o: "charge", syn: ["fee"], verbs: ["find", "get", "create"] },
    { o: "receipt", syn: ["proof", "confirmation"], verbs: ["get", "export"] },
  ],
  customers: [
    { o: "customer", syn: ["client", "buyer"], verbs: ["list", "find", "get", "create", "update", "merge", "archive", "export", "hold", "release", "delete"] },
    { o: "contact", syn: ["person", "email"], verbs: ["list", "find", "get", "create", "update", "merge", "delete"] },
    { o: "address", syn: ["location", "postcode"], verbs: ["list", "find", "get", "create", "update", "delete"] },
    { o: "customer note", syn: ["comment", "remark"], verbs: ["list", "get", "create", "update", "delete"] },
    { o: "customer tag", syn: ["tag", "segment"], verbs: ["list", "create", "delete"] },
    { o: "account", syn: ["profile"], verbs: ["get", "update", "hold", "release", "close"] },
    { o: "consent", syn: ["optin", "permission"], verbs: ["get", "update"] },
  ],
  accounts: [
    { o: "account", syn: ["profile", "login"], verbs: ["list", "find", "get", "create", "update", "hold", "release", "close", "delete", "export", "assign", "merge"] },
    { o: "user", syn: ["member", "staff"], verbs: ["list", "find", "get", "create", "update", "hold", "release", "assign", "delete"] },
    { o: "role", syn: ["permission", "group"], verbs: ["list", "get", "create", "update", "assign", "delete"] },
    { o: "api key", syn: ["token", "secret"], verbs: ["list", "get", "create", "hold", "delete"] },
    { o: "session", syn: ["signin"], verbs: ["list", "find", "get", "delete"] },
    { o: "password", syn: ["credential"], verbs: ["update"] },
    { o: "invitation", syn: ["invite"], verbs: ["create", "cancel", "list"] },
  ],
  inventory: [
    { o: "stock level", syn: ["stock", "quantity", "onhand"], verbs: ["list", "find", "get", "update", "hold", "release", "export"] },
    { o: "warehouse", syn: ["depot", "site"], verbs: ["list", "find", "get", "create", "update", "close", "archive"] },
    { o: "stock transfer", syn: ["transfer", "move"], verbs: ["list", "get", "create", "schedule", "hold", "release", "approve", "cancel"] },
    { o: "reorder point", syn: ["threshold", "minimum"], verbs: ["list", "get", "create", "update"] },
    { o: "stock count", syn: ["count", "audit"], verbs: ["list", "get", "create", "schedule", "approve", "cancel", "close"] },
    { o: "shipment", syn: ["inbound", "receipt"], verbs: ["list", "get", "approve"] },
    { o: "bin", syn: ["shelf", "slot"], verbs: ["list", "get", "assign", "update"] },
  ],
  catalog: [
    { o: "product", syn: ["item", "listing"], verbs: ["list", "find", "get", "create", "update", "archive", "delete", "export", "hold", "release", "merge"] },
    { o: "variant", syn: ["option", "size"], verbs: ["list", "get", "create", "update", "archive", "delete"] },
    { o: "price", syn: ["cost", "amount"], verbs: ["list", "get", "update", "schedule", "approve"] },
    { o: "category", syn: ["collection", "department"], verbs: ["list", "get", "create", "update", "merge", "archive", "delete"] },
    { o: "product image", syn: ["photo", "picture"], verbs: ["list", "create", "delete"] },
    { o: "sku", syn: ["code", "barcode"], verbs: ["find", "get", "update"] },
    { o: "discount", syn: ["promo", "coupon"], verbs: ["list", "get", "create", "schedule", "cancel"] },
  ],
  returns: [
    { o: "return", syn: ["rma", "sendback"], verbs: ["list", "find", "get", "create", "update", "hold", "release", "export", "assign", "approve", "cancel", "close", "reopen"] },
    { o: "return label", syn: ["label"], verbs: ["list", "create", "get", "delete", "export"] },
    { o: "refund", syn: ["reimbursement"], verbs: ["list", "create", "get", "approve", "cancel"] },
    { o: "exchange", syn: ["swap", "replacement"], verbs: ["list", "create", "get", "approve", "cancel", "close"] },
    { o: "restock", syn: ["putaway"], verbs: ["list", "create", "approve", "cancel"] },
    { o: "order", syn: ["purchase"], verbs: ["find", "get", "reopen"] },
    { o: "inspection", syn: ["check", "grading"], verbs: ["list", "get", "create", "update", "approve", "close"] },
  ],
  support: [
    { o: "ticket", syn: ["case", "conversation"], verbs: ["list", "find", "get", "create", "update", "assign", "hold", "release", "merge", "close", "reopen", "export", "archive", "delete"] },
    { o: "reply", syn: ["response", "message"], verbs: ["list", "get", "create", "update", "delete"] },
    { o: "customer", syn: ["client", "requester"], verbs: ["list", "find", "get"] },
    { o: "escalation", syn: ["handoff"], verbs: ["list", "create", "get", "assign", "close", "reopen"] },
    { o: "macro", syn: ["template", "canned"], verbs: ["list", "get", "create", "update", "archive", "delete"] },
    { o: "order note", syn: ["comment"], verbs: ["create", "list"] },
    { o: "satisfaction survey", syn: ["csat", "survey"], verbs: ["get", "schedule", "cancel"] },
  ],
  reports: [
    { o: "report", syn: ["analysis", "figures"], verbs: ["list", "find", "get", "create", "update", "schedule", "export", "approve", "hold", "archive", "delete"] },
    { o: "dashboard", syn: ["overview", "board"], verbs: ["list", "get", "create", "update", "archive", "export", "delete"] },
    { o: "sales report", syn: ["revenue", "sales"], verbs: ["list", "get", "create", "schedule", "export"] },
    { o: "inventory report", syn: ["stock", "onhand"], verbs: ["list", "get", "create", "schedule", "export"] },
    { o: "invoice", syn: ["billing", "ar"], verbs: ["export"] },
    { o: "report schedule", syn: ["cadence", "cron"], verbs: ["list", "get", "create", "update", "cancel", "delete"] },
    { o: "export", syn: ["download", "file"], verbs: ["list", "get", "create", "delete"] },
    { o: "refund", syn: ["reimbursement"], verbs: ["export"] },
  ],
});

/**
 * Target size per domain; the total lands near four hundred. When a verb
 * and object repeat across domains the later name is prefixed with its
 * domain, `returns_find_order`, the way a real catalog disambiguates. A
 * preposition qualifier was tried first and measured the qualifier: name
 * tokens are keywords, so "for" in a prompt scored every `_for_return`.
 */
const PER_DOMAIN = 34;

/** Mulberry32: small, seedable, and the same on every host. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const snake = (text) => text.toLowerCase().split(/\s+/).join("_");
const plural = (o) => (o.endsWith("s") || o.endsWith("y") && !o.endsWith("ey") ? o.replace(/y$/, "ies") : `${o}s`);
const title = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const INPUTS = Object.freeze({
  list: { type: "object", properties: { filter: { type: "string" }, limit: { type: "integer" } } },
  find: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  export: { type: "object", properties: { since: { type: "string" }, format: { type: "string", enum: ["csv", "xlsx"] } } },
  create: { type: "object", properties: { fields: { type: "object" } }, required: ["fields"] },
  update: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] },
  assign: { type: "object", properties: { id: { type: "string" }, assignee: { type: "string" } }, required: ["id", "assignee"] },
  schedule: { type: "object", properties: { id: { type: "string" }, at: { type: "string" } }, required: ["id", "at"] },
  merge: { type: "object", properties: { keep_id: { type: "string" }, drop_id: { type: "string" } }, required: ["keep_id", "drop_id"] },
  refund: { type: "object", properties: { id: { type: "string" }, amount: { type: "number" }, reason: { type: "string" } }, required: ["id"] },
});
const BY_ID = Object.freeze({ type: "object", properties: { id: { type: "string" } }, required: ["id"] });

/**
 * Plain data, deterministic for the seed. Each domain contributes every
 * verb-object pair its table allows, shuffled by the seeded generator and
 * cut to PER_DOMAIN, so the catalog is a sample of a larger space and the
 * seed decides which sample.
 */
export function generateCatalog(seed = 2026) {
  const random = prng(seed);
  const taken = new Set();
  const specs = [];

  for (const domain of DOMAINS) {
    const pairs = [];
    for (const entry of OBJECTS[domain]) {
      for (const verb of entry.verbs) {
        pairs.push({ entry, verb });
      }
    }
    const chosen = shuffle(pairs, random).slice(0, PER_DOMAIN);
    // Codepoint order within the domain, the router's own comparison, so
    // the catalog's order is a property of the seed and of no host locale.
    const key = (p) => `${p.verb}_${p.entry.o}`;
    chosen.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const domainNames = [];

    for (const { entry, verb } of chosen) {
      const base = `${verb}_${snake(entry.o)}`;
      const name = taken.has(base) ? `${domain}_${base}` : base;
      taken.add(name);
      domainNames.push(name);
      const v = VERBS[verb];
      const os = plural(entry.o);
      const intents = [
        `${verb} ${entry.o}`,
        `${v.syn[0]} ${entry.o}`,
        `${v.syn[1]} ${os}`,
      ];
      const keywords = [...new Set([...entry.syn, ...v.syn.flatMap((s) => s.split(" ")), ...entry.o.split(" ")])];
      specs.push({
        name,
        title: title(`${verb} ${entry.o}`),
        description: `${v.describe.replaceAll("{os}", os).replaceAll("{o}", entry.o)} (${domain})`,
        domain,
        intents,
        keywords,
        risk: v.risk,
        inputSchema: INPUTS[verb] ?? BY_ID,
        relationships: { requires: [], related: [] },
      });
    }

    // Relationships inside the domain: a write requires the read of the
    // same object when one exists, and every capability names one sibling
    // as related, chosen by the generator.
    for (const spec of specs.filter((s) => s.domain === domain)) {
      const object = spec.name.replace(/^[a-z]+_/, "");
      const read = domainNames.find((n) => n === `get_${object}` && n !== spec.name);
      if (read !== undefined && spec.risk !== "READ") {
        spec.relationships.requires.push(read);
      }
      const siblings = domainNames.filter((n) => n !== spec.name && n !== read);
      if (siblings.length > 0) {
        spec.relationships.related.push(siblings[Math.floor(random() * siblings.length)]);
      }
    }
  }

  return { seed, domains: [...DOMAINS], specs };
}

/**
 * The same specs, defined through the published SDK. Every handler is a
 * no-op that names itself; the routing evaluation never executes one.
 */
export function buildRoutingCatalog(defineCapability, seed = 2026) {
  const generated = generateCatalog(seed);
  const capabilities = generated.specs.map((spec) =>
    defineCapability({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      domain: spec.domain,
      intents: spec.intents,
      keywords: spec.keywords,
      risk: spec.risk,
      inputSchema: spec.inputSchema,
      relationships: spec.relationships,
      ...(spec.risk === "CONSEQUENTIAL" ? { approvalEvidence: "summary" } : {}),
      execute: () => `${spec.name} ok`,
    }),
  );
  return { ...generated, capabilities };
}
