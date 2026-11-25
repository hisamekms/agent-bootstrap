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
import type { InboxItem } from "../../local-orchestrator/inbox.ts";
import type {
  goalStatuses,
  operatorGoal,
  operatorGoalList,
  operatorInbox,
  operatorProblems,
  operatorProposal,
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
export type Status = ReturnType<typeof operatorStatus>;
export type GoalSummary = ReturnType<typeof operatorGoalList>[number];
export type GoalDetail = NonNullable<ReturnType<typeof operatorGoal>>;
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
  | { method: "inbox.changed"; params: { ids: string[] } }
  | { method: "concierge.output"; params: { data: string } }
  | { method: "concierge.exit"; params: { exitCode: number | null } }
  | { method: "concierge.notice"; params: { code: "input-transferred" } };

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

export function orderInbox<T extends Pick<InboxItem, "weight">>(
  items: readonly T[],
): T[] {
  return [
    ...items.filter(({ weight }) => weight === "action"),
    ...items.filter(({ weight }) => weight === "info"),
  ];
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
