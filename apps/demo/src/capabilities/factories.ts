import {
  defineCapability,
  type Capability,
  type CapabilitySpec,
  type DirectCapabilitySpec,
  type DistributiveOmit,
  type ExecutionContext,
} from "@agentdesksdk/webmcp";
import { registerOperation, type CommitMode } from "./staged.ts";

type FactorySpec = DistributiveOmit<CapabilitySpec, "risk" | "policy">;

/**
 * A capability that writes declares only how it writes. That handler is
 * registered with the staging adapter, and the capability names it, so the
 * declaration itself carries no executable code the runtime would have to
 * trust.
 */
type WriteSpec = Omit<
  DirectCapabilitySpec,
  "risk" | "policy" | "execute" | "previewChanges" | "approvalEvidence" | "stage"
>;

/** A staged write. Synchronous, because its fork closes when it returns. */
export type StagedExecute = (
  input: Record<string, unknown>,
  ctx?: ExecutionContext,
) => unknown;

/**
 * Every write stages, whatever its risk.
 *
 * A write that skips staging has no derived diff, and a plan containing one
 * shows the human a combined preview missing part of what will happen. An
 * unapproved write stages and commits in the same call, so the uniformity
 * costs a fork and buys a complete preview.
 */
function staged(
  spec: WriteSpec & { execute: StagedExecute; commitMode?: CommitMode },
  risk: "WRITE" | "CONSEQUENTIAL",
): Capability {
  const { execute, commitMode, ...rest } = spec;
  if (execute.constructor?.name === "AsyncFunction") {
    throw new Error(
      `${spec.name} declares an async handler. A staged write must finish before it returns, because its fork closes when it does.`,
    );
  }
  registerOperation(spec.name, (input) => execute(input), commitMode ?? "merge");
  return defineCapability({
    ...rest,
    risk,
    staging: { operation: spec.name },
  });
}

export function createSearchCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "READ" } as CapabilitySpec);
}

export function createReadCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "READ" } as CapabilitySpec);
}

export function createUpdateCapability(
  spec: WriteSpec & { execute: StagedExecute },
): Capability {
  return staged(spec, "WRITE");
}

/**
 * A consequential transition holds its staged write for a human. The runtime
 * holds the proposal and commits it, or discards it and nothing happened.
 */
export function createStateTransitionCapability(
  spec: WriteSpec & {
    consequential?: boolean;
    commitMode?: CommitMode;
    execute: StagedExecute;
  },
): Capability {
  const { consequential, ...rest } = spec;
  return staged(rest, consequential === true ? "CONSEQUENTIAL" : "WRITE");
}

export function createReportCapability(spec: FactorySpec): Capability {
  return defineCapability({
    ...spec,
    domain: spec.domain ?? "reports",
    risk: "READ",
  } as CapabilitySpec);
}
