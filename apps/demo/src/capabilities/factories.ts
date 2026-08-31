import {
  defineCapability,
  type Capability,
  type CapabilitySpec,
  type DirectCapabilitySpec,
  type DistributiveOmit,
  type StagedWrite,
} from "@agentdesk/webmcp";
import {
  setCommitMode,
  stagingAdapter,
  type CommitMode,
  type StagedBranch,
} from "./staged.ts";

type FactorySpec = DistributiveOmit<CapabilitySpec, "risk" | "policy">;

/**
 * A capability that writes declares only how it writes. Its diff comes from
 * staging that write, so there is no preview callback or evidence label to
 * set here and no way to claim one without the staged run behind it.
 */
type WriteSpec = Omit<
  DirectCapabilitySpec,
  "risk" | "policy" | "execute" | "previewChanges" | "approvalEvidence" | "stage"
>;

/**
 * Every write stages, whatever its risk.
 *
 * A write that skips staging has no derived diff, and a plan containing one
 * shows the human a combined preview missing part of what will happen. An
 * unapproved write stages and commits in the same call, so the uniformity
 * costs a fork and buys a complete preview.
 */
function staged(
  spec: WriteSpec & { execute: StagedWrite; commitMode?: CommitMode },
  risk: "WRITE" | "CONSEQUENTIAL",
): Capability {
  const { execute, commitMode, ...rest } = spec;
  setCommitMode(spec.name, commitMode ?? "merge");
  return defineCapability<StagedBranch>({
    ...rest,
    risk,
    staging: { adapter: stagingAdapter, write: execute },
  });
}

export function createSearchCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "READ" } as CapabilitySpec);
}

export function createReadCapability(spec: FactorySpec): Capability {
  return defineCapability({ ...spec, risk: "READ" } as CapabilitySpec);
}

export function createUpdateCapability(
  spec: WriteSpec & { execute: StagedWrite },
): Capability {
  return staged(spec, "WRITE");
}

/**
 * A consequential transition holds its staged write for a human. `execute`
 * becomes the staged run and is never called directly; the runtime holds the
 * proposal and commits it, or discards it and nothing happened.
 */
export function createStateTransitionCapability(
  spec: WriteSpec & {
    consequential?: boolean;
    commitMode?: CommitMode;
    execute: StagedWrite;
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
