import {
  POLICY_INVARIANTS,
  resolveDelegation,
  validateDelegationRules,
} from "../../src/local-orchestrator/delegation.ts";
import { contentDigest } from "../../src/local-orchestrator/model.ts";
import { parsePanelAnswer } from "../../src/local-orchestrator/proposal-answer.ts";
import { credentialMaskMarker } from "../../src/local-orchestrator/proposal-screening.ts";
import { remoteGoalBranch } from "../../src/publish/journal.ts";
import {
  autoMergeMethods,
  publishDefaults,
  type MergeMethod,
} from "../../src/publish/port.ts";
import {
  goalMergeCompletionConfirmation,
  goalPublishConfirmation,
  goalPrConfirmation,
} from "../../src/publish/protocol.ts";
import {
  groupProblems,
  pendingDecisions,
  type ActivityRow,
  type AgentDecision,
  type GoalDetail,
  type GoalSummary,
  type Methods,
  type PanelInboxItem,
  type PolicySettings,
  type Problem,
  type Proposal,
  type Push,
  type TaskDetail,
  type TaskSummary,
} from "../../src/operator-ui/web/protocol.ts";
import { createHash } from "node:crypto";

export type PreviewMethods = {
  [M in keyof Methods]: (params: Methods[M]["params"]) => Methods[M]["result"];
};

const project = "papertrail";
const path = "src/receipts/**";
const importPath = "src/receipts/import.ts";
const budgets = { maxExecutionMs: 600_000, maxRetries: 2, maxTokens: 12_000 };
const scope = {
  paths: [path, "test/receipts/**"],
  profiles: ["bun"],
  actors: ["Planner", "Executor", "Reviewer"],
  maxTasks: 8,
  budgets,
} satisfies GoalDetail["scope"];
const baseCommit = "3".repeat(40);
const candidate = "7".repeat(40);
const nextBase = "4".repeat(40);
const environmentKey = "e".repeat(64);
const environmentConfirmation = "b".repeat(64);
const revision = "f".repeat(64);
const now = Date.now();
const minutesAgo = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString();
const estimate = (remainingMs: number | null) =>
  ({ remainingMs, basis: "current-plan" }) as const;

function progress(tasks: TaskSummary[]): GoalSummary["progress"] {
  return {
    total: tasks.length,
    done: tasks.filter(({ stage }) => stage === "done").length,
    failed: tasks.filter(({ stage }) => stage === "failed").length,
    cancelled: tasks.filter(({ stage }) => stage === "cancelled").length,
    running: tasks.filter(({ status }) => status === "running").length,
    awaitingIntegration: tasks.filter(
      ({ stage }) => stage === "awaiting-integration",
    ).length,
  };
}

function renewAutoMergeConfirmations(entry: GoalDetail) {
  for (const method of autoMergeMethods)
    entry.autoMergeConfirmations[method] = createHash("sha256")
      .update(entry.autoMergeConfirmations[method])
      .digest("hex");
}

function goal(
  ref: string,
  title: string,
  turn: GoalSummary["turn"],
): GoalDetail {
  const status =
    turn.reason.kind === "merged"
      ? "done"
      : turn.reason.kind === "cancelled"
        ? "cancelled"
        : "active";
  const exportable = turn.reason.kind === "exportable";
  const branch = `lo/goal-${ref.slice(1).padStart(8, "0")}`;
  const id = `goal-${ref}`;
  const { reason } = turn;
  return {
    id,
    ref,
    title,
    status,
    turn,
    createdAt: minutesAgo(58),
    progress: progress([]),
    estimate: estimate(null),
    description: `${title}。既存の領収書データとの互換性を保つ。`,
    acceptance: ["既存データと新しいデータの両方で確認できる。"],
    scope,
    budgets,
    baseCommit,
    branch,
    policyOverrides: { "task-registration": "inherit", integration: "inherit" },
    publish: {
      branch: remoteGoalBranch({ id, ref }),
      enabled: true,
      state: "pending",
      autoMerge: "off",
      autoMergeSource: "project",
    },
    autoMergeConfirmations: {
      off: "0".repeat(64),
      squash: "1".repeat(64),
      merge: "2".repeat(64),
      rebase: "3".repeat(64),
    },
    tasks: [],
    timeline: [],
    head: exportable || reason.kind === "exported" ? candidate : baseCommit,
    headAvailable: true,
    exportPreview: exportable
      ? { branch, from: null, to: candidate, target: project }
      : null,
    exportBlockReason: null,
  };
}

function task(
  parent: GoalDetail,
  number: number,
  title: string,
  stage: TaskSummary["stage"],
): TaskDetail {
  const ref = `${parent.ref}-${number}`;
  const status =
    stage === "done" ? "succeeded" : stage === "review" ? "running" : stage;
  return {
    id: `task-${ref}`,
    ref,
    goalId: parent.id,
    goalRef: parent.ref,
    title,
    stage,
    status,
    retries: 0,
    attempt: { current: stage === "registered" ? 0 : 1, max: 3 },
    elapsedMs: stage === "registered" ? 0 : 160_000,
    estimate: estimate(
      stage === "done" ? 0 : stage === "failed" ? null : 240_000,
    ),
    description: `${title}。入力が欠けている場合も画面を操作できるようにする。`,
    acceptance: ["空の入力と通常の入力で動作を確認する。"],
    actor: "Executor",
    category: "feature",
    paths: [importPath],
    budgets,
    integrationPolicy: "rule",
    effectiveIntegrationPolicy: { source: "default", policy: "human" },
    tokensUsed: stage === "registered" ? 0 : 4380,
    tokensIncomplete: false,
    executions: [],
    events: [
      {
        kind: stage === "done" ? "task.integrated" : "task.status",
        at: minutesAgo(2),
      },
      { kind: "task.registered", at: minutesAgo(6) },
    ],
  };
}

function summary(details: TaskDetail): TaskSummary {
  const {
    id,
    ref,
    title,
    status,
    stage,
    retries,
    attempt,
    elapsedMs,
    estimate,
    verification,
    failureStage,
    failure,
  } = details;
  return {
    id,
    ref,
    title,
    status,
    stage,
    ...(verification && { verification }),
    ...(failure && { failureStage: failureStage ?? failure.stage }),
    retries,
    attempt,
    elapsedMs,
    estimate,
  };
}

