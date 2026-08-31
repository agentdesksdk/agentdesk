import type {
  AppContext,
  Capability,
  NormalizedRelationships,
  RiskLevel,
} from "./capability.ts";
import type { CapabilityCatalog } from "./catalog.ts";

export type RouteError = {
  kind: "unknown_capability";
  name: string;
};

export function routeCapability(
  catalog: CapabilityCatalog,
  name: string,
): Capability | RouteError {
  const capability = catalog.get(name);
  if (!capability) {
    return { kind: "unknown_capability", name };
  }
  return capability;
}

export function isRouteError(
  value: Capability | RouteError,
): value is RouteError {
  return "kind" in value && value.kind === "unknown_capability";
}

export type RankedCapability = {
  capability: Capability;
  score: number;
};

export const ROUTING_WEIGHTS = {
  intent: 5,
  domain: 4,
  entity: 3,
  keyword: 2,
  route: 1,
} as const;

export const MAX_ROUTED = 6;
export const DEFAULT_ROUTED = 5;

/**
 * Deterministic context-aware scoring. No embeddings. A capability is
 * relevant when the task phrasing matches its intents/keywords, or the
 * current application context (route, domain, focused entities) points
 * at it. Zero-score capabilities are never routed.
 */
export function rankCapabilities(
  capabilities: readonly Capability[],
  ctx: AppContext,
  query: string,
  limit: number = DEFAULT_ROUTED,
): RankedCapability[] {
  return scoreAll(capabilities, ctx, query).slice(
    0,
    Math.min(limit, MAX_ROUTED),
  );
}

/**
 * The scoring pass without the budget applied.
 *
 * Hybrid routing needs this. Trimming to six before relationship and session
 * bonuses are added throws away the base score of a capability ranked
 * seventh, so its bonus would start from zero and it would rank below
 * capabilities it should beat.
 */
function scoreAll(
  capabilities: readonly Capability[],
  ctx: AppContext,
  query: string,
): RankedCapability[] {
  const tokens = new Set(tokenize(query));
  const contextDomain =
    typeof ctx.state.domain === "string" ? ctx.state.domain : undefined;

  const ranked: RankedCapability[] = [];
  for (const capability of capabilities) {
    let score = 0;
    if (
      tokens.size > 0 &&
      capability.intents.some((intent) =>
        tokenize(intent).every((word) => tokens.has(word)),
      )
    ) {
      score += ROUTING_WEIGHTS.intent;
    }
    if (capability.domain !== undefined) {
      const domainToken = stem(capability.domain.toLowerCase());
      if (tokens.has(domainToken) || contextDomain === capability.domain) {
        score += ROUTING_WEIGHTS.domain;
      }
    }
    if (
      capability.entities.some(
        (key) => ctx.state[key] !== undefined && ctx.state[key] !== null,
      )
    ) {
      score += ROUTING_WEIGHTS.entity;
    }
    const keywordHits = capability.keywords.filter((keyword) =>
      tokens.has(stem(keyword.toLowerCase())),
    ).length;
    if (keywordHits > 0) {
      score += ROUTING_WEIGHTS.keyword * Math.min(keywordHits, 2);
    }
    if (capability.routes.some((prefix) => routeMatches(ctx.route, prefix))) {
      score += ROUTING_WEIGHTS.route;
    }
    if (score > 0) {
      ranked.push({ capability, score });
    }
  }

  ranked.sort(
    (a, b) =>
      b.score - a.score || a.capability.name.localeCompare(b.capability.name),
  );
  return ranked;
}

/** "/" is the exact root route, not a universal prefix. */
function routeMatches(currentRoute: string, prefix: string): boolean {
  if (prefix === "/") {
    return currentRoute === "/";
  }
  return currentRoute.startsWith(prefix);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .map(stem);
}

