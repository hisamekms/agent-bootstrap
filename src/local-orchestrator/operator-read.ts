import { escapeTerminalControls } from "./analysis.ts";
import type { CredentialScanner } from "./credential-scan.ts";
import { MAX_REVISIONS } from "../integration-journal.ts";
import { inboxLimit } from "./inbox.ts";
import { goalBranch } from "./model.ts";
import {
  goalEstimate,
  meanTaskWallTime,
  taskEstimate,
  taskStage,
  taskStageMeans,
  taskTimings,
} from "./operator-estimates.ts";
import { readPathViolations } from "./path-violations.ts";
import { candidateDiffStat } from "./tasks.ts";
import type { OrchestratorStore } from "./store.ts";

type ProposalDetails = NonNullable<
  ReturnType<OrchestratorStore["getProposalDetails"]>
>;

function proposalPolicy({
  gate,
  policy,
  source,
  loosening,
  humanApprovalRequired,
  humanAnswerRequired,
}: ProposalDetails) {
  return {
    gate,
    effectivePolicy: policy,
    policySource: source,
    loosening,
    humanApprovalRequired,
    humanAnswerRequired,
  };
}

export function operatorStatus(store: OrchestratorStore) {
  const proposals = store.listProposals();
  const goals = store.listGoals();
  const pending = proposals
    .filter(({ status }) => status === "pending")
    .map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      ...(proposal.kind === "integration"
        ? {
            goalId: proposal.content.goalId,
            taskId: proposal.content.taskId,
          }
        : { title: proposal.content.title }),
      ...proposalPolicy(store.getProposalDetails(proposal.id)!),
    }));
  const { recentExecutions, recentTasks } = store.getHostApiStatus();
  return {
    counts: {
      goals: goals.length,
      tasks: goals.reduce(
        (count, goal) => count + store.listTasks(goal.id).length,
        0,
      ),
      proposals: proposals.length,
      pending: pending.length,
    },
    pending,
    recentExecutions,
    recentTasks,
  };
}

export async function operatorProposal(
  store: OrchestratorStore,
  stateDirectory: string,
  id: string,
  scan?: CredentialScanner,
) {
  const proposal = store.getProposalDetails(id);
  if (!proposal) return null;
  const diffStat =
    proposal.kind === "integration"
      ? (await candidateDiffStat(stateDirectory, proposal.content, scan))
          .split("\n")
          .map(escapeTerminalControls)
          .join("\n")
      : null;
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    digest: proposal.digest,
    ...proposalPolicy(proposal),
    diffStat,
  };
}

export const goalStatuses = ["active", "done", "cancelled"] as const;
type GoalStatus = (typeof goalStatuses)[number];
type Goal = NonNullable<ReturnType<OrchestratorStore["getGoal"]>>;
type Task = NonNullable<ReturnType<OrchestratorStore["getTask"]>>;

function goalSummary(
  store: OrchestratorStore,
  goal: Goal,
  wallTime: number | null,
) {
  const { id, status, createdAt, content } = goal;
  const progress = store.goalTaskProgress(id);
  return {
    id,
    title: content.title,
    status,
    createdAt,
    progress,
    estimate: goalEstimate(progress.total - progress.done, wallTime),
  };
}

export function operatorGoalList(
  store: OrchestratorStore,
  status?: GoalStatus,
) {
  const goals = store.listGoals(status, inboxLimit);
  if (!goals.length) return [];
  const wallTime = meanTaskWallTime(store.succeededTaskWallTimes());
  return goals.map((goal) => goalSummary(store, goal, wallTime));
}

function taskContext(
  store: OrchestratorStore,
  goalId: string,
  taskId?: string,
) {
  const timings = taskTimings(store.operatorTaskTimeline(goalId, taskId));
  const means = taskStageMeans(
    [...timings.values()]
      .filter(({ times }) => times.done !== undefined)
      .map(({ times }) => times),
  );
  return { timings, means, now: Date.now() };
}

