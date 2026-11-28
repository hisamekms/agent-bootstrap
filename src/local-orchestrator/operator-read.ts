import { hostCheckExposure } from "./host-checks.ts";
import {
  publishFailure,
  publishView,
  remoteGoalBranch,
} from "../publish/journal.ts";
import { codexFailureActions, isCodexFailureCode } from "../codex-exec.ts";
import { executionDisplay } from "./execution-display.ts";
import { escapeTerminalControls } from "./analysis.ts";
import {
  builtInCredentialScanner,
  credentialScanClean,
  credentialScanCovered,
  maskCredentialSpans,
  maxCredentialMasks,
  proposalCredentialCheck,
  serializedTextSpan,
  type CredentialSpan,
  type CredentialScanner,
} from "./credential-scan.ts";
import {
  MAX_REVISIONS,
  VERIFICATION_NOTE_LIMIT_BYTES,
} from "../integration-journal.ts";
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
import {
  isWithheld,
  proposalField,
  proposalMaskableFields,
  proposalScreenedFields,
  withheldField,
  type ProposalMaskableField,
  type ProposalScreenedField,
} from "./proposal-screening.ts";
import { ClaudeRunError } from "./claude-errors.ts";
import { readPathViolations } from "./path-violations.ts";
import { candidateDiffStat, taskJournal } from "./tasks.ts";
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
      ...(proposal.kind === "integration" || proposal.kind === "host-check"
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
    publish: store.goalPublishConfig,
  };
}