/** Light plural folding so "orders" matches "order". Not a stemmer. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

/**
 * Router V2.
 *
 * `rankCapabilities` above is unchanged and remains the default. Everything
 * below is opt-in, so a caller that asks for nothing keeps the deterministic
 * behaviour it had, byte for byte.
 */

export type RoutingStrategyKind = "deterministic" | "hybrid" | "custom";

/** What a scorer is given. Everything it may read, and nothing it may write. */
export type RoutingRequest = {
  query: string;
  context: AppContext;
  /**
   * Capability names already routed or invoked in this conversation, oldest
   * first. Hybrid uses it to prefer the next step of work in progress.
   */
  session?: readonly string[];
  limit?: number;
};

export type ScoredCapability = {
  capability: Capability;
  score: number;
  /** Why it scored, in the order the contributions were applied. */
  reasons: readonly string[];
};

/**
 * What a scorer is allowed to see: everything routing decides on, and none
 * of the functions that do anything.
 *
 * Handing over a `Capability` gave a scorer a live `execute`, `availability`,
 * and `verify`. Freezing the array around them fixed nothing, because the
 * objects inside it were the real ones. A descriptor has no handler to
 * replace and none to call.
 */
export type RoutingDescriptor = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly domain?: string;
  readonly risk: RiskLevel;
  readonly intents: readonly string[];
  readonly keywords: readonly string[];
  readonly entities: readonly string[];
  readonly routes: readonly string[];
  readonly relationships: NormalizedRelationships;
};

/** What a scorer returns: an identifier and a number, nothing to forge. */
export type ScoredDescriptor = {
  name: string;
  score: number;
  reasons?: readonly string[];
};

/**
 * The seam an embedding model plugs into later.
 *
 * It may be async, so a scorer that calls out to a service needs no change
 * to this contract when it arrives. It receives descriptors for candidates
 * that already passed availability and policy filtering, and it answers with
 * names, so it can neither resurrect something the runtime declined to offer
 * nor substitute the object that would run.
 */
export type CapabilityScorer = (
  candidates: readonly RoutingDescriptor[],
  request: RoutingRequest,
) => readonly ScoredDescriptor[] | Promise<readonly ScoredDescriptor[]>;

export type RoutingStrategy =
  | { kind: "deterministic" }
  | { kind: "hybrid" }
  | {
      kind: "custom";
      scorer: CapabilityScorer;
      /**
       * What to do when the scorer throws or returns something unusable.
       * `deterministic` degrades to the built-in scorer, `refuse` returns a
       * structured failure. There is no third option where a broken scorer
       * silently returns nothing, because an empty result and a failed
       * scorer are different facts.
       */
      onFailure?: "deterministic" | "refuse";
    };

/**
 * Four outcomes, spelled out, because the combinations that cannot happen
 * should not be constructible. A custom result is externally scored by
 * definition, a built-in result never is, and only a degraded result carries
 * the reason it degraded.
 */
export type RoutingResult =
  | {
      ok: true;
      strategy: "custom";
      scoredExternally: true;
      matches: readonly ScoredCapability[];
    }
  | {
      ok: true;
      strategy: "deterministic" | "hybrid";
      scoredExternally: false;
      matches: readonly ScoredCapability[];
    }
  | {
      ok: true;
      strategy: "deterministic";
      scoredExternally: false;
      /** The strategy that was asked for and could not run. */
      degradedFrom: "custom";
      degradedBecause: string;
      matches: readonly ScoredCapability[];
    }
  | { ok: false; strategy: "custom"; reason: string };

export const RELATION_WEIGHTS = {
  /** A verbatim capability name or title in the query. */
  exactTerm: 6,
  /** Pulled in because a higher-scoring match names it in `requires`. */
  requires: 3,
  /** Pulled in because a higher-scoring match names it in `related`. */
  related: 1,
  /** Already touched in this conversation. */
  session: 2,
} as const;

