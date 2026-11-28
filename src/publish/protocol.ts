import type {
  AutoMerge,
  PublishChecks,
  PublishFailure,
  PublishPullRequest,
} from "./port.ts";

export interface GoalPublishView {
  enabled: boolean;
  state:
    | "disabled"
    | "pending"
    | "pushing"
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
  autoMergeUnavailable?: true;
}

export interface GoalPublishParams {
  id: string;
  expectedHead: string;
  confirm: string;
  expectedPr?: GoalPublishConfirmationPr;
}

export type GoalPublishConfirmationPr = Pick<
  PublishPullRequest,
  "number" | "state"
> | null;

export interface GoalSetAutoMergeParams {
  id: string;
  method: AutoMerge;
  confirm: string;
}

export type GoalAutoMergeConfirmations = Record<AutoMerge, string>;

export interface GoalPublishMethods {
  "goal.publish": { params: GoalPublishParams; result: GoalPublishView };
  "goal.completeAfterMerge": {
    params: { id: string; confirm: string };
    result: { id: string; ref: string; status: "done" };
  };
  "goal.setAutoMerge": {
    params: GoalSetAutoMergeParams;
    result: Pick<GoalPublishView, "autoMerge" | "autoMergeSource">;
  };
}

export function goalPublishConfirmation(ref: string, head: string) {
  return `publish-goal ${ref} ${head.slice(0, 12)}`;
}

export function goalMergeCompletionConfirmation(
  ref: string,
  number: number,
  head: string,
) {
  return `complete-goal ${ref} #${number} ${head}`;
}

export const goalPrOpenGuidance =
  "PR があるため Goal を変更できません。続けるには GitHub で PR を閉じるか、Goal を取り消してください。";