export function operatorInbox(store: OrchestratorStore, items: InboxItem[]) {
  return items.map((item) => {
    if (item.kind === "pr-merge" || item.kind === "pr-auto-merge") {
      const goal = item.subject.goalId && store.getGoal(item.subject.goalId);
      const record = goal ? store.goalPublishRecord(goal.id) : null;
      if (goal && record?.pr?.state === "open")
        return {
          ...item,
          pullRequest: {
            publish: goalPublishView(store, goal),
            actions: store.goalPrActions(goal.id),
          },
        };
    }
    const id = item.subject.proposalId;
    if (!id || item.weight !== "action" || item.state === "resolved")
      return item;
    const proposal = store.getProposalDetails(id);
    if (proposal?.status !== "pending") return item;
    const approve =
      proposal.kind !== "host-check" &&
      permitsPanelAnswer(proposal.origin, proposal, "approve");
    const reject = permitsPanelAnswer(proposal.origin, proposal, "reject");
    const takeover = proposal.policy === "agent" && (!approve || !reject);
    if (!approve && !reject && !takeover) return item;
    const title =
      proposal.kind === "integration" || proposal.kind === "host-check"
        ? store.getTask(proposal.content.taskId)?.content.title
        : proposal.content.title;
    const policies =
      proposal.kind === "goal" || proposal.kind === "task"
        ? proposal.content.policies
        : undefined;
    return {
      ...item,
      answer: {
        id,
        kind: proposal.kind,
        digest: proposal.digest,
        title: title === undefined ? null : escapeTerminalControls(title),
        agentGates: GATES.filter((gate) => policies?.[gate] === "agent"),
        approve,
        ...(proposal.kind === "host-check" && {
          approveReason: "host-check-detail-required" as const,
        }),
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
  return proposal
    ? screenOperatorProposal(proposal, stateDirectory, scan, proposal.digest)
    : null;
}

type RawField = {
  sources: readonly string[];
  list: boolean;
  multiline: boolean;
  masked?: CredentialSpan[][];
};

function serializeRawDisplay(
  fields: { modelText: Record<string, unknown> },
  rawFields: ReadonlyMap<string, RawField>,
) {
  const covered: CredentialSpan[] = [];
  let text = "";
  function record(values: Record<string, unknown>) {
    text += "{";
    let separator = "";
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      text += separator + JSON.stringify(key) + ":";
      separator = ",";
      if (key === "modelText") {
        record(fields.modelText);
        continue;
      }
      const field = rawFields.get(key);
      if (!field) {
        text += JSON.stringify(value);
        continue;
      }
      const start = text.length;
      if (field.list) text += "[";
      for (const [index, source] of field.sources.entries()) {
        if (index) text += ",";
        for (const span of field.masked?.[index] ?? [])
          covered.push(serializedTextSpan(source, text.length, span));
        text += JSON.stringify(source);
      }
      if (field.list) text += "]";
      if (isWithheld(value)) covered.push([start, text.length]);
    }
    text += "}";
  }
  record(fields);
  return { text, covered };
}

function fieldSources(values: readonly string[], list: boolean) {
  return list ? [...values, JSON.stringify(values)] : values;
}

function strictSources(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "object")
    return [
      JSON.stringify(value),
      ...Object.values(value).flatMap(strictSources),
    ];
  return [JSON.stringify(value)];
}

export async function screenOperatorProposal(
  input: ProposalDetails,
  stateDirectory: string,
  scan?: CredentialScanner,
  displayDigest?: string,
) {
  const check = proposalCredentialCheck(
    scan ?? builtInCredentialScanner,
    displayDigest,
  );
  if (input.kind === "host-check") {
    const proposal = input;
    const { branch, base, candidate, digest, hostCheck } = proposal.content;
    const { digest: approvalDigest, ...details } = hostCheck;
    const response = {
      id: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      digest: proposal.digest,
      ref: proposal.ref,
      goalRef: proposal.goalRef,
      taskRef: proposal.taskRef,
      ...proposalPolicy(proposal),
      origin: { kind: "host" as const },
      diff: { branch, base, candidate, digest },
      ...details,
      approvalDigest,
      exposure: hostCheckExposure,
      diffStat: null,
      maskedFields: undefined,
    };
    // The proposal digest is the answer token. The separate approval digest
    // pins the inputs that will be rechecked before a future run.
    if (!(await check([strictSources(response)])).every(credentialScanClean))
      throw new ClaudeRunError("credential-leak");
    return response;
  }
  const proposal = input;
  const rawFields = new Map<ProposalScreenedField, RawField>();
  function screen(
    field: ProposalScreenedField,
    text: string,
    multiline = false,
  ): string | typeof withheldField {
    rawFields.set(field, { sources: [text], list: false, multiline });
    return text;
  }
  function screenList(
    field: ProposalScreenedField,
    text: readonly string[],
    multiline = false,
  ): readonly string[] | typeof withheldField {
    if (text.length)
      rawFields.set(field, { sources: text, list: true, multiline });
    return text;
  }
  let candidateSources: readonly (string | Uint8Array)[] = [];
  let candidateError: { error: unknown } | undefined;
  async function screenedDisplay<
    T extends { modelText: Record<string, unknown> },
  >(fields: T): Promise<T & { maskedFields?: ProposalMaskableField[] }> {
    const modelText = { ...fields.modelText };
    const output = { ...fields, modelText };
    const top: Record<string, unknown> = output;
    const slots = [...rawFields];
    const { text: raw } = serializeRawDisplay(fields, rawFields);
    const strict = [
      ...Object.entries(top)
        .filter(
          ([field]) =>
            field !== "modelText" &&
            !rawFields.has(field as ProposalScreenedField),
        )
        .flatMap(([, value]) =>
          isWithheld(value) ? [] : strictSources(value),
        ),
      ...Object.entries(modelText)
        .filter(([field]) => !rawFields.has(field as ProposalScreenedField))
        .flatMap(([, value]) => strictSources(value)),
      ...strictSources(
        proposal.kind === "integration"
          ? proposal.content.symlinks
          : proposal.kind === "goal"
            ? proposal.content.policies
            : {
                category: proposal.content.category,
                dependsOn: proposal.content.dependsOn,
                environment: proposal.content.environment,
                policies: proposal.content.policies,
              },
      ),
    ];
    const [aggregate, metadata, candidate, ...originals] = await check([
      [raw],
      strict,
      candidateSources,
      ...slots.map(([, { sources, list }]) => fieldSources(sources, list)),
    ]);

    function set(field: ProposalScreenedField, value: unknown) {
      if (Object.hasOwn(modelText, field)) modelText[field] = value;
      else top[field] = value;
    }
    const maskedFields: ProposalMaskableField[] = [];
    const rechecks: (readonly string[])[] = [];
    for (const [index, [field, slot]] of slots.entries()) {
      if (
        field === "diffStat" &&
        (isWithheld(top.changedPaths) ||
          !credentialScanClean(candidate ?? null))
      ) {
        set(field, withheldField);
        continue;
      }
      const { sources, list, multiline } = slot;
      const result = originals[index] ?? null;
      const escape = multiline ? escapeMultilineText : escapeTerminalControls;
      let values = sources;
      if (!credentialScanClean(result)) {
        const maskable = proposalMaskableFields.find((name) => name === field);
        const masks =
          maskable &&
          sources.map((source, i) => {
            const matches = result?.[i];
            return matches && maskCredentialSpans(source, matches);
          });
        const covered: CredentialSpan[] = [];
        if (!masks || masks.some((mask) => !mask)) {
          set(field, withheldField);
          continue;
        }
        let itemStart = 1;
        for (const [i, source] of sources.entries()) {
          for (const span of masks[i]!.spans)
            covered.push(serializedTextSpan(source, itemStart, span));
          itemStart += JSON.stringify(source).length + 1;
        }
        if (
          !covered.length ||
          covered.length > maxCredentialMasks ||
          (list &&
            !credentialScanCovered([result?.[sources.length] ?? null], covered))
        ) {
          set(field, withheldField);
          continue;
        }
        values = masks.map((mask) => mask!.text);
        slot.masked = masks.map((mask) => mask!.spans);
        maskedFields.push(maskable!);
      }
      const escaped = values.map(escape);
      set(field, list ? escaped : escaped[0]);
      rechecks.push(fieldSources(values, list));
      if (escaped.some((value, i) => value !== values[i]))
        rechecks.push(fieldSources(escaped, list));
    }
    if (candidateError && !isWithheld(top.changedPaths))
      throw candidateError.error;

    const { covered } = serializeRawDisplay(output, rawFields);
    const display = maskedFields.length ? { ...output, maskedFields } : output;
    if (
      credentialScanClean(metadata ?? null) &&
      credentialScanCovered(aggregate ?? null, covered)
    ) {
      const checked = await check([[JSON.stringify(display)], ...rechecks]);
      if (checked.every(credentialScanClean)) return display;
    }

    // A match spanning fields cannot reliably be mapped back to the source.
    for (const field of proposalScreenedFields) {
      const value = proposalField(top, modelText, field);
      if (value != null && (!Array.isArray(value) || value.length))
        set(field, withheldField);
    }
    const checked = await check([strict, [JSON.stringify(output)]]);
    if (!checked.every(credentialScanClean))
      throw new ClaudeRunError("credential-leak");
    return output;
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
    ...(ruleId !== undefined && { ruleId: screen("ruleId", ruleId) }),
    ...(ruleName !== undefined && {
      ruleName: screen("ruleName", ruleName),
    }),
    origin:
      proposal.origin.kind === "actor"
        ? { kind: proposal.origin.kind, actor: proposal.origin.actor }
        : proposal.origin,
  };
  if (proposal.kind === "integration") {
    const changedPaths = screenList(
      "changedPaths",
      proposal.content.changedPaths,
    );
    // A diff stat can abbreviate paths. Screen the pinned candidate in the
    // same batch and withhold the stat if its paths or candidate are blocked.
    let diffStat: string | typeof withheldField = withheldField;
    try {
      const rawStat = await candidateDiffStat(
        stateDirectory,
        proposal.content,
        scan &&
          (async (...sources) => {
            candidateSources = sources;
          }),
      );
      if (!rawStat.includes("\ufffd"))
        diffStat = screen("diffStat", rawStat, true);
    } catch (error) {
      candidateError = { error };
    }
    const review = proposal.pinnedReview;
    if (!review || !proposal.budgets)
      throw new Error("Missing integration evidence");
    const { notes } = proposal.content.review;
    const findings =
      notes === undefined ? null : screen("findings", notes, true);
    return screenedDisplay({
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
      ...(proposal.hostChecksPassed && {
        hostChecksPassed: true as const,
        verified: proposal.content.verified,
      }),
      modelText: {
        verdict: review.verdict,
        findings,
      },
    });
  }
  const { content } = proposal;
  const modelText = {
    description: screen("description", content.description, true),
    acceptance: screenList("acceptance", content.acceptance, true),
  };
  const registration = { ...common, diffStat: null, modelText };
  if (proposal.kind === "goal") {
    const { paths, ...scope } = proposal.content.scope;
    const screenedPaths = screenList("paths", paths);
    return screenedDisplay({
      ...registration,
      kind: proposal.kind,
      ...scope,
      paths: screenedPaths,
      pathViolations: [],
    });
  }
  const paths = screenList("paths", proposal.content.paths);
  const pathViolations = screenList(
    "pathViolations",
    proposal.pathViolations ?? [],
  );
  return screenedDisplay({
    ...registration,
    kind: proposal.kind,
    budgets: proposal.content.budgets,
    paths,
    pathViolations,
    actor: proposal.content.actor,
    profile: proposal.content.profile,
  });
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
  const record = store.goalPublishRecord(goal.id);
  const pr = record?.pr;
  const failure = publishFailure(record);
  if (failure)
    return {
      owner: "stopped",
      reason: { kind: "publish-failed", code: failure },
    } as const;
  if (goal.status === "cancelled")
    return { owner: "stopped", reason: { kind: "cancelled" } } as const;
  if (pr?.state === "merged")
    return {
      owner: goal.status === "done" ? "done" : "stopped",
      reason: { kind: "merged", prNumber: pr.number },
    } as const;
  if (pr?.state === "open") {
    const waiting =
      record?.prActionOutcome === "unknown" || pr.autoMerge !== "off";
    const canAct =
      !waiting && Object.keys(store.goalPrActions(goal.id)).length > 0;
    return {
      owner: waiting ? "ai" : canAct ? "human" : "stopped",
      reason: {
        kind: "pr-open",
        prNumber: pr.number,
        checks: pr.checks ?? null,
        autoMerge: pr.autoMerge,
      },
    } as const;
  }
  if (pr?.state === "closed")
    return {
      owner: "stopped",
      reason: { kind: "pr-closed", prNumber: pr.number },
    } as const;
  if (approvals > 0)
    return {
      owner: "human",
      reason: { kind: "approvals", count: approvals },
    } as const;
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
    if (
      head &&
      ((record && store.goalPublishEnabled) ||
        store.goalUsesAutomaticPublish(goal.id))
    )
      return { owner: "ai", reason: { kind: "publishing" } } as const;
    const exported = store.goalExported(goal.id);
    return {
      owner: "done",
      reason:
        head && exported?.head === head
          ? ({ kind: "exported", branch: exported.branch } as const)
          : ({ kind: exportable ? "exportable" : "completed" } as const),
    } as const;
  }
  return { owner: "idle", reason: { kind: "idle" } } as const;
}

function goalPublishView(store: OrchestratorStore, goal: Goal) {
  return publishView(
    store.goalPublishConfig,
    remoteGoalBranch(goal),
    store.goalPublishRecord(goal.id),
    store.goalAutoMerge(goal.id),
    store.goalIntegrationHead(goal.id) ?? goal.baseCommit,
  );
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
    publish: goalPublishView(store, goal),
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
    stage === "failed" ||
    stage === "cancelled" ||
    stage === "awaiting-host-check"
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
  const summary = goalSummary(
    store,
    goal,
    meanTaskWallTime(store.succeededTaskWallTimes()),
    store.goalTurnFacts([id]).get(id)!,
  );
  const expectedHead = store.goalIntegrationHead(id) ?? goal.baseCommit;
  const mergeCompletion = store.goalMergeCompletion(id);
  const pr = store.goalPublishRecord(id)?.pr;
  const canPublish =
    summary.publish.enabled &&
    goal.status !== "cancelled" &&
    summary.publish.state !== "merged" &&
    summary.publish.state !== "merged-stale" &&
    (!summary.publish.prNumber ||
      summary.publish.state === "closed" ||
      summary.publish.state === "failed") &&
    store.goalIsPublishReady(id);
  return {
    ...summary,
    ...(canPublish && expectedHead && { publishPreview: { expectedHead } }),
    ...(pr && { prState: pr.state }),
    ...(pr?.state === "open" && { prActions: store.goalPrActions(id) }),
    ...(mergeCompletion && { mergeCompletion }),
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
  const goal = store.getGoal(goalId)!;
  const pr = store.goalPublishRecord(goalId)?.pr;
  return {
    ...taskSummary(task, context),
    goalId,
    goalRef: goal.ref,
    ...(pr && { pullRequest: { prNumber: pr.number, prUrl: pr.url } }),
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

export async function readTaskVerificationNote(
  directory: string,
  { id, retries }: Pick<Task, "id" | "retries">,
  scan = builtInCredentialScanner,
): Promise<string | undefined> {
  const journal = taskJournal(directory, id, retries);
  try {
    const latest = (await journal.read()).findLast(
      (event) => event.kind === "verification.finished",
    );
    if (
      latest?.kind !== "verification.finished" ||
      latest.review === "pass" ||
      !latest.notes
    )
      return;
    const note = new TextDecoder("utf-8", { fatal: true }).decode(
      await journal.readNote(latest.notes, VERIFICATION_NOTE_LIMIT_BYTES),
    );
    await scan(note, JSON.stringify(note));
    return note;
  } catch {
    // A missing or withheld diagnostic leaves the Task detail available.
  }
}

export async function readOperatorTask(
  store: OrchestratorStore,
  directory: string,
  key: string,
  scan?: CredentialScanner,
) {
  const task = operatorTask(store, key);
  if (!task) return null;
  const verificationNote = await readTaskVerificationNote(
    directory,
    task,
    scan,
  );
  const hostChecks = store.hostCheckResults(task.id);
  const hostCheckJob = store.blockedHostCheck();
  return {
    ...task,
    ...(verificationNote ? { verificationNote } : {}),
    ...(hostChecks.length && { hostChecks }),
    ...(hostCheckJob && { hostCheckJob }),
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
