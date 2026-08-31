import {
  defineCapability,
  type Capability,
  type CapabilitySpec,
  type DirectCapabilitySpec,
  type DistributiveOmit,
} from "@agentdesk/webmcp";
import { stagedHandler, type CommitMode, type StagedExecute } from "./staged.ts";

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
 * shows the human a combined preview that is missing part of what will
 * happen. An unapproved write stages and commits in the same call, so the
 * uniformity costs a fork and buys a complete preview.
 */
function staged(
  spec: WriteSpec & { execute: StagedExecute; commitMode?: CommitMode },
  risk: "WRITE" | "CONSEQUENTIAL",
): Capability {
  const { execute, commitMode, ...rest } = spec;
  if (execute.constructor?.name === "AsyncFunction") {
    throw new Error(
      `${spec.name} declares an async handler. A staged write must finish before it returns, because its writes go to a fork that closes when it does.`,
    );
  }
  return defineCapability({
    ...rest,
    risk,
    stage: stagedHandler(spec.name, execute, commitMode),
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
 * A consequential transition holds its staged write for a human. `execute`
 * becomes the staged run and is never called directly; the runtime holds the
 * proposal and commits it, or discards it and nothing happened.
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