/**
 * The V2 entry point. Deterministic unless a caller asks for more.
 *
 * `eligible` is how availability and policy filtering happens ahead of
 * ranking. The router does not import either, because a pure scorer that
 * cannot read application state is far easier to reason about than one that
 * can, so the runtime passes a predicate instead.
 */
export async function routeTask(
  candidates: readonly Capability[],
  request: RoutingRequest,
  strategy: RoutingStrategy = { kind: "deterministic" },
  eligible: (capability: Capability) => boolean = () => true,
): Promise<RoutingResult> {
  const budget = clampBudget(request.limit);
  // Filtered into an array the caller never handed us, and handed to a
  // scorer as a frozen copy, so nothing downstream can widen the pool the
  // fallback path later scores.
  const pool = candidates.filter(eligible);

  if (strategy.kind === "custom") {
    const scored = await runScorer(strategy.scorer, pool, request);
    if (scored.ok) {
      return {
        ok: true,
        strategy: "custom",
        scoredExternally: true,
        matches: order(scored.matches).slice(0, budget),
      };
    }
    if (strategy.onFailure === "refuse") {
      return { ok: false, strategy: "custom", reason: scored.reason };
    }
    return {
      ok: true,
      strategy: "deterministic",
      scoredExternally: false,
      degradedFrom: "custom",
      degradedBecause: scored.reason,
      matches: deterministic(pool, request).slice(0, budget),
    };
  }

  const base = deterministic(pool, request);
  if (strategy.kind === "deterministic") {
    return {
      ok: true,
      strategy: "deterministic",
      scoredExternally: false,
      matches: base.slice(0, budget),
    };
  }
  return {
    ok: true,
    strategy: "hybrid",
    scoredExternally: false,
    matches: hybrid(base, pool, request).slice(0, budget),
  };
}

function deterministic(
  pool: readonly Capability[],
  request: RoutingRequest,
): ScoredCapability[] {
  return scoreAll(pool, request.context, request.query).map(
    ({ capability, score }) => ({ capability, score, reasons: ["deterministic"] }),
  );
}

/**
 * Lexical and structural, never semantic. Hybrid adds three things the
 * deterministic scorer does not see: a capability named outright in the
 * query, the graph around what already matched, and what this conversation
 * has already touched.
 */
function hybrid(
  base: readonly ScoredCapability[],
  pool: readonly Capability[],
  request: RoutingRequest,
): ScoredCapability[] {
  const tokens = new Set(tokenize(request.query));
  const session = new Set(request.session ?? []);
  const byName = new Map(pool.map((c) => [c.name as string, c]));
  const scored = new Map<string, ScoredCapability>();

  const add = (capability: Capability, points: number, reason: string) => {
    const existing = scored.get(capability.name);
    if (existing) {
      scored.set(capability.name, {
        capability,
        score: existing.score + points,
        reasons: [...existing.reasons, reason],
      });
      return;
    }
    scored.set(capability.name, { capability, score: points, reasons: [reason] });
  };

  for (const match of base) {
    add(match.capability, match.score, "deterministic");
  }
  for (const capability of pool) {
    if (namedOutright(capability, tokens)) {
      add(capability, RELATION_WEIGHTS.exactTerm, "exact term");
    }
    if (session.has(capability.name)) {
      add(capability, RELATION_WEIGHTS.session, "session");
    }
  }

  // Anchors are walked in the deterministic order so the pulled set does not
  // depend on Map insertion order. One hop only: a prerequisite of a
  // prerequisite is a catalog dump wearing a graph costume.
  for (const anchor of order([...scored.values()])) {
    const { requires = [], related = [] } = anchor.capability.relationships;
    for (const name of requires) {
      const target = byName.get(name);
      if (target && target.name !== anchor.capability.name) {
        add(target, RELATION_WEIGHTS.requires, `required by ${anchor.capability.name}`);
      }
    }
    for (const name of related) {
      const target = byName.get(name);
      if (target && target.name !== anchor.capability.name) {
        add(target, RELATION_WEIGHTS.related, `related to ${anchor.capability.name}`);
      }
    }
  }

  return order([...scored.values()]);
}

