import {
  defineCapability,
  type Capability,
  type CapabilitySpec,
} from "@agentdesk/webmcp";
import { stageSpec, type CommitMode } from "./staged.ts";

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
  spec: FactorySpec & { consequential?: boolean; commitMode?: CommitMode },
): Capability {
  const { consequential, commitMode, ...rest } = spec;
  if (consequential !== true) {
    return defineCapability({ ...rest, risk: "WRITE" });
  }
  return defineCapability({
    ...stageSpec(rest, commitMode),
    risk: "CONSEQUENTIAL",
  });
}

export function createReportCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, domain: spec.domain ?? "reports", risk: "READ" });
}