function taskSummary(
  task: Task,
  { timings, means, now }: ReturnType<typeof taskContext>,
) {
  const { id, content, status, attempts, retries } = task;
  const timing = timings.get(id);
  const stage = taskStage(status, timing?.activeExecution);
  const started = timing?.times.running;
  const stageStarted =
    stage === "failed" || stage === "cancelled"
      ? undefined
      : timing?.times[stage];
  return {
    id,
    title: content.title,
    status,
    stage,
    attempt: {
      current: attempts,
      max:
        (retries + 1) *
        (Math.min(content.budgets.maxRetries, MAX_REVISIONS) + 1),
    },
    elapsedMs:
      started === undefined
        ? 0
        : Math.max(0, (timing?.endedAt ?? now) - started),
    estimate: taskEstimate(
      stage,
      stageStarted === undefined ? 0 : Math.max(0, now - stageStarted),
      means,
    ),
  };
}

function taskSummaries(store: OrchestratorStore, goalId: string) {
  const context = taskContext(store, goalId);
  return store
    .listTasks(goalId, inboxLimit)
    .map((task) => taskSummary(task, context));
}

export function operatorGoal(store: OrchestratorStore, id: string) {
  const goal = store.getGoal(id);
  if (!goal) return null;
  const { description, acceptance, scope } = goal.content;
  return {
    ...goalSummary(
      store,
      goal,
      meanTaskWallTime(store.succeededTaskWallTimes()),
    ),
    description,
    acceptance,
    scope,
    budgets: scope.budgets,
    baseCommit: goal.baseCommit,
    branch: goalBranch(id),
    tasks: taskSummaries(store, id),
  };
}

export function operatorTaskList(store: OrchestratorStore, goalId: string) {
  return store.getGoal(goalId) ? taskSummaries(store, goalId) : null;
}

export function operatorTask(store: OrchestratorStore, id: string) {
  const task = store.getTask(id);
  if (!task) return null;
  const {
    goalId,
    content: { description, acceptance, actor, paths, budgets },
  } = task;
  const context = taskContext(store, goalId, id);
  const timing = context.timings.get(id);
  const rejectedPaths =
    timing?.failureCode === "path-violation"
      ? store.taskPathViolations(id)
      : undefined;
  const usage = store.taskUsage(id);
  return {
    ...taskSummary(task, context),
    goalId,
    description,
    acceptance,
    actor,
    paths,
    budgets,
    tokensUsed: usage.tokens,
    tokensIncomplete: usage.usage === "unavailable",
    executions: store.recentTaskExecutions(id),
    ...(task.status === "failed" && {
      failure: {
        code: timing?.failureCode ?? "unknown",
        stage: timing?.lastStage ?? "registered",
        ...(rejectedPaths && { rejectedPaths }),
      },
    }),
    events: store
      .listEvents({ subjectId: id, limit: 10 })
      .map(({ kind, at }) => ({ kind, at })),
  };
}

export function operatorProblems(
  store: OrchestratorStore,
  includeResolved = false,
) {
  const problems = store.inboxRows(includeResolved, "", true).map((row) => {
    const { at, goalId, taskId, executionId, modelText } = row;
    const problem = {
      at,
      goalId,
      taskId,
      title: modelText ?? "",
      ...(executionId && { executionId }),
    };
    if (row.kind === "execution-over-budget") {
      return {
        ...problem,
        kind: row.kind,
        detail: "実行がトークン予算を超過しました。",
      };
    }
    const rejectedPaths =
      row.code === "path-violation" && row.rejectedPathsJson !== null
        ? readPathViolations(JSON.parse(row.rejectedPathsJson))
        : undefined;
    if (executionId && row.code === "path-violation") {
      return {
        ...problem,
        kind: "path-violation" as const,
        detail: "実行で対象範囲外の変更が拒否されました。",
        ...(rejectedPaths && { rejectedPaths }),
      };
    }
    const code = row.code ?? "unknown";
    const canRetry = Boolean(row.canRetry && !row.resolved);
    const kind = code === "path-violation" ? "path-violation" : "task-failed";
    return {
      ...problem,
      kind,
      code,
      canRetry,
      detail: `Task が失敗しました（${code}）。${canRetry ? "再試行できます。" : "再試行できません。"}`,
      ...(rejectedPaths && { rejectedPaths }),
    };
  });
  // Rejected paths can make a full 200-item page larger than a socket reply.
  let bytes = 0;
  const limit = problems.findIndex((problem) => {
    bytes += Buffer.byteLength(JSON.stringify(problem)) + 1;
    return bytes > 768 * 1024;
  });
  return limit < 0 ? problems : problems.slice(0, limit);
}
