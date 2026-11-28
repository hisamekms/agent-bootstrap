import type {
  AutoMerge,
  MergeMethod,
  PublishChecks,
  PublishPrFacts,
  PublishFailure,
  PublishPullRequest,
} from "./port.ts";

export interface GoalPrActionFailure {
  code: "publish-merge-failed" | "publish-close-failed";
  at: string;
}

export interface GoalPublishView extends PublishPrFacts {
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
  base?: string;
  mergeMethod?: MergeMethod;
  checks?: PublishChecks;
  autoMerge: AutoMerge;
  autoMergeSource: "goal" | "project";
  autoMergeEnabled?: Exclude<AutoMerge, "off">;
  lastCheckedAt?: string;
  prActionOutcome?: "unknown";
  prActionFailure?: GoalPrActionFailure;
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

export interface GoalPrActions {
  merge?: Record<MergeMethod, string>;
  close?: string;
  autoMerge?: GoalAutoMergeConfirmations;
}

export function goalPrConfirmation(
  ref: string,
  pr: Pick<PublishPullRequest, "number" | "head" | "checks">,
  operation: MergeMethod | "close",
) {
  return operation === "close"
    ? `close-goal-pr ${ref} #${pr.number} ${pr.head}`
    : `merge-goal ${ref} #${pr.number} ${pr.head} ${operation} checks=${pr.checks ?? "unknown"}`;
}

interface GoalPrResult extends GoalPublishView {
  goalCompleted?: true;
}

export interface GoalPublishMethods {
  "goal.merge": {
    params: {
      id: string;
      method: MergeMethod;
      confirm: string;
      noChecks?: true;
    };
    result: GoalPrResult;
  };
  "goal.closePr": {
    params: { id: string; confirm: string };
    result: GoalPrResult;
  };
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
  "PR があるため Goal を変更できません。続けるには PR を閉じるか、Goal を取り消してください。";
