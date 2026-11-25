import type { InboxItem } from "../../local-orchestrator/inbox.ts";
import type {
  goalStatuses,
  operatorGoal,
  operatorGoalList,
  operatorProblems,
  operatorProposal,
  operatorStatus,
  operatorTask,
  operatorTaskList,
} from "../../local-orchestrator/operator-read.ts";

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

export interface Methods {
  status: { params: Record<string, never>; result: Status };
  "inbox.list": { params: { includeResolved?: boolean }; result: InboxItem[] };
  "inbox.subscribe": {
    params: Record<string, never>;
    result: { subscribed: true };
  };
  "inbox.markSeen": { params: { ids: string[] }; result: { marked: number } };
  "proposal.get": { params: { id: string }; result: Proposal };
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
