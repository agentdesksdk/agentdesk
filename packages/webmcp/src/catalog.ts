import type { Capability, CapabilityName } from "./capability.ts";
import { parseCapabilityName } from "./capability.ts";

export class CapabilityCatalog {
  private readonly byName: ReadonlyMap<CapabilityName, Capability>;

  constructor(capabilities: readonly Capability[]) {
    const map = new Map<CapabilityName, Capability>();
    for (const capability of capabilities) {
      if (map.has(capability.name)) {
        throw new Error(`duplicate capability: ${capability.name}`);
      }
      map.set(capability.name, capability);
    }
    this.byName = map;
  }

  get(name: string): Capability | undefined {
    if (!name) {
      return undefined;
    }
    try {
      return this.byName.get(parseCapabilityName(name));
    } catch {
      return undefined;
    }
  }

  all(): Capability[] {
    return [...this.byName.values()];
  }
}
