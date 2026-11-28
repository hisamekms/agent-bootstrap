import { publishView, remoteGoalBranch } from "../publish/journal.ts";
import type { GoalPublishedReason } from "../publish/protocol.ts";
import { codexFailureActions, isCodexFailureCode } from "../codex-exec.ts";
import { executionDisplay } from "./execution-display.ts";
import { escapeTerminalControls } from "./analysis.ts";
import {
  builtInCredentialScanner,
  type CredentialScanner,
} from "./credential-scan.ts";
import { MAX_REVISIONS } from "../integration-journal.ts";
import {
  inboxLimit,
  projectInbox,
  type InboxItem,
  type InboxSource,
} from "./inbox.ts";
import { GATES, goalBranch } from "./model.ts";
import {
  environmentMissingReason,
  environmentUpdateDisabledReason,
  failureLabel,
  failureReason,
  groupProblems,
  pendingDecisions,
} from "./operator-attention.ts";
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
import { permitsPanelAnswer, type OrchestratorStore } from "./store.ts";

type ProposalDetails = NonNullable<
  ReturnType<OrchestratorStore["getProposalDetails"]>
>;

function escapeMultilineText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(escapeTerminalControls)
    .join("\n");
}

function proposalPolicy({
  gate,
  policy,
  source,
  ruleId,
  ruleName,
  invariant,
  loosening,
  humanApprovalRequired,
  humanAnswerRequired,
}: ProposalDetails) {
  return {
    gate,
    effectivePolicy: policy,
    policySource: source,
    ...(ruleId && { ruleId, ruleName }),
    ...(invariant && { invariant }),
    loosening,
    ...(humanApprovalRequired && { humanApprovalRequired }),
    ...(humanAnswerRequired && { humanAnswerRequired }),
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
      ref: proposal.ref,
      goalRef: proposal.goalRef,
      taskRef: proposal.taskRef,
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

export function operatorInbox(store: OrchestratorStore, items: InboxItem[]) {
  return items.map((item) => {
    const id = item.subject.proposalId;
    if (!id || item.weight !== "action" || item.state === "resolved")
      return item;
    const proposal = store.getProposalDetails(id);
    if (proposal?.status !== "pending") return item;
    const approve = permitsPanelAnswer(proposal.origin, proposal, "approve");
    const reject = permitsPanelAnswer(proposal.origin, proposal, "reject");
    const takeover = proposal.policy === "agent" && (!approve || !reject);
    if (!approve && !reject && !takeover) return item;
    const title =
      proposal.kind === "integration"
        ? store.getTask(proposal.content.taskId)?.content.title
        : proposal.content.title;
    const policies =
      proposal.kind === "integration" ? undefined : proposal.content.policies;
    return {
      ...item,
      answer: {
        id,
        kind: proposal.kind,
        digest: proposal.digest,
        title: title === undefined ? null : escapeTerminalControls(title),
        agentGates: GATES.filter((gate) => policies?.[gate] === "agent"),
        approve,
        reject,
        ...(takeover && { takeover: true as const }),
      },
    };
  });
}

export async function operatorProposal(
  store: OrchestratorStore,
  stateDirectory: string,
  id: string,
  scan?: CredentialScanner,
) {
  const proposal = store.getProposalDetails(id, { includeEvidence: true });
  if (!proposal) return null;
  const check = scan ?? builtInCredentialScanner;
  const withheld = { withheld: true } as const;
  async function screen(text: string, multiline = false) {
    try {
      await check(text);
      return multiline
        ? escapeMultilineText(text)
        : escapeTerminalControls(text);
    } catch {
      return withheld;
    }
  }
  async function screenList(text: readonly string[], multiline = false) {
    if (!text.length) return [];
    try {
      await check(...text, JSON.stringify(text));
      return text.map(multiline ? escapeMultilineText : escapeTerminalControls);
    } catch {
      return withheld;
    }
  }
  const { ruleId, ruleName, ...policy } = proposalPolicy(proposal);
  const common = {
    id: proposal.id,
    status: proposal.status,
    digest: proposal.digest,
    ref: proposal.ref,
    goalRef: proposal.goalRef,
    taskRef: proposal.taskRef,
    ...policy,
    ...(ruleId !== undefined && { ruleId: await screen(ruleId) }),
    ...(ruleName !== undefined && { ruleName: await screen(ruleName) }),
    origin:
      proposal.origin.kind === "actor"
        ? { kind: proposal.origin.kind, actor: proposal.origin.actor }
        : proposal.origin,
  };
  if (proposal.kind === "integration") {
    const rawStat = await candidateDiffStat(
      stateDirectory,
      proposal.content,
      scan,
    );
    const changedPaths = await screenList(proposal.content.changedPaths);
    // The stat repeats changed paths in Git's display format.
    let diffStat: string | typeof withheld = withheld;
    if (!("withheld" in changedPaths)) {
      const escaped = escapeMultilineText(rawStat);
      try {
        await check(rawStat, escaped);
        diffStat = escaped;
      } catch {}
    }
    const review = proposal.pinnedReview;
    if (!review || !proposal.budgets)
      throw new Error("Missing integration evidence");
    const { notes } = proposal.content.review;
    return {
      ...common,
      kind: proposal.kind,
      diffStat,
      changedPaths,
      changedFiles:
        proposal.diffSize?.changedFiles ?? proposal.content.changedPaths.length,
      changedLines: proposal.diffSize?.changedLines ?? null,
      budgets: proposal.budgets,
      pathViolations: [],
      reviewExecutionId: review.executionId,
      modelText: {
        verdict: review.verdict,
        findings: notes === undefined ? null : await screen(notes, true),
      },
    };
  }
  const { content } = proposal;
  const modelText = {
    description: await screen(content.description, true),
    acceptance: await screenList(content.acceptance, true),
  };
  const registration = { ...common, diffStat: null, modelText };
  if (proposal.kind === "goal") {
    const { paths, ...scope } = proposal.content.scope;
    return {
      ...registration,
      kind: proposal.kind,
      ...scope,
      paths: await screenList(paths),
      pathViolations: [],
    };
  }
  return {
    ...registration,
    kind: proposal.kind,
    budgets: proposal.content.budgets,
    paths: await screenList(proposal.content.paths),
    pathViolations: await screenList(proposal.pathViolations ?? []),
    actor: proposal.content.actor,
    profile: proposal.content.profile,
  };
}

export function operatorActivity(source: InboxSource) {
  const rows = source.store.activityRows();
  const running = rows.filter(({ status }) => status === "running");
  const queued = rows.filter(({ status }) => status !== "running");
  const yourTurn =
    pendingDecisions(projectInbox(source)).length +
    groupProblems(operatorProblems(source.store)).length;
  return { running, queued, queuedCount: queued.length, yourTurn };
}

export function operatorActivityRevision(
  source: InboxSource,
  now = Date.now(),
) {
  const checks = source.secretTests?.() ?? [];
  const pendingChecks = checks.filter(({ passed }) => !passed).length;
  // The rolling inbox cutoff can expire visible history without a journal write.
  const visibleHistory = projectInbox(
    { ...source, secretTests: () => checks },
    { now },
  ).filter(({ weight }) => weight === "info").length;
  return `${source.store.activityRevision()}:${pendingChecks}:${visibleHistory}`;
}

export const goalStatuses = ["active", "done", "cancelled"] as const;
type GoalStatus = (typeof goalStatuses)[number];
type Goal = NonNullable<ReturnType<OrchestratorStore["getGoal"]>>;
type Task = NonNullable<ReturnType<OrchestratorStore["getTask"]>>;

type GoalTurnFacts = NonNullable<
  ReturnType<ReturnType<OrchestratorStore["goalTurnFacts"]>["get"]>
>;

export function operatorGoalTurn(
  store: OrchestratorStore,
  goal: Goal,
  facts = store.goalTurnFacts([goal.id]).get(goal.id)!,
) {
  const {
    approvals,
    progress,
    failedRef,
    failedCode,
    runningRef,
    runningActor,
    executionActor,
    executionTaskRef,
    queued,
    planned,
    exportable,
  } = facts;
  if (approvals > 0)
    return {
      owner: "human",
      reason: { kind: "approvals", count: approvals },
    } as const;
  if (goal.status === "cancelled")
    return { owner: "stopped", reason: { kind: "cancelled" } } as const;
  if (failedRef)
    return {
      owner: "stopped",
      reason: { kind: "failed", taskRef: failedRef, code: failedCode },
    } as const;

  if (executionActor === "Planner")
    return { owner: "ai", reason: { kind: "planning" } } as const;
  if (executionActor || runningActor)
    return {
      owner: "ai",
      reason: {
        kind: "running",
        actor: executionActor ?? runningActor!,
        taskRef: executionActor ? executionTaskRef : runningRef,
      },
    } as const;
  if (queued || progress.awaitingIntegration > 0)
    return { owner: "ai", reason: { kind: "queued" } } as const;

  if (goal.status === "active" && progress.total === 0 && !planned)
    return { owner: "idle", reason: { kind: "not-planned" } } as const;
  if (
    goal.status === "done" ||
    (progress.total > 0 && progress.done === progress.total)
  ) {
    const head = store.goalIntegrationHead(goal.id) ?? goal.baseCommit;
    const published = store.goalPublishRecord(goal.id);
    const exported = store.goalExported(goal.id);
    let finished: GoalPublishedReason | undefined;
    if (head && published?.pushedHead === head && published.pr?.head === head)
      finished = {
        kind: "published",
        branch: published.destination.branch,
        prNumber: published.pr.number,
        prUrl: published.pr.url,
      };
    else if (head && exported?.head === head)
      finished = { kind: "exported", branch: exported.branch };
    return {
      owner: "done",
      reason:
        finished ??
        ({ kind: exportable ? "exportable" : "completed" } as const),
    } as const;
  }
  return { owner: "idle", reason: { kind: "idle" } } as const;
}

function goalSummary(
  store: OrchestratorStore,
  goal: Goal,
  wallTime: number | null,
  facts: GoalTurnFacts,
) {
  const { id, ref, status, createdAt, content } = goal;
  const { progress } = facts;
  return {
    id,
    ref,
    title: content.title,
    status,
    createdAt,
    turn: operatorGoalTurn(store, goal, facts),
    publish: publishView(
      store.goalPublishEnabled,
      remoteGoalBranch(goal),
      store.goalPublishRecord(id),
      store.goalAutoMerge(id),
      store.goalIntegrationHead(id) ?? goal.baseCommit,
    ),
    progress,
    estimate:
      status === "active"
        ? goalEstimate(progress.total - progress.done, wallTime)
        : { remainingMs: null, basis: "current-plan" as const },
  };
}

export function operatorGoalList(
  store: OrchestratorStore,
  status?: GoalStatus,
) {
  const goals = store.listGoals(status, inboxLimit);
  if (!goals.length) return [];
  const wallTime = meanTaskWallTime(store.succeededTaskWallTimes());
  const facts = store.goalTurnFacts(goals.map(({ id }) => id));
  return goals.map((goal) =>
    goalSummary(store, goal, wallTime, facts.get(goal.id)!),
  );
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
  const { id, ref, content, status, attempts, retries } = task;
  const timing = timings.get(id);
  const stage = taskStage(
    status,
    timing?.activeExecution,
    "code" in task ? (task.code as string | undefined) : undefined,
  );
  const verification =
    (stage === "review" ||
      (((stage === "running" && !timing?.activeExecution) ||
        stage === "failed") &&
        timing?.lastStage === "review")) &&
    timing?.lastReviewMode === "verification";
  const failureStage =
    stage === "failed" ? (timing?.lastStage ?? "registered") : undefined;
  const started = timing?.times.running;
  const stageStarted =
    stage === "failed" || stage === "cancelled"
      ? undefined
      : timing?.times[stage];
  return {
    id,
    ref,
    title: content.title,
    status,
    stage,
    ...(verification && { verification: true as const }),
    ...(failureStage && { failureStage }),
    retries,
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

export function operatorGoal(store: OrchestratorStore, key: string) {
  const goal = store.getGoal(key);
  if (!goal) return null;
  const { id } = goal;
  const { description, acceptance, scope } = goal.content;
  return {
    ...goalSummary(
      store,
      goal,
      meanTaskWallTime(store.succeededTaskWallTimes()),
      store.goalTurnFacts([id]).get(id)!,
    ),
    description,
    acceptance,
    scope,
    budgets: scope.budgets,
    baseCommit: goal.baseCommit,
    branch: goalBranch(id),
    policyOverrides: store.goalPolicyOverrides(id),
    autoMergeConfirmations: store.goalAutoMergeConfirmations(id),
    tasks: taskSummaries(store, id),
    timeline: store.operatorGoalTimeline(id),
  };
}

export function operatorTaskList(store: OrchestratorStore, goalId: string) {
  const goal = store.getGoal(goalId);
  return goal ? taskSummaries(store, goal.id) : null;
}

export function operatorTask(store: OrchestratorStore, key: string) {
  const task = store.getTask(key);
  if (!task) return null;
  const {
    id,
    goalId,
    content: {
      description,
      acceptance,
      actor,
      paths,
      budgets,
      category,
      environment,
    },
  } = task;
  const context = taskContext(store, goalId, id);
  const timing = context.timings.get(id);
  const rejectedPaths =
    timing?.failureCode === "path-violation"
      ? store.taskPathViolations(id)
      : undefined;
  const usage = store.taskUsage(id);
  const packageDiff = store.taskPackageDiff(id);
  const executions = store
    .recentTaskExecutions(id)
    .map(({ result, ...execution }) => ({
      ...execution,
      ...executionDisplay(result),
    }));
  const failureNote =
    timing?.failureCode === "env-build-failed"
      ? executions.find(({ code }) => code === timing.failureCode)?.next
      : undefined;
  const origin = category
    ? store.getProposal(task.proposalId)?.source
    : undefined;
  const plannerCategory =
    origin?.kind === "actor" && origin.actor === "Planner"
      ? category
      : undefined;
  return {
    ...taskSummary(task, context),
    goalId,
    goalRef: store.getGoal(goalId)!.ref,
    description,
    acceptance,
    actor,
    ...(plannerCategory && { category: plannerCategory }),
    ...(environment && { environment }),
    ...(packageDiff && { packageDiff }),
    paths,
    budgets,
    integrationPolicy: store.taskPolicyOverride(id),
    effectiveIntegrationPolicy: store.effectivePolicy("integration", {
      taskId: id,
    }),
    tokensUsed: usage.tokens,
    tokensIncomplete: usage.usage === "unavailable",
    executions,
    ...(task.status === "failed" && {
      failure: {
        code: timing?.failureCode ?? "unknown",
        stage: timing?.lastStage ?? "registered",
        ...(timing?.failureCode === "env-missing"
          ? {
              next: environmentMissingReason(
                timing.missingEnvironmentRole === "Verification",
              ),
            }
          : timing?.failureCode === "env-update-disabled"
            ? { next: environmentUpdateDisabledReason }
            : isCodexFailureCode(timing?.failureCode)
              ? { next: codexFailureActions[timing.failureCode] }
              : failureNote && { next: failureNote }),
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
    const { at, goalId, taskId, goalRef, taskRef, executionId, modelText } =
      row;
    const problem = {
      at,
      goalId,
      taskId,
      ref: taskRef ?? goalRef,
      goalRef,
      taskRef,
      ...(taskId && { expectedRetries: row.retries }),
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
        detail: "パス違反で実行が拒否されました。",
        ...(rejectedPaths && { rejectedPaths }),
      };
    }
    const code = row.code ?? "unknown";
    const canRetry = Boolean(row.canRetry && !row.resolved);
    const kind = code === "path-violation" ? "path-violation" : "task-failed";
    const label = failureLabel(code);
    const reason =
      code === "env-update-disabled"
        ? environmentUpdateDisabledReason
        : code === "env-missing"
          ? environmentMissingReason(
              row.missingEnvironmentRole === "Verification",
            )
          : `${label ? `Task が${label}で失敗しました` : failureReason(code)}。`;
    return {
      ...problem,
      kind,
      code,
      canRetry,
      detail: `${reason}${canRetry ? "再試行できます。" : "再試行できません。"}`,
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
