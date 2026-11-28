import type { AutoMerge, PublishChecks, PublishFailure } from "./port.ts";

export interface GoalPublishView {
  enabled: boolean;
  state:
    | "disabled"
    | "pending"
    | "pushed"
    | "pr-open"
    | "merged"
    | "merged-stale"
    | "closed"
    | "failed";
  branch: string;
  prNumber?: number;
  prUrl?: string;
  checks?: PublishChecks;
  autoMerge: AutoMerge;
  autoMergeSource: "goal" | "project";
  autoMergeEnabled?: Exclude<AutoMerge, "off">;
  lastCheckedAt?: string;
  failure?: PublishFailure;
}

export interface GoalPublishParams {
  id: string;
  expectedHead: string;
  confirm: string;
}

export interface GoalSetAutoMergeParams {
  id: string;
  method: AutoMerge;
  confirm: string;
}

export type GoalAutoMergeConfirmations = Record<AutoMerge, string>;

export interface GoalPublishMethods {
  "goal.publish": { params: GoalPublishParams; result: GoalPublishView };
  "goal.setAutoMerge": {
    params: GoalSetAutoMergeParams;
    result: Pick<GoalPublishView, "autoMerge" | "autoMergeSource">;
  };
}

export type GoalPublishedReason =
  | { kind: "exported"; branch: string }
  | { kind: "published"; branch: string; prNumber: number; prUrl: string };

export function goalPublishConfirmation(ref: string, head: string) {
  return `publish-goal ${ref} ${head.slice(0, 12)}`;
}
