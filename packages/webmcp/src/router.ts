import type { AppContext, Capability } from "./capability.ts";
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
  return ranked.slice(0, Math.min(limit, MAX_ROUTED));
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
 * The seam an embedding model plugs into later.
 *
 * It may be async, so a scorer that calls out to a service needs no change
 * to this contract when it arrives. It receives candidates that have already
 * passed availability and policy filtering, so a scorer cannot resurrect
 * something the runtime declined to offer.
 */
export type CapabilityScorer = (
  candidates: readonly Capability[],
  request: RoutingRequest,
) => readonly ScoredCapability[] | Promise<readonly ScoredCapability[]>;

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

export type RoutingResult =
  | {
      ok: true;
      /** What actually ran, which is not always what was asked for. */
      strategy: RoutingStrategyKind;
      /** True only when a custom scorer supplied the ordering. */
      scoredExternally: boolean;
      /** Set when a requested strategy could not run and this one replaced it. */
      degradedFrom?: RoutingStrategyKind;
      degradedBecause?: string;
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
  const limit = request.limit ?? DEFAULT_ROUTED;
  const budget = Math.min(limit, MAX_ROUTED);
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
  return rankCapabilities(pool, request.context, request.query, MAX_ROUTED).map(
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

async function runScorer(
  scorer: CapabilityScorer,
  pool: readonly Capability[],
  request: RoutingRequest,
): Promise<
  { ok: true; matches: readonly ScoredCapability[] } | { ok: false; reason: string }
> {
  let raw: unknown;
  try {
    raw = await scorer(pool, request);
  } catch (err) {
    return {
      ok: false,
      reason: `the custom scorer threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "the custom scorer did not return an array" };
  }
  const known = new Set(pool.map((c) => c.name as string));
  const matches: ScoredCapability[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as ScoredCapability).score !== "number" ||
      !Number.isFinite((entry as ScoredCapability).score)
    ) {
      return { ok: false, reason: "the custom scorer returned an entry with no finite score" };
    }
    const scored = entry as ScoredCapability;
    // A scorer cannot widen the surface. Returning something the eligibility
    // filter already removed would route past availability and policy.
    if (!scored.capability || !known.has(scored.capability.name)) {
      return {
        ok: false,
        reason: "the custom scorer returned a capability that was not offered to it",
      };
    }
    matches.push({
      capability: scored.capability,
      score: scored.score,
      reasons: scored.reasons ?? ["custom"],
    });
  }
  return { ok: true, matches };
}

/** Score descending, then name, so equal scores never reorder between runs. */
function order(matches: readonly ScoredCapability[]): ScoredCapability[] {
  return [...matches].sort(
    (a, b) =>
      b.score - a.score || a.capability.name.localeCompare(b.capability.name),
  );
}
