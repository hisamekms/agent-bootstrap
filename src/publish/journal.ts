import type {
  PublishDestination,
  PublishFailure,
  PublishPullRequest,
} from "./port.ts";
import type { GoalPublishView } from "./protocol.ts";

export type PublishEventKind =
  | "publish.authorized"
  | "publish.pushed"
  | "publish.pr-opened"
  | "publish.auto-merge-set"
  | "publish.failed"
  | "publish.polled";

export interface PublishAuthorization {
  head: string;
  requireFinished: boolean;
  autoMergeRevision?: number | undefined;
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
  phase: "push" | "pr" | "auto-merge" | "complete";
  pushedHead?: string;
  pendingMutation?: PublishMutation | undefined;
  pr?: PublishPullRequest;
  lastCheckedAt?: string;
  prOpenedAt?: string;
  failure?: PublishFailure | undefined;
  disarmFailure?: "auto-merge-disarm-failed" | undefined;
  pollFailure?:
    "publish-poll-failed" | "publish-remote-head-changed" | undefined;
  autoMergeRevision?: number | undefined;
}

export function remoteGoalBranch({ id, ref }: { id: string; ref: string }) {
  return `ab/${ref.toLowerCase()}-${id.slice(0, 8)}`;
}

export function publishView(
  enabled: boolean,
  branch: string,
  record: GoalPublishRecord | null,
  setting: {
    method: GoalPublishView["autoMerge"];
    source: GoalPublishView["autoMergeSource"];
  },
  currentHead: string | null,
): GoalPublishView {
  const { pr, failure, disarmFailure, pollFailure, pushedHead, lastCheckedAt } =
    record ?? {};
  const code = disarmFailure ?? failure ?? pollFailure;
  const state =
    pr && pr.state !== "open"
      ? pr.state === "merged" && currentHead && currentHead !== pr.head
        ? "merged-stale"
        : pr.state
      : disarmFailure || (failure && failure !== "auto-merge-unavailable")
        ? "failed"
        : pr
          ? "pr-open"
          : pushedHead && pushedHead === record?.head
            ? "pushed"
            : enabled
              ? "pending"
              : "disabled";
  return {
    enabled,
    state,
    branch,
    autoMerge: setting.method,
    autoMergeSource: setting.source,
    ...(pr && {
      prNumber: pr.number,
      prUrl: pr.url,
      ...(pr.checks && { checks: pr.checks }),
      ...(pr.autoMerge !== "off" && { autoMergeEnabled: pr.autoMerge }),
    }),
    ...(lastCheckedAt && { lastCheckedAt }),
    ...(code && { failure: code }),
  };
}
