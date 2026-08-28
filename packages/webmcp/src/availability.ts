import type { AppContext, Availability, Capability } from "./capability.ts";
import type { CapabilityCatalog } from "./catalog.ts";

export function availableCapabilities(
  catalog: CapabilityCatalog,
  ctx: AppContext,
): Capability[] {
  return catalog.all().filter((capability) => capability.availability(ctx).available);
}

export function isAvailable(
  catalog: CapabilityCatalog,
  name: string,
  ctx: AppContext,
): boolean {
  const capability = catalog.get(name);
  return capability !== undefined && capability.availability(ctx).available;
}

export function evaluateAvailability(
  capability: Capability,
  ctx: AppContext,
): Availability {
  return capability.availability(ctx);
}
