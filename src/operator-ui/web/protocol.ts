import { ROLE_PROFILES } from "../../sandbox-profiles.ts";
import type {
  DelegationRule,
  EffectivePolicy,
  GoalPolicy,
  PolicyInvariant,
  RuleGate,
  TaskPolicy,
  RuleConditions,
} from "../../local-orchestrator/delegation.ts";
import type { Gate, Policy } from "../../local-orchestrator/model.ts";
import type { OrchestratorStore } from "../../local-orchestrator/store.ts";
import type {
  goalStatuses,
  operatorGoal,
  operatorGoalList,
  operatorInbox,
  operatorProblems,
  operatorProposal,
  operatorActivity,
  operatorStatus,
  operatorTask,
  operatorTaskList,
} from "../../local-orchestrator/operator-read.ts";
import type {
  PanelAnswer,
  PanelAnswerResult,
} from "../../local-orchestrator/proposal-answer.ts";

export type Proposal = NonNullable<
  Awaited<ReturnType<typeof operatorProposal>>
>;
type Repository = { project: string; repositoryPath: string };
export type Status = ReturnType<typeof operatorStatus> &
  (Repository | { project?: never; repositoryPath?: never });
export type GoalSummary = ReturnType<typeof operatorGoalList>[number];
export type GoalDetail = NonNullable<ReturnType<typeof operatorGoal>> & {
  head: string | null;
};
export type TaskSummary = NonNullable<
  ReturnType<typeof operatorTaskList>
>[number];
export type TaskDetail = NonNullable<ReturnType<typeof operatorTask>>;
export type Problem = ReturnType<typeof operatorProblems>[number];
export type PanelInboxItem = ReturnType<typeof operatorInbox>[number];
export type AnswerableProposal = Extract<
  PanelInboxItem,
  { answer: unknown }
>["answer"];

export type PolicySettings = ReturnType<OrchestratorStore["policySettings"]>;
export type AgentDecision = ReturnType<
  OrchestratorStore["decisionHistory"]
>[number];
export type SettingsReceipt = { ok: true };

export const gateLabels: Record<Gate, string> = {
  "goal-registration": "Goal の登録",
  "task-registration": "Task の登録",
  integration: "統合",
};

export const invariantLabels: Record<PolicyInvariant, string> = {
  "integration-verification": "検証に合格していない統合は人が判断します。",
  "integration-symlinks":
    "シンボリックリンクの変更を含む統合は人が判断します。",
  "integration-symlink-evidence":
    "シンボリックリンクの確認記録がない統合は人が判断します。",
  "integration-review":
    "統合を AI に任せるにはレビューに合格している必要があります。",
  "concierge-proposal": "Concierge の提案は人が判断します。",
  "scope-exception": "Goal の範囲を外れる Task の登録は人が判断します。",
  "policy-loosening": "モデルからの委任拡大は人の承認が必要です。",
  "operator-commands":
    "Goal の破棄とブランチのエクスポートはオペレーターが行います。",
};

export function settingLabel(setting: EffectivePolicy): string {
  switch (setting.source) {
    case "invariant":
      return setting.invariant
        ? invariantLabels[setting.invariant]
        : "固定条件";
    case "rule":
      return `ルール「${setting.ruleName ?? setting.ruleId ?? "—"}」`;
    case "operator-task":
      return "この Task の設定";
    case "operator-goal":
      return "この Goal の設定";
    case "task":
      return "Task 提案のポリシー";
    case "goal":
      return "Goal 提案のポリシー";
    case "request":
      return "提案のポリシー";
    case "default":
      return "全体の既定値";
  }
}

export function orderedRules(rules: readonly DelegationRule[]) {
  return rules.map(
    ({ id, name, gate, action, enabled, conditions }, order) => ({
      id,
      name,
      gate,
      action,
      enabled,
      conditions,
      order,
    }),
  );
}

export function moveRule(
  rules: readonly DelegationRule[],
  index: number,
  offset: -1 | 1,
) {
  const next = [...rules];
  const neighbor = index + offset;
  const first = next[index];
  const second = next[neighbor];
  if (first && second) {
    next[index] = second;
    next[neighbor] = first;
  }
  return orderedRules(next);
}

function conditionsEqual(a: RuleConditions, b: RuleConditions) {
  const sorted = (conditions: RuleConditions) =>
    Object.entries(conditions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value].sort() : value,
      ]);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

