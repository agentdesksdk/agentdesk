import type { AppContext, Capability } from "./capability.ts";
import {
  compareNames,
  ROUTING_WEIGHTS,
  tokenize,
  type CapabilityScorer,
  type RoutingRequestSnapshot,
  type ScoredDescriptor,
} from "./router.ts";

/** A subdomain in the tree: its name and how many routable capabilities it holds. */
export type CatalogSubdomain = { name: string; capabilities: number };

/** A domain in the tree, described from its members' vocabulary. */
export type CatalogDomain = {
  name: string;
  description: string;
  capabilities: number;
  /** Present only when at least one member declares a subdomain of its own. */
  subdomains?: CatalogSubdomain[];
};

export type CatalogTree = { domains: CatalogDomain[]; total: number };

/** What the tree needs of a capability; both a `Capability` and a `RoutingDescriptor` have it. */
export type HierarchyMember = {
  readonly name: string;
  readonly domain?: string;
  readonly subdomain?: string;
  readonly description: string;
  readonly title?: string;
  readonly risk?: string;
  readonly intents: readonly string[];
  readonly keywords: readonly string[];
  readonly entities?: readonly string[];
  readonly routes?: readonly string[];
};

export type CatalogHierarchy<M extends HierarchyMember = Capability> = {
  /** The tree over the members `routable` admits, cached until that set changes. */
  view: (routable: (member: M) => boolean) => CatalogTree;
  /** The members under a domain, or under `domain/subdomain`; undefined for a name the tree lacks. */
  within: (path: string, routable: (member: M) => boolean) => M[] | undefined;
  /**
   * The domains a query points at, best first, over the admitted members.
   * Empty when no token of the query is in any domain's vocabulary.
   */
  rankDomains: (
    query: string,
    routable: (member: M) => boolean,
    contextDomain?: string,
  ) => Array<{ domain: string; score: number }>;
  /** The members `rankWithin` should consider for a query, with their query tokens folded to the catalog's vocabulary. */
  fold: (query: string, routable: (member: M) => boolean) => Set<string>;
};

/** Where a capability with no domain lives in the tree. */
export const UNCATEGORIZED = "uncategorized";

/** How many vocabulary terms describe a domain. */
const DESCRIPTION_TERMS = 6;

/**
 * Words a query shares with every description. Kept short and explicit;
 * anything not listed is treated as content, because a list that grows to
 * fit the phrasings it sees is a scorer tuned to its tasks.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "on", "in", "at", "by", "with", "from",
  "is", "are", "was", "be", "it", "that", "this", "we", "you", "i", "her", "she", "he", "him",
  "they", "them", "can", "could", "please", "up", "out", "our", "its", "his", "my", "your",
]);

/** The overlap bump per shared content token, and its cap: never as much as one keyword hit. */
const OVERLAP_WEIGHT = 0.05;
const OVERLAP_CAP = 8;

/**
 * A second domain is kept when it scores at least this share of the first.
 * At 1 only an exact tie keeps one: the shipped step is single-domain, as
 * the two-call flow is, where a client chooses one domain. The first
 * measurement kept a near tie at 0.75 and it traded three tasks for one;
 * the second held-out set showed it earning nothing net.
 */
export const NEAR_TIE = 1;

type Node<M extends HierarchyMember> = {
  member: M;
  domain: string;
  subdomain: string;
  /** Name parts, keywords, and intent words: what the domain step reads. */
  vocab: ReadonlySet<string>;
  /** Content words of the title, name, and description: what breaks a tie. */
  text: ReadonlySet<string>;
};

const content = (text: string): string[] =>
  tokenize(text).filter((token) => !FUNCTION_WORDS.has(token) && !/^\d+$/.test(token));

function node<M extends HierarchyMember>(member: M): Node<M> {
  const domain = member.domain ?? UNCATEGORIZED;
  // The domain's own name is vocabulary like any other term, weighted by
  // how many capabilities carry it, so a domain that shares its name with
  // an everyday noun is not handed a bonus for the noun.
  const vocab = new Set<string>(tokenize(domain));
  for (const part of member.name.split("_")) {
    vocab.add(part.toLowerCase());
  }
  for (const keyword of member.keywords) {
    for (const token of tokenize(keyword)) {
      vocab.add(token);
    }
  }
  for (const intent of member.intents) {
    for (const token of tokenize(intent)) {
      vocab.add(token);
    }
  }
  const text = new Set<string>([
    ...content(member.name.replaceAll("_", " ")),
    ...content(member.title ?? ""),
    ...content(member.description),
  ]);
  return { member, domain, subdomain: member.subdomain ?? domain, vocab, text };
}