function proposalFixtures(main: GoalDetail, active: GoalDetail) {
  const text = {
    description:
      "検索条件に店舗名を追加し、保存した条件から検索を再開できるようにします。",
    acceptance: [
      "条件を保存し、次回に復元できる。",
      "空の条件でも検索できる。",
    ],
  };
  const common = {
    status: "pending",
    effectivePolicy: "human",
    policySource: "default",
    origin: { kind: "actor", actor: "Planner" },
    loosening: [] as never[],
    pathViolations: [] as never[],
    budgets,
  } as const;
  const goalProposal = {
    ...common,
    id: "proposal-filter-goal",
    digest: "1".repeat(64),
    kind: "goal",
    ref: null,
    goalRef: null,
    taskRef: null,
    gate: "goal-registration",
    origin: { kind: "actor", actor: "Concierge" },
    policySource: "invariant",
    invariant: "concierge-proposal",
    humanAnswerRequired: true,
    diffStat: null,
    modelText: text,
    ...scope,
  } satisfies Proposal;
  const taskProposal = {
    ...common,
    id: "proposal-filter-task",
    digest: "2".repeat(64),
    kind: "task",
    ref: main.ref,
    goalRef: main.ref,
    taskRef: null,
    gate: "task-registration",
    diffStat: null,
    modelText: {
      description:
        "日付指定のない CSV ファイルに対応する境界値テストを追加します。",
      acceptance: ["日付列が空のサンプルを読み込める。"],
    },
    paths: ["test/receipts/import.test.ts", "test/receipts/fixtures/"],
    actor: "Executor",
    profile: "bun",
  } satisfies Proposal;
  const integration = {
    ...common,
    id: "proposal-import-integration",
    digest: "3".repeat(64),
    kind: "integration",
    ref: `${main.ref}-4`,
    goalRef: main.ref,
    taskRef: `${main.ref}-4`,
    gate: "integration",
    origin: { kind: "host" },
    diffStat:
      "src/receipts/import.ts | 18 ++++++++++++++----\n1 file changed, 14 insertions(+), 4 deletions(-)",
    changedPaths: [importPath],
    changedFiles: 1,
    changedLines: 18,
    reviewExecutionId: "review-import",
    modelText: {
      verdict: "pass",
      findings: "列の並び順が変わったときも既存データを読めます。",
    },
  } satisfies Proposal;
  return [
    { proposal: goalProposal, title: "領収書の検索条件を保存する" },
    { proposal: taskProposal, title: "CSV の空欄をテストする" },
    { proposal: integration, title: "インポートの列名を照合する" },
    {
      proposal: {
        ...taskProposal,
        id: "proposal-out-of-scope",
        digest: "4".repeat(64),
        policySource: "invariant",
        invariant: "scope-exception",
        humanAnswerRequired: true,
        paths: ["src/shared/dates.ts"],
        pathViolations: ["src/shared/dates.ts"],
        modelText: {
          description: "共通の日付変換器を変更します。",
          acceptance: ["タイムゾーンを含む日付を扱える。"],
        },
      },
      title: "共通の日付変換器を更新する",
    },
    {
      proposal: {
        ...taskProposal,
        id: "proposal-loosen-policy",
        digest: "5".repeat(64),
        policySource: "invariant",
        invariant: "policy-loosening",
        humanApprovalRequired: true,
        loosening: ["integration"],
        modelText: {
          description:
            "テンプレートの更新と一緒に、統合の判断を AI に委ねるポリシーを提案します。",
          acceptance: ["新しいテンプレートで合計金額を表示できる。"],
        },
      },
      title: "テンプレート更新の統合を AI に委ねる",
    },
    {
      proposal: {
        ...taskProposal,
        id: "proposal-masked",
        digest: "b".repeat(64),
        maskedFields: ["description"],
        modelText: {
          ...taskProposal.modelText,
          description:
            `接続例にある sk-ant-${"x".repeat(30)} を環境変数に置き換えます。`.replace(
              /sk-ant-x{30}/,
              credentialMaskMarker,
            ),
        },
      },
      title: "接続例を更新する",
    },
    {
      proposal: {
        ...taskProposal,
        id: "proposal-withheld",
        digest: "6".repeat(64),
        modelText: {
          ...taskProposal.modelText,
          description: { withheld: true },
        },
      },
      title: "仕入先の識別子を整理する",
    },
    {
      proposal: {
        ...taskProposal,
        id: "proposal-agent-task",
        digest: "7".repeat(64),
        ref: active.ref,
        goalRef: active.ref,
        effectivePolicy: "agent",
        policySource: "rule",
        ruleId: "small-tests",
        ruleName: "小さなテストの登録",
      },
      title: "小数値を読み込むフィクスチャを追加する",
    },
    {
      proposal: {
        ...integration,
        id: "proposal-agent-integration",
        digest: "8".repeat(64),
        ref: `${active.ref}-2`,
        goalRef: active.ref,
        taskRef: `${active.ref}-2`,
        effectivePolicy: "agent",
        policySource: "operator-goal",
      },
      title: "金額セルの書式をそろえる",
    },
    {
      proposal: {
        ...integration,
        id: "proposal-review-concern",
        digest: "9".repeat(64),
        ref: `${active.ref}-2`,
        goalRef: active.ref,
        taskRef: `${active.ref}-2`,
        diffStat: "src/receipts/import.ts | 18 ++++++++++++++----",
        modelText: {
          verdict: "concern",
          findings: "丸め処理の確認が必要です。",
        },
      },
      title: "月次レポートの丸め処理を確認する",
    },
  ] satisfies { proposal: Proposal; title: string }[];
}

