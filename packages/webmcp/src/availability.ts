import { unavailable } from "./capability.ts";
import type { AppContext, Availability, Capability } from "./capability.ts";
import type { CapabilityCatalog } from "./catalog.ts";

/**
 * Availability functions read application state, so they can throw when a
 * store is unreachable. One capability's failure must not take down
 * routing or a snapshot, and an unreadable capability is not a callable
 * one, so a throw is reported as unavailable rather than propagated.
 */
export function evaluateAvailability(
  capability: Capability,
  ctx: AppContext,
): Availability {
  try {
    return capability.availability(ctx);
  } catch (err) {
    return unavailable(
      "AVAILABILITY_CHECK_FAILED",
      `Could not determine whether ${capability.name} is available: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function availableCapabilities(
  catalog: CapabilityCatalog,
  ctx: AppContext,
): Capability[] {
  return catalog
    .all()
    .filter((capability) => evaluateAvailability(capability, ctx).available);
}

export function isAvailable(
  catalog: CapabilityCatalog,
  name: string,
  ctx: AppContext,
): boolean {
  const capability = catalog.get(name);
  return (
    capability !== undefined && evaluateAvailability(capability, ctx).available
  );
}