/**
 * A token folded to the catalog's vocabulary: the query says "charged" and
 * the catalog says "charge", "invoicing" and "invoice", "deliveries" and
 * "delivery". Only a form the vocabulary actually contains is accepted,
 * so nothing is invented.
 */
function fold(token: string, vocab: ReadonlySet<string>): string {
  if (vocab.has(token)) {
    return token;
  }
  const candidates: string[] = [];
  if (token.endsWith("ies")) {
    candidates.push(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("es")) {
    candidates.push(token.slice(0, -2));
  }
  if (token.endsWith("s")) {
    candidates.push(token.slice(0, -1));
  }
  if (token.endsWith("ed")) {
    candidates.push(token.slice(0, -2), `${token.slice(0, -2)}e`, token.slice(0, -1));
  }
  if (token.endsWith("ing")) {
    candidates.push(token.slice(0, -3), `${token.slice(0, -3)}e`);
  }
  return candidates.find((candidate) => candidate.length > 1 && vocab.has(candidate)) ?? token;
}

/**
 * The catalog as a tree, derived once from the members and answered per
 * call over the ones policy admits.
 *
 * Tokenizing is done here, once; what a call pays is the routable filter
 * and a count, which cannot be cached because policy is a function of the
 * moment. The tree itself is cached by the admitted set, so two calls that
 * admit the same members share one object.
 */
export function catalogHierarchy<M extends HierarchyMember>(members: readonly M[]): CatalogHierarchy<M> {
  const nodes = members.map(node).sort(
    (a, b) =>
      compareNames(a.domain, b.domain) ||
      compareNames(a.subdomain, b.subdomain) ||
      compareNames(a.member.name, b.member.name),
  );
  let cached: { key: string; tree: CatalogTree } | undefined;

  const admitted = (routable: (member: M) => boolean): Node<M>[] =>
    nodes.filter((n) => routable(n.member));

  const build = (live: Node<M>[]): CatalogTree => {
    const totals = new Map<string, number>();
    for (const n of live) {
      for (const term of n.vocab) {
        totals.set(term, (totals.get(term) ?? 0) + 1);
      }
    }
    const domains: CatalogDomain[] = [];
    for (const name of [...new Set(live.map((n) => n.domain))]) {
      const own = live.filter((n) => n.domain === name);
      const counts = new Map<string, number>();
      for (const n of own) {
        for (const term of n.member.keywords.flatMap((k) => tokenize(k))) {
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
      // Terms concentrated in this domain describe it; "add" and "view",
      // shared by every domain, describe none of them.
      const terms = [...counts.entries()]
        .map(([term, count]) => ({ term, weight: (count * count) / (totals.get(term) ?? count) }))
        .sort((a, b) => b.weight - a.weight || compareNames(a.term, b.term))
        .slice(0, DESCRIPTION_TERMS)
        .map((entry) => entry.term);
      const subdomainNames = [...new Set(own.map((n) => n.subdomain))];
      const domain: CatalogDomain = {
        name,
        description: terms.join(", "),
        capabilities: own.length,
      };
      if (subdomainNames.length > 1) {
        domain.subdomains = subdomainNames.map((sub) => ({
          name: sub,
          capabilities: own.filter((n) => n.subdomain === sub).length,
        }));
      }
      domains.push(domain);
    }
    return { domains, total: live.length };
  };

  const vocabularyOf = (live: Node<M>[]): ReadonlySet<string> => {
    const all = new Set<string>();
    for (const n of live) {
      for (const term of n.vocab) {
        all.add(term);
      }
    }
    return all;
  };

  return {
    view: (routable) => {
      const live = admitted(routable);
      const key = live.map((n) => n.member.name).join("\n");
      if (cached?.key === key) {
        return cached.tree;
      }
      const tree = build(live);
      cached = { key, tree };
      return tree;
    },

    within: (path, routable) => {
      const [domain, subdomain, ...rest] = path.split("/");
      if (domain === undefined || domain === "" || rest.length > 0) {
        return undefined;
      }
      const own = admitted(routable).filter(
        (n) => n.domain === domain && (subdomain === undefined || n.subdomain === subdomain),
      );
      return own.length === 0 ? undefined : own.map((n) => n.member);
    },

    rankDomains: (query, routable, contextDomain) => {
      const live = admitted(routable);
      const vocabulary = vocabularyOf(live);
      const frequency = new Map<string, number>();
      for (const n of live) {
        for (const term of n.vocab) {
          frequency.set(term, (frequency.get(term) ?? 0) + 1);
        }
      }
      const tokens = new Set(content(query).map((token) => fold(token, vocabulary)));
      // A term borne by many capabilities is weak evidence for any of them;
      // one borne by few is what a person meant.
      const weight = (term: string): number => Math.log(1 + live.length / (frequency.get(term) ?? live.length));
      const scores = new Map<string, number>();
      for (const name of new Set(live.map((n) => n.domain))) {
        const own = live.filter((n) => n.domain === name);
        const terms = new Set(own.flatMap((n) => [...n.vocab]));
        let score = 0;
        for (const token of tokens) {
          if (terms.has(token)) {
            score += weight(token);
          }
        }
        if (contextDomain === name && score > 0) {
          score += 1;
        }
        if (score > 0) {
          scores.set(name, score);
        }
      }
      return [...scores.entries()]
        .map(([domain, score]) => ({ domain, score }))
        .sort((a, b) => b.score - a.score || compareNames(a.domain, b.domain));
    },

    fold: (query, routable) => {
      const vocabulary = vocabularyOf(admitted(routable));
      return new Set(content(query).map((token) => fold(token, vocabulary)));
    },
  };
}

/** What the deterministic scorer reads of a request, from either a context or a snapshot. */
export type RoutingView = {
  readonly tokens: ReadonlySet<string>;
  readonly route: string;
  readonly domain?: string;
  readonly contextKeys: ReadonlySet<string>;
};

export function viewOf(query: string, context: AppContext): RoutingView {
  const state = context.state;
  const view: { -readonly [K in keyof RoutingView]: RoutingView[K] } = {
    tokens: new Set(tokenize(query)),
    route: context.route,
    contextKeys: new Set(Object.keys(state).filter((key) => state[key] !== undefined && state[key] !== null)),
  };
  if (typeof state.domain === "string") {
    view.domain = state.domain;
  }
  return view;
}

function viewOfSnapshot(snapshot: RoutingRequestSnapshot): RoutingView {
  const view: { -readonly [K in keyof RoutingView]: RoutingView[K] } = {
    tokens: new Set(tokenize(snapshot.query)),
    route: snapshot.route,
    contextKeys: new Set(snapshot.contextKeys),
  };
  if (snapshot.domain !== undefined) {
    view.domain = snapshot.domain;
  }
  return view;
}

/** Light plural folding, the router's own; not a stemmer. */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function routeMatches(currentRoute: string, prefix: string): boolean {
  return prefix === "/" ? currentRoute === "/" : currentRoute.startsWith(prefix);
}

/**
 * The deterministic score, weight for weight what `rankCapabilities`
 * gives, computed from the fields a descriptor carries so the same number
 * comes out whether a `Capability` or a `RoutingDescriptor` is scored.
 */
export function baseScore(member: HierarchyMember, view: RoutingView): number {
  const { tokens } = view;
  let score = 0;
  if (
    tokens.size > 0 &&
    member.intents.some((intent) => tokenize(intent).every((word) => tokens.has(word)))
  ) {
    score += ROUTING_WEIGHTS.intent;
  }
  if (member.domain !== undefined) {
    const domainToken = stem(member.domain.toLowerCase());
    if (tokens.has(domainToken) || view.domain === member.domain) {
      score += ROUTING_WEIGHTS.domain;
    }
  }
  if ((member.entities ?? []).some((key) => view.contextKeys.has(key))) {
    score += ROUTING_WEIGHTS.entity;
  }
  const keywordHits = member.keywords.filter((keyword) => tokens.has(stem(keyword.toLowerCase()))).length;
  if (keywordHits > 0) {
    score += ROUTING_WEIGHTS.keyword * Math.min(keywordHits, 2);
  }
  if ((member.routes ?? []).some((prefix) => routeMatches(view.route, prefix))) {
    score += ROUTING_WEIGHTS.route;
  }
  return score;
}

export type RankedMember<M extends HierarchyMember> = { member: M; score: number };

/**
 * Keep the domain choices of distinct task clauses separate. A multi-step
 * request such as "find the order. refund its shipping" needs both branches;
 * scoring the whole paragraph as one bag of words lets the repeated shipping
 * terms erase the first step. `then` is the only word boundary here because
 * splitting ordinary "and" phrases would turn one object name into two tasks.
 */
function taskClauses(query: string): string[] {
  const clauses = query
    .split(/[!?;]+|\.(?=\s|$)|\bthen\b/iu)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
  return clauses.length === 0 ? [query] : clauses;
}

function inferredDomains<M extends HierarchyMember>(
  hierarchy: CatalogHierarchy<M>,
  query: string,
  routable: (member: M) => boolean,
  contextDomain?: string,
  nearTie = NEAR_TIE,
): string[] {
  const chosen = new Set<string>();
  for (const clause of taskClauses(query)) {
    const ranked = hierarchy.rankDomains(clause, routable, contextDomain);
    const top = ranked[0];
    if (top === undefined) {
      continue;
    }
    for (const [index, entry] of ranked.entries()) {
      if (index === 0 || (index === 1 && entry.score >= nearTie * top.score)) {
        chosen.add(entry.domain);
      }
    }
  }
  return [...chosen];
}

/**
 * Chooses the domains each task clause implies, then ranks inside their
 * union. A single-clause request retains the original one-domain behavior.
 *
 * The caller supplies the hierarchy so a long-lived runtime can reuse its
 * cached vocabulary. When no domain is implied, this is exactly the flat
 * deterministic score over the admitted members. The function does not
 * apply a tool budget; the surface that publishes the result owns that.
 */
export function rankHierarchically<M extends HierarchyMember>(
  members: readonly M[],
  hierarchy: CatalogHierarchy<M>,
  query: string,
  view: RoutingView,
  routable: (member: M) => boolean,
  options: { nearTie?: number } = {},
): RankedMember<M>[] {
  const nearTie = options.nearTie ?? NEAR_TIE;
  if (!(typeof nearTie === "number" && nearTie > 0 && nearTie <= 1)) {
    throw new RangeError(`nearTie is a share of the top domain's score in (0, 1], not ${String(nearTie)}`);
  }
  const domains = inferredDomains(hierarchy, query, routable, view.domain, nearTie);
  if (domains.length === 0) {
    return members
      .filter(routable)
      .map((member) => ({ member, score: baseScore(member, view) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || compareNames(a.member.name, b.member.name));
  }
  const narrowed = domains.flatMap((domain) => hierarchy.within(domain, routable) ?? []);
  return rankWithin(narrowed, view, hierarchy.fold(query, routable));
}

/**
 * Ranks members inside a chosen domain: the deterministic score, then a
 * small bump for every content word the query shares with the member's
 * title, name, or description. The bump is capped below one keyword hit,
 * so it never outranks a signal the deterministic scorer found; it decides
 * among members that scorer could not tell apart, which inside one domain
 * is most of them. A member the deterministic scorer gave nothing can rank
 * on the bump alone, because the domain step already established that the
 * query is about this domain.
 */
export function rankWithin<M extends HierarchyMember>(
  members: readonly M[],
  view: RoutingView,
  folded: ReadonlySet<string>,
): RankedMember<M>[] {
  const ranked: RankedMember<M>[] = [];
  for (const member of members) {
    const text = node(member).text;
    let shared = 0;
    for (const token of folded) {
      if (text.has(token)) {
        shared += 1;
      }
    }
    const score = baseScore(member, view) + OVERLAP_WEIGHT * Math.min(shared, OVERLAP_CAP);
    if (score > 0) {
      ranked.push({ member, score });
    }
  }
  return ranked.sort((a, b) => b.score - a.score || compareNames(a.member.name, b.member.name));
}

/**
 * The domain step as a `CapabilityScorer`, so the routing stress evaluation
 * can run it through `routeTask` without a client choosing the domain: the
 * query's decisive tokens choose one, a second is kept when it nearly ties,
 * and the deterministic scorer runs inside. No domain implied means the
 * deterministic ranking over everything, exactly as the single call gives.
 */
export function hierarchicalScorerWith(options: { nearTie?: number } = {}): CapabilityScorer {
  const nearTie = options.nearTie ?? NEAR_TIE;
  if (!(typeof nearTie === "number" && nearTie > 0 && nearTie <= 1)) {
    throw new RangeError(`nearTie is a share of the top domain's score in (0, 1], not ${String(nearTie)}`);
  }
  return (candidates, request) => {
    const hierarchy = catalogHierarchy(candidates);
    const all = () => true;
    const view = viewOfSnapshot(request);
    const domains = inferredDomains(hierarchy, request.query, all, request.domain, nearTie);
    return rankHierarchically(candidates, hierarchy, request.query, view, all, { nearTie }).map(
      ({ member, score }): ScoredDescriptor => ({
        name: member.name,
        score,
        reasons:
          domains.length === 0
            ? ["deterministic"]
            : [`domain ${member.domain ?? UNCATEGORIZED}`, "deterministic within domain"],
      }),
    );
  };
}

/** The shipped domain step: `hierarchicalScorerWith` at `NEAR_TIE`. */
export const hierarchicalScorer: CapabilityScorer = hierarchicalScorerWith();
