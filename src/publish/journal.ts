import type {
  PublishConfig,
  PublishDestination,
  PublishFailure,
  PublishPullRequest,
} from "./port.ts";
import type { GoalPrActionFailure, GoalPublishView } from "./protocol.ts";

export type PublishEventKind =
  | "publish.authorized"
  | "publish.pushed"
  | "publish.pr-opened"
  | "publish.pr-merged"
  | "publish.pr-closed"
  | "publish.auto-merge-set"
  | "publish.auto-merge-unavailable"
  | "publish.completed-manually"
  | "publish.failed"
  | "publish.polled";

export interface PublishAuthorization {
  head: string;
  requireFinished: boolean;
  autoMergeRevision?: number | undefined;
  prNumber?: number;
}

export type PublishMutation =
  | { step: "push"; head?: string }
  | { step: "open-pr" }
  | {
      step: "auto-merge";
      method: GoalPublishView["autoMerge"];
      head: string;
      revision: number;
    };

export interface GoalPublishRecord {
  destination: PublishDestination;
  head: string;
  manualStart?: true;
  afterPrNumber?: number;
  phase: "push" | "pr" | "auto-merge" | "complete";
  pushedHead?: string;
  pendingMutation?: PublishMutation | undefined;
  pr?: PublishPullRequest;
  lastCheckedAt?: string;
  prOpenedAt?: string;
  prActionOutcome?: "unknown" | undefined;
  prActionFailure?: GoalPrActionFailure | undefined;
  failure?: PublishFailure | undefined;
  autoMergeUnavailable?: true | undefined;
  disarmFailure?: "auto-merge-disarm-failed" | undefined;
  pollFailure?:
    "publish-poll-failed" | "publish-remote-head-changed" | undefined;
  autoMergeRevision?: number | undefined;
}

export function remoteGoalBranch({ id, ref }: { id: string; ref: string }) {
  return `ab/${ref.toLowerCase()}-${id.slice(0, 8)}`;
}

export function publishFailure(record: GoalPublishRecord | null) {
  return (
    record?.disarmFailure ??
    (record?.failure === "auto-merge-unavailable"
      ? undefined
      : record?.failure) ??
    record?.pollFailure
  );
}

export function mergedHeadDiffers(
  record: GoalPublishRecord,
  currentHead: string | null,
) {
  const head = record.pr?.head;
  return head !== currentHead || head !== record.pushedHead;
}

export function publishView(
  config: PublishConfig,
  branch: string,
  record: GoalPublishRecord | null,
  setting: {
    method: GoalPublishView["autoMerge"];
    source: GoalPublishView["autoMergeSource"];
  },
  currentHead: string | null,
): GoalPublishView {
  const { enabled, mergeMethod } = config;
  const { pr, pushedHead, lastCheckedAt } = record ?? {};
  const code = pr?.state === "merged" ? undefined : publishFailure(record);
  const state =
    pr?.state === "merged"
      ? mergedHeadDiffers(record!, currentHead)
        ? "merged-stale"
        : "merged"
      : code
        ? "failed"
        : pr
          ? pr.state === "open"
            ? "pr-open"
            : "closed"
          : pushedHead && pushedHead === record?.head
            ? "pushed"
            : record?.phase === "push" && enabled
              ? "pushing"
              : enabled || record
                ? "pending"
                : "disabled";
  return {
    enabled,
    state,
    branch,
    autoMerge: setting.method,
    autoMergeSource: setting.source,
    ...(pr &&
      record && {
        prNumber: pr.number,
        prUrl: pr.url,
        base: record.destination.base,
        mergeMethod,
        ...(pr.checkRuns !== undefined && { checkRuns: pr.checkRuns }),
        ...(pr.checkCounts !== undefined && { checkCounts: pr.checkCounts }),
        ...(pr.mergeable !== undefined && { mergeable: pr.mergeable }),
        ...(pr.review !== undefined && { review: pr.review }),
        ...(pr.additions !== undefined && { additions: pr.additions }),
        ...(pr.deletions !== undefined && { deletions: pr.deletions }),
        ...(pr.changedFiles !== undefined && { changedFiles: pr.changedFiles }),
        ...(pr.checks && { checks: pr.checks }),
        ...(pr.state === "open" &&
          pr.autoMerge !== "off" && { autoMergeEnabled: pr.autoMerge }),
      }),
    ...(lastCheckedAt && { lastCheckedAt }),
    ...(record?.prActionOutcome && { prActionOutcome: record.prActionOutcome }),
    ...(pr?.state === "open" &&
      record?.prActionFailure && { prActionFailure: record.prActionFailure }),
    ...(pr?.state === "open" &&
      (record?.autoMergeUnavailable ||
        record?.failure === "auto-merge-unavailable") && {
        autoMergeUnavailable: true as const,
      }),
    ...(code && { failure: code }),
  };
}