export function createPreviewMethods(
  publish: (push: Push) => void,
  stop: () => void,
): PreviewMethods {
  const publishConfig = { ...publishDefaults, enabled: true };
  let nextPr = 20;
  function pr(number: number) {
    return {
      prNumber: number,
      prUrl: `https://github.com/example/example/pull/${number}`,
    };
  }
  function updatePrActions(entry: GoalDetail) {
    const { prNumber } = entry.publish;
    if (entry.prState !== "open" || entry.status !== "active" || !prNumber) {
      delete entry.prActions;
      return;
    }
    const current = {
      number: prNumber,
      head: entry.head ?? candidate,
      ...(entry.publish.checks !== undefined && {
        checks: entry.publish.checks,
      }),
    };
    entry.prActions = {
      merge: {
        squash: goalPrConfirmation(entry.ref, current, "squash"),
        merge: goalPrConfirmation(entry.ref, current, "merge"),
        rebase: goalPrConfirmation(entry.ref, current, "rebase"),
      },
      close: goalPrConfirmation(entry.ref, current, "close"),
      autoMerge: entry.autoMergeConfirmations,
    };
  }

  function publishGoal(
    ref: string,
    title: string,
    turn: GoalSummary["turn"],
    details: Partial<GoalDetail["publish"]>,
  ) {
    const entry = goal(ref, title, turn);
    Object.assign(entry.publish, {
      enabled: publishConfig.enabled,
      lastCheckedAt: minutesAgo(2),
      base: publishConfig.base,
      mergeMethod: publishConfig.mergeMethod,
      ...details,
    });
    entry.head = candidate;
    if (entry.publish.prNumber) {
      entry.prState =
        entry.publish.state === "closed"
          ? "closed"
          : entry.publish.state === "merged" ||
              entry.publish.state === "merged-stale"
            ? "merged"
            : "open";
    }
    if (entry.publish.state === "merged-stale" && entry.publish.prNumber) {
      entry.status = "active";
      const prNumber = entry.publish.prNumber;
      entry.mergeCompletion = {
        prNumber,
        mergedHead: baseCommit,
        goalHead: candidate,
        confirm: goalMergeCompletionConfirmation(ref, prNumber, baseCommit),
      };
    }
    if (["pushing", "closed", "failed"].includes(entry.publish.state))
      entry.publishPreview = { expectedHead: candidate };
    updatePrActions(entry);
    return entry;
  }
  const main = goal("G1", "領収書の CSV インポートを改善する", {
    owner: "human",
    reason: { kind: "approvals", count: 5 },
  });
  const active = goal("G2", "月次レポートを整える", {
    owner: "ai",
    reason: { kind: "running", actor: "Executor", taskRef: "G2-1" },
  });
  active.policyOverrides.integration = "agent";
  const idle = goal("G3", "支払い方法ごとの集計を検討する", {
    owner: "idle",
    reason: { kind: "not-planned" },
  });
  const stopped = goal("G4", "旧形式の領収書を変換する", {
    owner: "stopped",
    reason: { kind: "failed", taskRef: "G4-1", code: "verification-failed" },
  });
  const stoppedTask = task(stopped, 1, "旧形式のサンプルを検証する", "failed");
  stoppedTask.verification = true;
  stoppedTask.failure = {
    code: "verification-failed",
    stage: "review",
    next: "検証ログで旧形式の列を確認してください。",
  };
  const exportable = goal("G5", "領収書のプレビューを印刷に対応させる", {
    owner: "done",
    reason: { kind: "exportable" },
  });
  const processing = goal("G9", "領収書の集計を自動化する", {
    owner: "ai",
    reason: { kind: "running", actor: "Executor", taskRef: "G9-1" },
  });
  const goals = [
    main,
    active,
    idle,
    stopped,
    exportable,
    goal("G6", "レシート一覧の読み込みを速くする", {
      owner: "done",
      reason: { kind: "exported", branch: "lo/goal-00000006" },
    }),
    publishGoal(
      "G7",
      "重複した取引の警告を追加する",
      {
        owner: "done",
        reason: { kind: "merged", prNumber: 1 },
      },
      { state: "merged", checks: "passed", ...pr(1) },
    ),
    goal("G8", "税率の表示を揃える", {
      owner: "done",
      reason: { kind: "completed" },
    }),
    processing,
    publishGoal(
      "G10",
      "レシートを月ごとにまとめる",
      {
        owner: "ai",
        reason: { kind: "publishing" },
      },
      { state: "pushing" },
    ),
    publishGoal(
      "G11",
      "支払い先でレシートを探す",
      {
        owner: "human",
        reason: {
          kind: "pr-open",
          prNumber: 12,
          checks: "passed",
          autoMerge: "off",
        },
      },
      {
        state: "pr-open",
        checks: "passed",
        mergeable: "clean",
        review: "approved",
        checkRuns: ["build", "test", "lint", "typecheck", "format"].map(
          (name) => ({ name, state: "pass" }),
        ),
        additions: 57,
        deletions: 4,
        changedFiles: 3,
        ...pr(12),
      },
    ),
    publishGoal(
      "G12",
      "税率の一覧を更新する",
      {
        owner: "human",
        reason: {
          kind: "pr-open",
          prNumber: 13,
          checks: "failed",
          autoMerge: "off",
        },
      },
      {
        state: "pr-open",
        checks: "failed",
        mergeable: "clean",
        review: "changes-requested",
        checkRuns: [
          { name: "build", state: "pass" },
          { name: "test", state: "fail" },
        ],
        additions: 22,
        deletions: 2,
        changedFiles: 2,
        ...pr(13),
      },
    ),
    publishGoal(
      "G13",
      "会計用の書き出し項目を加える（リモートブランチ削除済み）",
      {
        owner: "stopped",
        reason: { kind: "pr-closed", prNumber: 14 },
      },
      { state: "closed", ...pr(14) },
    ),
    publishGoal(
      "G14",
      "レシートにメモを追加する",
      {
        owner: "stopped",
        reason: { kind: "publish-failed", code: "auto-merge-disarm-failed" },
      },
      {
        state: "failed",
        checks: "pending",
        failure: "auto-merge-disarm-failed",
        autoMerge: "squash",
        autoMergeEnabled: "squash",
        ...pr(15),
      },
    ),
    publishGoal(
      "G15",
      "精算レポートの集計を見直す",
      { owner: "stopped", reason: { kind: "merged", prNumber: 16 } },
      { state: "merged-stale", checks: "passed", ...pr(16) },
    ),
    publishGoal(
      "G16",
      "領収書の添付を整理する",
      {
        owner: "human",
        reason: {
          kind: "pr-open",
          prNumber: 17,
          checks: "pending",
          autoMerge: "off",
        },
      },
      {
        state: "pr-open",
        checks: "pending",
        mergeable: "clean",
        review: "none",
        checkRuns: ["build", "lint", "format", "test", "typecheck"].map(
          (name, i) => ({ name, state: i < 3 ? "pass" : "pending" }),
        ),
        additions: 18,
        deletions: 9,
        changedFiles: 2,
        autoMergeUnavailable: true,
        ...pr(17),
      },
    ),
    publishGoal(
      "G17",
      "取引の並び順を調整する",
      {
        owner: "human",
        reason: {
          kind: "pr-open",
          prNumber: 18,
          checks: "passed",
          autoMerge: "off",
        },
      },
      { state: "pr-open", checks: "passed", mergeable: "conflict", ...pr(18) },
    ),
    publishGoal(
      "G18",
      "精算の締め日を設定できるようにする",
      {
        owner: "ai",
        reason: {
          kind: "pr-open",
          prNumber: 19,
          checks: "pending",
          autoMerge: "squash",
        },
      },
      {
        state: "pr-open",
        checks: "pending",
        mergeable: "clean",
        autoMerge: "squash",
        autoMergeEnabled: "squash",
        checkRuns: [{ name: "test", state: "pending" }],
        ...pr(19),
      },
    ),
  ];
  const disarmFailed = goals.find(({ ref }) => ref === "G14")!;
  disarmFailed.status = "cancelled";
  updatePrActions(disarmFailed);
  main.baseUpdatePreview = { from: baseCommit, to: nextBase };
  main.policyOverrides["task-registration"] = "human";
  exportable.policyOverrides.integration = "human";
  const earlierFailure = task(
    exportable,
    2,
    "旧形式の余白を確認する",
    "failed",
  );
  const failed = task(main, 5, "旧 CSV の日付表記を変換する", "failed");
  const rejectedPaths = [{ path: "src/shared/dates.ts", symlink: false }];
  failed.failure = { code: "path-violation", stage: "running", rejectedPaths };
  earlierFailure.failure = { code: "verification-failed", stage: "review" };
  failed.events.unshift({ kind: "task.status", at: minutesAgo(1) });
  main.timeline = [
    {
      kind: "approved",
      at: minutesAgo(43),
      ref: main.ref,
      proposalKind: "goal",
    },
    {
      kind: "rejected",
      at: minutesAgo(16),
      ref: "G1-4",
      proposalKind: "integration",
    },
    { kind: "integrated", at: minutesAgo(20), ref: "G1-1", proposalKind: null },
  ];
  exportable.timeline = [
    { kind: "exported", at: minutesAgo(12), ref: null, proposalKind: null },
    { kind: "integrated", at: minutesAgo(30), ref: "G5-1", proposalKind: null },
  ];
  const verifying = task(main, 7, "文字コードを検証する", "review");
  verifying.verification = true;
  const tasks = [
    stoppedTask,
    task(main, 1, "サンプル CSV を追加する", "done"),
    task(main, 2, "空欄の扱いを確認する", "running"),
    task(main, 3, "列の並び順を検証する", "review"),
    task(main, 4, "インポートの列名を照合する", "awaiting-integration"),
    failed,
    task(main, 6, "エラーの表示を更新する", "registered"),
    verifying,
    task(active, 1, "月次の合計金額を計算する", "running"),
    task(active, 2, "金額セルの書式をそろえる", "awaiting-integration"),
    ...goals
      .filter(
        ({ turn, publish }) =>
          turn.owner === "done" || publish.state !== "pending",
      )
      .map((entry) => task(entry, 1, entry.title, "done")),
    task(processing, 1, "日別の合計金額を集計する", "running"),
    earlierFailure,
    task(exportable, 3, "印刷幅の指定を見直す", "cancelled"),
  ];
  const problem: Problem = {
    kind: "path-violation",
    code: "path-violation",
    canRetry: true,
    expectedRetries: failed.retries,
    ref: failed.ref,
    taskRef: failed.ref,
    goalRef: failed.goalRef,
    taskId: failed.id,
    goalId: failed.goalId,
    title: failed.title,
    detail: "許可された範囲の外にあるファイルを変更しました。再試行できます。",
    rejectedPaths,
    at: minutesAgo(1),
  };
  const exportProblem: Problem = {
    kind: "task-failed",
    code: "verification-failed",
    canRetry: false,
    expectedRetries: earlierFailure.retries,
    ref: earlierFailure.ref,
    taskRef: earlierFailure.ref,
    goalRef: earlierFailure.goalRef,
    taskId: earlierFailure.id,
    goalId: earlierFailure.goalId,
    title: earlierFailure.title,
    detail: "旧形式の確認に失敗しました。",
    at: minutesAgo(8),
  };
  const examples = proposalFixtures(main, active);
  const proposals: Proposal[] = examples.map(({ proposal }) => proposal);
  const rows: PanelInboxItem[] = examples.map(({ proposal, title }, index) => {
    const parent = goals.find(({ ref }) => ref === proposal.goalRef);
    const subjectTask = tasks.find(({ ref }) => ref === proposal.taskRef);
    const takeover = proposal.effectivePolicy === "agent";
    return {
      id: `inbox-${proposal.id}`,
      kind: proposal.gate,
      weight: "action",
      title,
      modelText: title,
      at: minutesAgo(index + 1),
      next: `agent-bootstrap show ${proposal.id}`,
      subject: {
        proposalId: proposal.id,
        ...(parent && {
          goalId: parent.id,
          goalRef: parent.ref,
          ref: parent.ref,
        }),
        ...(subjectTask && {
          taskId: subjectTask.id,
          taskRef: subjectTask.ref,
          ref: subjectTask.ref,
        }),
      },
      state: "open",
      answer: {
        id: proposal.id,
        kind: proposal.kind,
        digest: proposal.digest,
        title,
        agentGates: proposal.loosening,
        approve: !takeover && proposal.id !== "proposal-review-concern",
        reject: !takeover,
        ...(takeover && { takeover: true }),
      },
    };
  });
  rows.push(
    {
      id: "inbox-path-violation",
      kind: "task-failed",
      weight: "action",
      state: "open",
      subject: {
        goalId: main.id,
        goalRef: main.ref,
        taskId: failed.id,
        taskRef: failed.ref,
        ref: failed.ref,
      },
      title: "対象パスが許可範囲外です。",
      modelText: failed.title,
      at: minutesAgo(1),
      next: `agent-bootstrap retry-task ${failed.ref}`,
    },
    ...tasks
      .filter(({ ref }) => ["G1-1", "G1-2", "G5-1"].includes(ref))
      .map((entry): PanelInboxItem => ({
        id: `activity-${entry.id}`,
        kind: entry.stage === "done" ? "task-succeeded" : "task-running",
        weight: "info",
        state: "open",
        subject: {
          goalId: entry.goalId,
          goalRef: entry.goalRef,
          taskId: entry.id,
          taskRef: entry.ref,
          ref: entry.ref,
        },
        title: entry.title,
        modelText: entry.title,
        at: minutesAgo(4),
        next: `agent-bootstrap show ${entry.ref}`,
      })),
  );

  const rules = [
    {
      id: "small-tests",
      name: "小さなテストの登録",
      gate: "task-registration",
      action: "agent",
      enabled: true,
      order: 0,
      hitsLast7Days: 4,
      conditions: {
        pathsWithin: ["test/**"],
        maxTokens: 8000,
        categories: ["test"],
      },
    },
    {
      id: "protected-import",
      name: "CSV の変更は人が確認する",
      gate: "integration",
      action: "human",
      enabled: true,
      order: 1,
      hitsLast7Days: 2,
      conditions: { pathsWithin: [path] },
    },
  ] satisfies PolicySettings["rules"];
  const policy: PolicySettings = {
    defaults: {
      "goal-registration": "human",
      "task-registration": "human",
      integration: "human",
    },
    explicitDefaults: ["task-registration", "integration"],
    rulesRevision: contentDigest(rules),
    rules,
    invariants: POLICY_INVARIANTS,
  };
  const history: AgentDecision[] = [
    {
      id: "decision-example-test",
      proposalId: "resolved-example-test",
      gate: "task-registration",
      result: "approve",
      at: minutesAgo(20),
      goalId: active.id,
      taskId: null,
      ref: active.ref,
      goalRef: active.ref,
      taskRef: null,
      setting: {
        policy: "agent",
        source: "rule",
        ruleId: "small-tests",
        ruleName: "小さなテストの登録",
      },
      reasons: ["テストの変更が許可された範囲と予算に収まっています。"],
    },
    {
      id: "decision-example-report",
      proposalId: "resolved-example-report",
      gate: "integration",
      result: "reject",
      at: minutesAgo(30),
      goalId: active.id,
      taskId: tasks.find(({ ref }) => ref === "G2-1")!.id,
      ref: "G2-1",
      goalRef: active.ref,
      taskRef: "G2-1",
      setting: { policy: "agent", source: "operator-goal" },
      reasons: ["差分に不要な表示文言の変更が含まれています。"],
    },
  ];

  const activeTurn = active.turn;

  function listGoals() {
    const decisions = pendingDecisions(rows);
    return goals.map((entry) => {
      entry.tasks = tasks
        .filter(({ goalId }) => goalId === entry.id)
        .map(summary);
      entry.progress = progress(entry.tasks);
      if (
        entry.status === "active" &&
        entry.publish.state === "pending" &&
        entry.progress.total > 0 &&
        entry.progress.total === entry.progress.done &&
        entry.head
      )
        entry.publishPreview = { expectedHead: entry.head };
      entry.estimate = estimate(
        entry.status === "active" && entry.progress.total
          ? (entry.progress.total - entry.progress.done) * 180_000
          : null,
      );
      const count = decisions.filter(
        (row) =>
          row.subject.goalId === entry.id &&
          "answer" in row &&
          (row.answer.approve || row.answer.reject),
      ).length;
      if (count) {
        entry.turn = { owner: "human", reason: { kind: "approvals", count } };
      } else if (entry === active && entry.status === "active") {
        entry.turn = activeTurn;
      } else if (entry === main && entry.status === "active") {
        entry.turn =
          failed.status === "failed"
            ? {
                owner: "stopped",
                reason: {
                  kind: "failed",
                  taskRef: failed.ref,
                  code: "path-violation",
                },
              }
            : { owner: "ai", reason: { kind: "queued" } };
      }
      return entry;
    });
  }

  function find<T extends { id: string; ref?: string | null }>(
    entries: T[],
    id: string,
  ) {
    const entry = entries.find((row) => row.id === id || row.ref === id);
    if (!entry) throw new PreviewError("not-found");
    return entry;
  }

  const seenPullRequests = new Set<string>();

  function pullRequestRowId(entry: GoalDetail) {
    return `pr-merge:${entry.id}:${entry.publish.prNumber}`;
  }

  function pullRequestRows(): PanelInboxItem[] {
    return goals.flatMap((entry): PanelInboxItem[] => {
      if (entry.status !== "active" || entry.prState !== "open") return [];
      const id = pullRequestRowId(entry);
      return [
        {
          id,
          kind: entry.publish.autoMergeEnabled ? "pr-auto-merge" : "pr-merge",
          weight: "action",
          state: seenPullRequests.has(id) ? "seen" : "open",
          subject: { goalId: entry.id, ref: entry.ref, goalRef: entry.ref },
          title: entry.title,
          next: `merge-goal ${entry.ref}`,
          at: entry.publish.lastCheckedAt ?? null,
          pullRequest: {
            publish: entry.publish,
            actions: entry.prActions ?? {},
          },
        },
      ];
    });
  }

  function finishPullRequest(
    id: string,
    method: MergeMethod | "close",
    confirm: string,
  ) {
    const entry = find(goals, id);
    const { prNumber } = entry.publish;
    if (entry.prState !== "open" || !prNumber || entry.status !== "active")
      throw new PreviewError("invalid-transition");
    const expected =
      method === "close"
        ? entry.prActions?.close
        : entry.prActions?.merge?.[method];
    if (confirm !== expected) throw new PreviewError("stale-confirmation");
    const closed = method === "close";
    entry.prState = closed ? "closed" : "merged";
    entry.publish.state = entry.prState;
    delete entry.publish.autoMergeEnabled;
    delete entry.publish.autoMergeUnavailable;
    if (!closed) entry.status = "done";
    else if (entry.head) entry.publishPreview = { expectedHead: entry.head };
    entry.turn = closed
      ? { owner: "stopped", reason: { kind: "pr-closed", prNumber } }
      : { owner: "done", reason: { kind: "merged", prNumber } };
    updatePrActions(entry);
    changed([pullRequestRowId(entry)]);
    return {
      ...entry.publish,
      ...(!closed && { goalCompleted: true as const }),
    };
  }

  function activity() {
    const rowsForTasks: ActivityRow[] = tasks.flatMap((entry) => {
      const parent = find(goals, entry.goalId);
      if (
        parent.status !== "active" ||
        !["registered", "running"].includes(entry.status)
      )
        return [];
      const reviewing = entry.stage === "review";
      return [
        {
          id: `activity-${entry.id}`,
          actor: reviewing ? "Reviewer" : entry.actor,
          mode: reviewing ? "review" : "task",
          status: entry.status === "running" ? "running" : "registered",
          goalId: parent.id,
          goalRef: parent.ref,
          goalTitle: parent.title,
          taskId: entry.id,
          taskRef: entry.ref,
          taskTitle: entry.title,
          startedAt: entry.status === "running" ? minutesAgo(3) : null,
        },
      ];
    });
    const running = rowsForTasks.filter(({ status }) => status === "running");
    const queued = rowsForTasks.filter(({ status }) => status !== "running");
    return {
      running,
      queued,
      queuedCount: queued.length,
      yourTurn:
        pendingDecisions([...rows, ...pullRequestRows()]).length +
        groupProblems(problems()).length,
    };
  }

  function problems(includeResolved = false) {
    const open = failed.status === "failed" && main.status !== "cancelled";
    return [
      ...(open || includeResolved ? [{ ...problem, canRetry: open }] : []),
      exportProblem,
    ];
  }

  function changed(ids: string[] = []) {
    if (ids.length) publish({ method: "inbox.changed", params: { ids } });
    publish({ method: "activity.changed", params: {} });
  }

  function closeRow(row: PanelInboxItem) {
    row.state = "resolved";
    if ("answer" in row) Reflect.deleteProperty(row, "answer");
    row.next = `agent-bootstrap show ${row.subject.proposalId ?? row.subject.taskRef}`;
  }

  function answer(input: Methods["proposal.answer"]["params"]) {
    const { id, digest, decision, takeover } = parsePanelAnswer(input);
    const proposal = proposals.find((entry) => entry.id === id);
    const row = rows.find((entry) => entry.subject.proposalId === id);
    if (!proposal || !row) throw new AnswerFailure("not-found");
    if (proposal.digest !== digest) throw new AnswerFailure("stale-digest");
    if (proposal.status !== "pending" || !("answer" in row))
      throw new AnswerFailure("invalid-transition");
    if (
      takeover !== row.answer.takeover ||
      (!takeover && !row.answer[decision])
    )
      throw new AnswerFailure("approval-forbidden");
    if (decision === "approve" && proposal.id === "proposal-withheld")
      throw new AnswerFailure("write-failed");

    proposal.status = decision === "approve" ? "approved" : "rejected";
    if (decision === "approve") {
      if (proposal.kind === "goal") {
        const created = goal(`G${goals.length + 1}`, row.title, {
          owner: "idle",
          reason: { kind: "not-planned" },
        });
        goals.push(created);
        proposal.ref =
          proposal.goalRef =
          row.subject.ref =
          row.subject.goalRef =
            created.ref;
        row.subject.goalId = created.id;
      } else if (proposal.kind === "task") {
        const parent = find(goals, proposal.goalRef ?? "");
        const created = task(
          parent,
          tasks.filter(({ goalId }) => goalId === parent.id).length + 1,
          row.title,
          "registered",
        );
        tasks.push(created);
        proposal.taskRef = row.subject.taskRef = created.ref;
        row.subject.taskId = created.id;
      } else {
        const integrated = find(tasks, proposal.taskRef ?? "");
        integrated.status = "succeeded";
        integrated.stage = "done";
        integrated.estimate = estimate(0);
        integrated.events.unshift({
          kind: "task.integrated",
          at: new Date().toISOString(),
        });
      }
    }
    const parent = goals.find(({ id }) => id === row.subject.goalId);
    if (parent) {
      const at = new Date().toISOString();
      if (decision === "approve" && proposal.kind === "integration")
        parent.timeline.unshift({
          kind: "integrated",
          at,
          ref: row.subject.taskRef ?? null,
          proposalKind: null,
        });
      parent.timeline.unshift({
        kind: decision === "approve" ? "approved" : "rejected",
        at,
        ref: row.subject.taskRef ?? parent.ref,
        proposalKind: proposal.kind,
      });
    }
    closeRow(row);
    changed([row.id]);
    return { id, ok: true } as const;
  }

  const environment: Methods["environment.status"]["result"] = {
    status: { key: environmentKey, state: "missing", hasLock: true, size: 0 },
    build: null,
  };
  const settingsReceipt = { ok: true } as const;
  return {
    status: () => {
      const pending = proposals
        .filter(({ status }) => status === "pending")
        .map((proposal) => {
          const {
            id,
            ref,
            goalRef,
            taskRef,
            kind,
            gate,
            effectivePolicy,
            policySource,
            loosening,
            invariant,
            humanApprovalRequired,
            humanAnswerRequired,
          } = proposal;
          const row = rows.find(({ subject }) => subject.proposalId === id)!;
          return {
            id,
            ref,
            goalRef,
            taskRef,
            kind,
            gate,
            effectivePolicy,
            policySource,
            loosening,
            ...(invariant && { invariant }),
            ...(humanApprovalRequired && { humanApprovalRequired }),
            ...(humanAnswerRequired && { humanAnswerRequired }),
            ...(kind === "integration"
              ? { goalId: row.subject.goalId!, taskId: row.subject.taskId! }
              : { title: row.title }),
          };
        });
      return {
        project,
        repositoryPath: `examples/${project}`,
        counts: {
          goals: goals.length,
          tasks: tasks.length,
          proposals: proposals.length,
          pending: pending.length,
        },
        pending,
        recentExecutions: [],
        recentTasks: [],
        publish: { ...publishConfig },
      };
    },
    "policy.get": () => policy,
    "policy.setDefault": ({ gate, policy: value }) => {
      policy.defaults[gate] = value;
      if (!policy.explicitDefaults.includes(gate))
        policy.explicitDefaults.push(gate);
      changed();
      return settingsReceipt;
    },
    "policy.setRules": ({ rules, expectedRevision }) => {
      if (
        expectedRevision !== undefined &&
        expectedRevision !== policy.rulesRevision
      )
        throw new PreviewError("stale-policy");
      const validated = validateDelegationRules(rules);
      policy.rules = validated.map((rule) => ({
        ...rule,
        hitsLast7Days:
          policy.rules.find(({ id }) => id === rule.id)?.hitsLast7Days ?? 0,
      }));
      policy.rulesRevision = contentDigest(validated);
      changed();
      return settingsReceipt;
    },
    "goal.setPolicy": ({ goalId, gate, value, expected }) => {
      const entry = find(goals, goalId);
      if (expected !== undefined && entry.policyOverrides[gate] !== expected)
        throw new PreviewError("stale-policy");
      entry.policyOverrides[gate] = value;
      changed();
      return settingsReceipt;
    },
    "task.setIntegrationPolicy": ({ taskId, value, expected }) => {
      const entry = find(tasks, taskId);
      if (expected !== undefined && entry.integrationPolicy !== expected)
        throw new PreviewError("stale-policy");
      entry.integrationPolicy = value;
      changed();
      return settingsReceipt;
    },
    "decision.history": ({ limit = 20 }) => history.slice(0, limit),
    "inbox.list": ({ includeResolved }) => [
      ...pullRequestRows(),
      ...rows.filter(({ state }) => includeResolved || state !== "resolved"),
    ],
    "inbox.subscribe": () => ({ subscribed: true }),
    "inbox.markSeen": ({ ids }) => {
      for (const row of pullRequestRows())
        if (ids.includes(row.id)) seenPullRequests.add(row.id);
      const seen = rows.filter(
        ({ id, state }) => state === "open" && ids.includes(id),
      );
      for (const row of seen) row.state = "seen";
      if (seen.length)
        publish({
          method: "inbox.changed",
          params: { ids: seen.map(({ id }) => id) },
        });
      return { marked: seen.length };
    },
    "proposal.get": ({ id }) => {
      const proposal = proposals.find((entry) => entry.id === id);
      if (!proposal) throw new PreviewError("not-found");
      return proposal;
    },
    "proposal.answer": answer,
    "proposal.answerMany": ({ answers }) => {
      if (!Array.isArray(answers) || !answers.length || answers.length > 20)
        throw new PreviewError("invalid-params");
      const parsed = answers.map(parsePanelAnswer);
      if (parsed.some(({ takeover }) => takeover))
        throw new PreviewError("invalid-params");
      return parsed.map((entry) => {
        try {
          return answer(entry);
        } catch (error) {
          return {
            id: entry.id,
            error: {
              code:
                error instanceof AnswerFailure ? error.code : "write-failed",
            },
          };
        }
      });
    },
    "goal.list": ({ status }) =>
      listGoals()
        .filter((entry) => !status || entry.status === status)
        .map(
          ({
            id,
            ref,
            title,
            status,
            createdAt,
            turn,
            publish,
            progress,
            estimate,
          }) => ({
            id,
            ref,
            title,
            status,
            createdAt,
            turn,
            publish,
            progress,
            estimate,
          }),
        ),
    "activity.get": activity,
    "activity.subscribe": () => ({ subscribed: true }),
    "task.retry": ({ id, expectedRetries }) => {
      const entry = find(tasks, id);
      if (entry.retries !== expectedRetries)
        throw new PreviewError("task-retry-changed");
      if (entry.status !== "failed")
        throw new PreviewError("invalid-transition");
      if (find(goals, entry.goalId).status === "cancelled")
        throw new PreviewError("goal-inactive");
      entry.stage = entry.status = "registered";
      entry.attempt.current = entry.elapsedMs = 0;
      entry.estimate = estimate(240_000);
      entry.retries++;
      delete entry.failure;
      entry.events.unshift({
        kind: "task.retried",
        at: new Date().toISOString(),
      });
      const resolved = find(rows, "inbox-path-violation");
      closeRow(resolved);
      changed([resolved.id]);
      return {
        id: entry.id,
        ref: entry.ref,
        status: "registered",
        retries: entry.retries,
      };
    },
    "goal.discard": ({ id, confirm, expectedHead, expectedClosedPrNumber }) => {
      const entry = find(goals, id);
      if (
        expectedClosedPrNumber !== undefined &&
        (entry.prState !== "closed" ||
          entry.publish.prNumber !== expectedClosedPrNumber)
      )
        throw new PreviewError("stale-confirmation");
      if (expectedHead !== entry.head) throw new PreviewError("stale-base");
      if (confirm !== entry.ref)
        throw new PreviewError("confirmation-mismatch");
      if (entry.status !== "active")
        throw new PreviewError("invalid-transition");
      entry.status = "cancelled";
      entry.turn = { owner: "stopped", reason: { kind: "cancelled" } };
      delete entry.publishPreview;
      delete entry.baseUpdatePreview;
      const closed = rows.filter(
        (row) => row.subject.goalId === entry.id && row.weight === "action",
      );
      for (const row of closed) {
        const proposal = proposals.find(
          ({ id }) => id === row.subject.proposalId,
        );
        if (proposal?.status === "pending") proposal.status = "rejected";
        closeRow(row);
      }
      for (const entryTask of tasks.filter(
        ({ goalId }) => goalId === entry.id,
      )) {
        if (entryTask.status === "succeeded") continue;
        entryTask.status = entryTask.stage = "cancelled";
        entryTask.estimate = estimate(null);
        delete entryTask.failure;
      }
      changed(closed.map(({ id }) => id));
      return { id: entry.id, ref: entry.ref, status: "cancelled" };
    },
    "goal.completeAfterMerge": ({ id, confirm }) => {
      const entry = find(goals, id);
      if (!entry.mergeCompletion || entry.mergeCompletion.confirm !== confirm)
        throw new PreviewError("stale-confirmation");
      entry.status = "done";
      entry.turn = {
        owner: "done",
        reason: { kind: "merged", prNumber: entry.mergeCompletion.prNumber },
      };
      delete entry.mergeCompletion;
      changed([]);
      return { id: entry.id, ref: entry.ref, status: "done" };
    },
    "goal.merge": ({ id, method, confirm }) =>
      finishPullRequest(id, method, confirm),
    "goal.closePr": ({ id, confirm }) =>
      finishPullRequest(id, "close", confirm),
    "goal.publish": ({ id, expectedHead, confirm, expectedPr }) => {
      const entry = find(goals, id);
      if (!entry.publish.enabled) throw new PreviewError("publish-disabled");
      const existingNumber = entry.publish.prNumber;
      const existingState = entry.prState;
      if (
        expectedPr !== undefined &&
        (expectedPr?.number !== existingNumber ||
          expectedPr?.state !== existingState)
      )
        throw new PreviewError("stale-confirmation");
      if (!entry.publishPreview) throw new PreviewError("publish-not-ready");
      if (expectedHead !== entry.publishPreview.expectedHead)
        throw new PreviewError("publish-stale-head");
      if (confirm !== goalPublishConfirmation(entry.ref, expectedHead))
        throw new PreviewError("confirmation-mismatch");
      const number =
        entry.prState === "closed"
          ? nextPr++
          : (entry.publish.prNumber ?? nextPr++);
      const {
        failure: _failure,
        autoMergeEnabled: _effectiveMethod,
        ...previous
      } = entry.publish;
      entry.publish = {
        ...previous,
        ...pr(number),
        state: "pr-open",
        checks: "pending",
        mergeable: "clean",
        checkRuns: [{ name: "test", state: "pending" }],
        lastCheckedAt: new Date().toISOString(),
        ...(previous.autoMerge !== "off" && {
          autoMergeEnabled: previous.autoMerge,
        }),
      };
      entry.prState = "open";
      entry.turn = {
        owner: entry.publish.autoMergeEnabled ? "ai" : "human",
        reason: {
          kind: "pr-open",
          prNumber: number,
          checks: "pending",
          autoMerge: entry.publish.autoMerge,
        },
      };
      delete entry.publishPreview;
      renewAutoMergeConfirmations(entry);
      updatePrActions(entry);
      changed([pullRequestRowId(entry)]);
      return entry.publish;
    },
    "goal.setAutoMerge": ({ id, method, confirm }) => {
      const entry = find(goals, id);
      if (!autoMergeMethods.includes(method) || !/^[a-f0-9]{64}$/.test(confirm))
        throw new PreviewError("invalid-params");
      if (!entry.publish.enabled) throw new PreviewError("publish-disabled");
      if (
        entry.status !== "active" ||
        entry.prState === "closed" ||
        entry.prState === "merged"
      )
        throw new PreviewError("invalid-transition");
      if (entry.autoMergeConfirmations[method] !== confirm)
        throw new PreviewError("stale-confirmation");
      entry.publish.autoMerge = method;
      entry.publish.autoMergeSource = "goal";
      delete entry.publish.autoMergeUnavailable;
      if (entry.turn.reason.kind === "pr-open") {
        entry.turn = {
          owner: method === "off" ? "human" : "ai",
          reason: { ...entry.turn.reason, autoMerge: method },
        };
        if (method === "off") delete entry.publish.autoMergeEnabled;
        else entry.publish.autoMergeEnabled = method;
      }
      renewAutoMergeConfirmations(entry);
      updatePrActions(entry);
      changed(entry.prState === "open" ? [pullRequestRowId(entry)] : []);
      return { autoMerge: method, autoMergeSource: "goal" };
    },
    "goal.export": ({ id, confirm, expectedHead }) => {
      const entry = find(goals, id);
      const preview = entry.exportPreview;
      if (!preview || preview.from === preview.to)
        throw new PreviewError("already-exported");
      const { branch, from, to } = preview;
      if (expectedHead !== to) throw new PreviewError("stale-base");
      if (confirm !== `export-goal-branch ${entry.ref} ${to.slice(0, 12)}`)
        throw new PreviewError("confirmation-mismatch");
      preview.from = to;
      entry.timeline.unshift({
        kind: "exported",
        at: new Date().toISOString(),
        ref: null,
        proposalKind: null,
      });
      changed();
      return { id: entry.id, ref: entry.ref, branch, from, to };
    },
    "goal.updateBase": ({ id, confirm, from, to }) => {
      const entry = find(goals, id);
      if (
        from !== entry.baseUpdatePreview?.from ||
        to !== entry.baseUpdatePreview.to
      )
        throw new PreviewError("stale-base");
      if (confirm !== `update-goal-base ${entry.ref} ${to.slice(0, 12)}`)
        throw new PreviewError("confirmation-mismatch");
      entry.baseCommit = entry.head = to;
      delete entry.baseUpdatePreview;
      changed();
      return { id: entry.id, ref: entry.ref, from, to };
    },
    "workplace.stopPreview": () => ({
      runningTasks: activity().running.length,
      revision,
    }),
    "workplace.stop": ({ confirm, revision: expected }) => {
      if (expected !== revision) throw new PreviewError("stale-confirmation");
      if (confirm !== "Workplace を終える")
        throw new PreviewError("confirmation-mismatch");
      stop();
      return { stopping: true };
    },
    "environment.status": () => environment,
    "environment.buildPreview": () => ({
      confirmation: environmentConfirmation,
      key: environmentKey,
      destinations: [],
      responsibilityNotice: null,
    }),
    "environment.build": ({ confirmation }) => {
      if (confirmation !== environmentConfirmation)
        throw new PreviewError("confirmation-mismatch");
      const size = 8192;
      environment.status = {
        key: environmentKey,
        state: "current",
        hasLock: true,
        size,
      };
      environment.build = {
        state: "succeeded",
        key: environmentKey,
        cacheHit: false,
        size,
      };
      changed();
      return { state: "running", key: environmentKey };
    },
    "concierge.draft": ({ text }) => ({ characters: Array.from(text).length }),
    "goal.get": ({ id }) => find(listGoals(), id),
    "task.list": ({ goalId }) => find(listGoals(), goalId).tasks,
    "task.get": ({ id }) => {
      const entry = find(tasks, id);
      const parent = find(goals, entry.goalId);
      const { prNumber, prUrl } = parent.publish;
      if (prNumber && prUrl) entry.pullRequest = { prNumber, prUrl };
      entry.effectiveIntegrationPolicy = resolveDelegation("integration", {
        task: entry.integrationPolicy,
        goal: parent.policyOverrides.integration,
        rules: policy.rules,
        fallback: {
          policy: policy.defaults.integration ?? "human",
          source: "default",
        },
        facts: { paths: entry.paths, category: entry.category },
      });
      return entry;
    },
    "problem.list": ({ includeResolved }) => problems(includeResolved),
    "concierge.attach": () => ({
      replay: Buffer.from(
        "Workplace preview\r\nConcierge is available as a placeholder.\r\n",
      ).toString("base64"),
    }),
    "concierge.input": () => ({}),
    "concierge.resize": () => ({}),
  };
}

type AnswerError = Extract<
  Methods["proposal.answerMany"]["result"][number],
  { error: unknown }
>["error"]["code"];

export class PreviewError<Code extends string = string> extends Error {
  readonly code: Code;

  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}

class AnswerFailure extends PreviewError<AnswerError> {}
