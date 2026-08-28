import {
  defineCapability,
  type Capability,
  type CapabilitySpec,
} from "@agentdesk/webmcp";

type FactorySpec = Omit<CapabilitySpec, "risk" | "policy">;

export function createSearchCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "READ" });
}

export function createReadCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "READ" });
}

export function createUpdateCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "WRITE" });
}

export function createStateTransitionCapability(
  spec: FactorySpec & { consequential?: boolean },
): Capability {
  const { consequential, ...rest } = spec;
  return defineCapability({
    ...rest,
    risk: consequential === true ? "CONSEQUENTIAL" : "WRITE",
  });
}

export function createReportCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, domain: spec.domain ?? "reports", risk: "READ" });
}