/** The query names the capability itself, by name or by title. */
function namedOutright(capability: Capability, tokens: ReadonlySet<string>): boolean {
  const nameWords = tokenize(capability.name);
  const titleWords = capability.title ? tokenize(capability.title) : [];
  const matches = (words: string[]) =>
    words.length > 0 && words.every((word) => tokens.has(word));
  return matches(nameWords) || matches(titleWords);
}

/**
 * A budget of six, whatever the caller passes.
 *
 * A negative limit used to reach `slice(0, -1)`, which drops one entry and
 * returns the rest, so `limit: -1` published almost the whole catalog. A
 * budget is a maximum, and every value that is not a usable maximum resolves
 * to one that is.
 */
function clampBudget(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return Math.min(DEFAULT_ROUTED, MAX_ROUTED);
  }
  return Math.max(0, Math.min(Math.floor(limit), MAX_ROUTED));
}

async function runScorer(
  scorer: CapabilityScorer,
  pool: readonly Capability[],
  request: RoutingRequest,
): Promise<
  { ok: true; matches: readonly ScoredCapability[] } | { ok: false; reason: string }
> {
  const offered = new Map(pool.map((c) => [c.name as string, c]));
  // The call and the parse share one guard. Reading `.score` can invoke a
  // getter, and a getter that throws outside the guard escapes as a raw
  // rejection from a method whose type promises a structured refusal.
  try {
    const raw = await scorer(pool.map(describe), Object.freeze({ ...request }));
    if (!Array.isArray(raw)) {
      return { ok: false, reason: "the custom scorer did not return an array" };
    }
    const matches: ScoredCapability[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) {
        return { ok: false, reason: "the custom scorer returned an entry that is not an object" };
      }
      const { name, score, reasons } = entry as ScoredDescriptor;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        return { ok: false, reason: "the custom scorer returned an entry with no finite score" };
      }
      // Names map back to what was offered. A scorer cannot widen the surface
      // past availability and policy, and it never held the object that runs.
      const real = typeof name === "string" ? offered.get(name) : undefined;
      if (!real) {
        return {
          ok: false,
          reason: "the custom scorer returned a capability that was not offered to it",
        };
      }
      if (seen.has(name)) {
        return {
          ok: false,
          reason: `the custom scorer returned ${name} twice, and a duplicate would spend the budget on one capability`,
        };
      }
      seen.add(name);
      if (score <= 0) {
        continue;
      }
      matches.push({
        capability: real,
        score,
        reasons:
          Array.isArray(reasons) && reasons.every((r) => typeof r === "string")
            ? [...reasons]
            : ["custom"],
      });
    }
    return { ok: true, matches };
  } catch (err) {
    return {
      ok: false,
      reason: `the custom scorer threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Everything routing decides on, and nothing that does anything. */
function describe(capability: Capability): RoutingDescriptor {
  const descriptor: {
    -readonly [K in keyof RoutingDescriptor]: RoutingDescriptor[K];
  } = {
    name: capability.name,
    description: capability.description,
    risk: capability.risk,
    intents: [...capability.intents],
    keywords: [...capability.keywords],
    entities: [...capability.entities],
    routes: [...capability.routes],
    relationships: {
      requires: [...capability.relationships.requires],
      related: [...capability.relationships.related],
    },
  };
  if (capability.title !== undefined) {
    descriptor.title = capability.title;
  }
  if (capability.domain !== undefined) {
    descriptor.domain = capability.domain;
  }
  return Object.freeze(descriptor);
}

/** Score descending, then name, so equal scores never reorder between runs. */
function order(matches: readonly ScoredCapability[]): ScoredCapability[] {
  return [...matches].sort(
    (a, b) =>
      b.score - a.score || a.capability.name.localeCompare(b.capability.name),
  );
}