export function ruleChangeCanWiden(
  before: readonly DelegationRule[],
  after: readonly DelegationRule[],
) {
  for (const prior of before) {
    const next = after.find(({ id }) => id === prior.id);
    if (!prior.enabled || prior.action !== "human") continue;
    if (
      !next?.enabled ||
      next.action !== "human" ||
      next.gate !== prior.gate ||
      !conditionsEqual(next.conditions, prior.conditions)
    )
      return true;
    if (
      before.some((agent) => {
        if (
          !agent.enabled ||
          agent.action !== "agent" ||
          agent.gate !== prior.gate ||
          agent.order < prior.order
        )
          return false;
        const updated = after.find(({ id }) => id === agent.id);
        return (
          updated?.enabled &&
          updated.action === "agent" &&
          updated.gate === prior.gate &&
          updated.order < next.order
        );
      })
    )
      return true;
  }
  return after.some((next) => {
    if (!next.enabled || next.action !== "agent") return false;
    const prior = before.find(({ id }) => id === next.id);
    return (
      !prior?.enabled ||
      prior.action !== "agent" ||
      prior.gate !== next.gate ||
      !conditionsEqual(prior.conditions, next.conditions)
    );
  });
}

export interface Methods {
  status: { params: Record<string, never>; result: Status };
  "policy.get": { params: Record<string, never>; result: PolicySettings };
  "policy.setDefault": {
    params: { gate: Gate; policy: Policy };
    result: SettingsReceipt;
  };
  "policy.setRules": {
    params: { rules: DelegationRule[]; expectedRevision?: string };
    result: SettingsReceipt;
  };
  "goal.setPolicy": {
    params: {
      goalId: string;
      gate: RuleGate;
      value: GoalPolicy;
      expected?: GoalPolicy;
    };
    result: SettingsReceipt;
  };
  "task.setIntegrationPolicy": {
    params: { taskId: string; value: TaskPolicy; expected?: TaskPolicy };
    result: SettingsReceipt;
  };
  "decision.history": { params: { limit?: number }; result: AgentDecision[] };
  "inbox.list": {
    params: { includeResolved?: boolean };
    result: PanelInboxItem[];
  };
  "inbox.subscribe": {
    params: Record<string, never>;
    result: { subscribed: true };
  };
  "inbox.markSeen": { params: { ids: string[] }; result: { marked: number } };
  "proposal.get": { params: { id: string }; result: Proposal };
  "proposal.answer": {
    params: PanelAnswer;
    result: Extract<PanelAnswerResult, { ok: true }>;
  };
  "proposal.answerMany": {
    params: { answers: PanelAnswer[] };
    result: PanelAnswerResult[];
  };
  "goal.list": {
    params: { status?: (typeof goalStatuses)[number] };
    result: GoalSummary[];
  };
  "activity.get": {
    params: Record<string, never>;
    result: ReturnType<typeof operatorActivity>;
  };
  "activity.subscribe": {
    params: Record<string, never>;
    result: { subscribed: true };
  };
  "task.retry": {
    params: { id: string; expectedRetries: number };
    result: ReturnType<OrchestratorStore["retryTask"]>;
  };
  "goal.discard": {
    params: { id: string; confirm: string; expectedHead: string | null };
    result: { id: string; ref: string; status: "cancelled" };
  };
  "concierge.draft": {
    params: { text: string };
    result: { characters: number };
  };
  "goal.get": { params: { id: string }; result: GoalDetail };
  "task.list": { params: { goalId: string }; result: TaskSummary[] };
  "task.get": { params: { id: string }; result: TaskDetail };
  "problem.list": { params: { includeResolved?: boolean }; result: Problem[] };
  "concierge.attach": {
    params: Record<string, never>;
    result: { replay: string };
  };
  "concierge.input": { params: { data: string }; result: object };
  "concierge.resize": {
    params: { cols: number; rows: number };
    result: object;
  };
}

