import type { Capability } from "./capability.ts";
import type { CapabilityScorer } from "./router.ts";

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
  readonly intents: readonly string[];
  readonly keywords: readonly string[];
};

export type CatalogHierarchy<M extends HierarchyMember = Capability> = {
  /** The tree over the members `routable` admits, cached until that set changes. */
  view: (routable: (member: M) => boolean) => CatalogTree;
  /** The members under a domain, or under `domain/subdomain`; undefined for a name the tree lacks. */
  within: (path: string, routable: (member: M) => boolean) => M[] | undefined;
};

export function catalogHierarchy<M extends HierarchyMember>(members: readonly M[]): CatalogHierarchy<M> {
  void members;
  return {
    view: () => ({ domains: [], total: 0 }),
    within: () => undefined,
  };
}

export const hierarchicalScorer: CapabilityScorer = () => [];