export type Push =
  | { method: "activity.changed"; params: Record<string, never> }
  | { method: "inbox.changed"; params: { ids: string[] } }
  | { method: "concierge.output"; params: { data: string } }
  | { method: "concierge.exit"; params: { exitCode: number | null } }
  | { method: "concierge.notice"; params: { code: "input-transferred" } };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function plainText(value: unknown): value is string {
  return (
    typeof value === "string" && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function multilineText(value: unknown): value is string {
  return typeof value === "string" && value.split("\n").every(plainText);
}

function token(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value);
}

function count(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function textList(
  value: unknown,
  max: number,
  min = 0,
  validate = plainText,
): value is string[] {
  return (
    Array.isArray(value) &&
    count(value.length, min, max) &&
    value.every(validate)
  );
}

export function withheld(value: unknown) {
  return record(value) && keys(value, ["withheld"]) && value.withheld === true;
}

const actors = ["Concierge", "Planner", "Researcher", "Executor", "Reviewer"];

function choice<T extends string>(value: unknown, values: readonly T[]) {
  return values.some((item) => item === value);
}

export function isRef(value: unknown): value is string {
  return token(value, /^G[1-9][0-9]*(-[1-9][0-9]*)?$/);
}

export function isProposal(value: unknown): value is Proposal {
  if (!record(value)) return false;
  const { budgets, origin, modelText, pathViolations } = value;
  if (
    !["ref", "goalRef", "taskRef"].every(
      (key) =>
        !Object.hasOwn(value, key) || value[key] === null || isRef(value[key]),
    ) ||
    !token(value.digest, /^[a-f0-9]{64}$/) ||
    !plainText(value.id) ||
    !value.id ||
    !choice(value.status, ["pending", "approved", "rejected", "registered"]) ||
    !(value.gate === null || choice(value.gate, Object.keys(gateLabels))) ||
    !(
      value.effectivePolicy === null ||
      choice(value.effectivePolicy, ["human", "agent"])
    ) ||
    !(
      value.policySource === null ||
      choice(value.policySource, [
        "default",
        "request",
        "goal",
        "task",
        "operator-task",
        "operator-goal",
        "rule",
        "invariant",
      ])
    ) ||
    !Array.isArray(value.loosening) ||
    !value.loosening.every((gate) => choice(gate, Object.keys(gateLabels))) ||
    !["ruleId", "ruleName"].every(
      (key) =>
        !Object.hasOwn(value, key) ||
        plainText(value[key]) ||
        withheld(value[key]),
    ) ||
    (Object.hasOwn(value, "invariant") &&
      !choice(value.invariant, Object.keys(invariantLabels))) ||
    !["humanApprovalRequired", "humanAnswerRequired"].every(
      (key) => !Object.hasOwn(value, key) || value[key] === true,
    ) ||
    !record(origin) ||
    !(origin.kind === "actor"
      ? keys(origin, ["kind", "actor"]) && choice(origin.actor, actors)
      : keys(origin, ["kind"]) && choice(origin.kind, ["operator", "host"])) ||
    !record(budgets) ||
    !keys(budgets, ["maxExecutionMs", "maxRetries", "maxTokens"]) ||
    !count(budgets.maxExecutionMs, 1, 3_600_000) ||
    !count(budgets.maxRetries, 0, 10) ||
    !count(budgets.maxTokens, 1, 10_000_000) ||
    !record(modelText)
  )
    return false;
  const common = [
    "id",
    "ref",
    "goalRef",
    "taskRef",
    "kind",
    "digest",
    "status",
    "gate",
    "effectivePolicy",
    "policySource",
    "ruleId",
    "ruleName",
    "invariant",
    "loosening",
    "humanApprovalRequired",
    "humanAnswerRequired",
    "origin",
    "budgets",
    "pathViolations",
    "diffStat",
    "modelText",
  ];
  if (value.kind === "integration")
    return (
      keys(value, [
        ...common,
        "changedPaths",
        "changedFiles",
        "changedLines",
        "reviewExecutionId",
      ]) &&
      (withheld(value.diffStat) || multilineText(value.diffStat)) &&
      count(value.changedFiles, 1, 10_000) &&
      (value.changedLines === null || count(value.changedLines)) &&
      (withheld(value.changedPaths) ||
        (textList(value.changedPaths, 10_000, 1) &&
          value.changedPaths.length === value.changedFiles)) &&
      textList(pathViolations, 0) &&
      plainText(value.reviewExecutionId) &&
      value.reviewExecutionId.length > 0 &&
      keys(modelText, ["verdict", "findings"]) &&
      modelText.verdict === "pass" &&
      (modelText.findings === null ||
        multilineText(modelText.findings) ||
        withheld(modelText.findings))
    );
  if (
    value.diffStat !== null ||
    !keys(modelText, ["description", "acceptance"]) ||
    !(
      multilineText(modelText.description) || withheld(modelText.description)
    ) ||
    !(
      textList(modelText.acceptance, 32, 1, multilineText) ||
      withheld(modelText.acceptance)
    )
  )
    return false;
  if (value.kind === "goal")
    return (
      keys(value, [...common, "paths", "profiles", "actors", "maxTasks"]) &&
      (textList(value.paths, 64, 1) || withheld(value.paths)) &&
      textList(value.profiles, ROLE_PROFILES.Worker.length) &&
      value.profiles.every((profile) =>
        choice(profile, ROLE_PROFILES.Worker),
      ) &&
      Array.isArray(value.actors) &&
      value.actors.length <= 4 &&
      value.actors.every((actor) => choice(actor, actors.slice(1))) &&
      count(value.maxTasks, 1, 1000) &&
      textList(pathViolations, 0)
    );
  return (
    value.kind === "task" &&
    keys(value, [...common, "paths", "actor", "profile"]) &&
    (textList(value.paths, 64) || withheld(value.paths)) &&
    (textList(pathViolations, 64) || withheld(pathViolations)) &&
    choice(value.actor, ["Executor", "Researcher"]) &&
    choice(value.profile, ROLE_PROFILES.Worker)
  );
}

export function statusRepository(value: unknown): Repository | null {
  if (!record(value)) throw new Error("invalid-response");
  const { project, repositoryPath } = value;
  if (
    !Object.hasOwn(value, "project") &&
    !Object.hasOwn(value, "repositoryPath")
  )
    return null;
  if (
    typeof project !== "string" ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(project) ||
    !plainText(repositoryPath) ||
    (repositoryPath !== "." &&
      repositoryPath
        .split("/")
        .some((part) => !part || part === "." || part === ".."))
  )
    throw new Error("invalid-response");
  return { project, repositoryPath };
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const maxInputBytes = 16 * 1024;

export function* chunkInput(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += maxInputBytes) {
    yield bytes.subarray(offset, offset + maxInputBytes);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value)
    ? min
    : Math.min(max, Math.max(min, Math.trunc(value)));
}

export function clampSize(cols: number, rows: number) {
  return { cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) };
}

export function estimateLabel(remainingMs: number | null) {
  if (remainingMs === null || remainingMs <= 0) return "";
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  return `あと約 ${minutes} 分（現時点の計画では）`;
}

const localTime = new Intl.DateTimeFormat("ja-JP", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatTimestamp(at: string | null, now = Date.now()) {
  if (at === null) return "—";
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return "—";
  const age = now - timestamp;
  if (age >= 0 && age < 86_400_000) {
    const minutes = Math.floor(age / 60_000);
    return minutes === 0 ? "たった今" : `${minutes} 分前`;
  }
  return localTime.format(timestamp);
}

export function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  return minutes === 0 ? "1 分未満" : `${minutes} 分`;
}

const tokenCount = new Intl.NumberFormat("ja-JP");

export function formatTokens(tokens: number | null) {
  return tokens === null ? "—" : tokenCount.format(tokens);
}

export function pendingDecisions(items: readonly PanelInboxItem[]) {
  return items.filter(
    ({ weight, state, kind }) =>
      weight === "action" &&
      state !== "resolved" &&
      kind !== "task-failed" &&
      kind !== "execution-over-budget",
  );
}

export function groupProblems(problems: readonly Problem[]) {
  const groups = new Map<string, Problem[]>();
  for (const [index, problem] of problems.entries()) {
    const key = problem.taskId ? `task:${problem.taskId}` : `problem:${index}`;
    const group = groups.get(key);
    if (group) group.push(problem);
    else groups.set(key, [problem]);
  }
  return [...groups.values()];
}

export function retryCommand(taskId: string, items: readonly PanelInboxItem[]) {
  // Reuse the host's shell quoting and retry eligibility for this target.
  return items.find(
    (item) =>
      item.kind === "task-failed" &&
      item.state !== "resolved" &&
      item.subject.taskId === taskId &&
      item.next.endsWith(` retry-task ${taskId}`),
  )?.next;
}
