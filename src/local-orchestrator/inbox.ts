import { createHash } from "node:crypto";
import { escapeTerminalControls } from "./analysis.ts";
import { secretTestCommand, shellWord } from "./secret-test-record.ts";
import type { OrchestratorStore } from "./store.ts";

export const inboxLimit = 200;
const week = 7 * 24 * 60 * 60 * 1000;

type Kind =
  | "goal-registration"
  | "task-registration"
  | "integration"
  | "task-failed"
  | "execution-over-budget"
  | "secret-test-required"
  | "task-succeeded"
  | "goal-completed"
  | "task-running";

export interface InboxRow {
  id: string;
  kind: Exclude<Kind, "secret-test-required">;
  at: string;
  goalId: string | null;
  taskId: string | null;
  proposalId: string | null;
  executionId: string | null;
  modelText: string | null;
  resolved: 0 | 1;
  code: string | null;
  rejectedCount: number | null;
  canRetry: 0 | 1;
}

export interface SecretTestFact {
  variable: string;
  version: string;
  passed: boolean;
}

export interface InboxItem {
  id: string;
  kind: Kind;
  weight: "action" | "info";
  subject: {
    goalId?: string;
    taskId?: string;
    proposalId?: string;
    executionId?: string;
  };
  title: string;
  modelText?: string;
  next: string;
  at: string | null;
  state: "open" | "seen" | "resolved";
}

export interface InboxSource {
  store: OrchestratorStore;
  target: string;
  secretTests?: () => readonly SecretTestFact[];
}

export function projectInbox(
  { store, target, secretTests }: InboxSource,
  { includeResolved = false, now = Date.now() } = {},
): InboxItem[] {
  const command = `agent-bootstrap --target ${shellWord(target)}`;
  const rows = store.inboxRows(
    includeResolved,
    new Date(now - week).toISOString(),
  );
  const items = rows.map((row): InboxItem => {
    const { id, kind, at, goalId, taskId, proposalId, executionId } = row;
    const task = taskId?.slice(0, 8);
    let title: string;
    let next: string;
    let weight: InboxItem["weight"] = "action";
    switch (kind) {
      case "goal-registration":
      case "task-registration":
      case "integration": {
        const gate =
          kind === "goal-registration"
            ? "Goal registration"
            : kind === "task-registration"
              ? "Task registration"
              : "Integration";
        title = row.resolved
          ? `${gate} proposal ${proposalId?.slice(0, 8)} answered`
          : `${gate} approval waiting for ${task ? `Task ${task}` : `proposal ${proposalId?.slice(0, 8)}`}`;
        next = `${row.resolved ? "show" : "approve"} ${proposalId}`;
        break;
      }
      case "task-failed": {
        const code = escapeTerminalControls(row.code ?? "unknown");
        const count =
          code === "path-violation"
            ? `, ${row.rejectedCount ?? 0} rejected paths recorded`
            : "";
        title = `Task ${task} failed (${code}${count})`;
        next = `${!row.resolved && row.canRetry ? "retry-task" : "show"} ${taskId}`;
        break;
      }
      case "execution-over-budget":
        title = `Execution ${executionId?.slice(0, 8)} exceeded its budget`;
        next = `show-execution ${executionId}`;
        break;
      case "task-succeeded":
      case "task-running":
        weight = "info";
        title = `Task ${task} ${kind === "task-succeeded" ? "succeeded" : "started running"}`;
        next = `show ${taskId}`;
        break;
      case "goal-completed":
        weight = "info";
        title = `Goal ${goalId?.slice(0, 8)} completed`;
        next = `show ${goalId}`;
        break;
    }
    return {
      id,
      kind,
      weight,
      title,
      at,
      next: `${command} ${next}`,
      subject: {
        ...(goalId && { goalId }),
        ...(taskId && { taskId }),
        ...(proposalId && { proposalId }),
        ...(executionId && { executionId }),
      },
      ...(row.modelText && {
        modelText: escapeTerminalControls(row.modelText),
      }),
      state: row.resolved ? "resolved" : "open",
    };
  });
  const checks: InboxItem[] = [];
  for (const { variable, version, passed } of secretTests?.() ?? []) {
    if (passed && !includeResolved) continue;
    const key = createHash("sha256")
      .update(JSON.stringify([variable, version]))
      .digest("hex");
    checks.push({
      id: `secret-test-required:${key}`,
      kind: "secret-test-required",
      weight: "action",
      subject: {},
      title: passed ? "Secret self-test passed" : "Secret self-test required",
      next: passed ? `${command} inbox` : secretTestCommand(variable, target),
      at: null,
      state: passed ? "resolved" : "open",
    });
  }
  // Keep unresolved checks without timestamps visible ahead of dated history.
  const bounded = [
    ...checks.filter(({ state }) => state !== "resolved"),
    ...items,
    ...checks.filter(({ state }) => state === "resolved"),
  ].slice(0, inboxLimit);
  const seen = store.inboxSeen(bounded.map(({ id }) => id));
  return bounded.map((item) =>
    item.state === "open" && seen.has(item.id)
      ? { ...item, state: "seen" }
      : item,
  );
}

export function changedInboxIds(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  return [
    ...[...current]
      .filter(([id, value]) => previous.get(id) !== value)
      .map(([id]) => id),
    ...[...previous.keys()].filter((id) => !current.has(id)),
  ];
}

export function inboxSnapshot(items: readonly InboxItem[]) {
  return new Map(items.map((item) => [item.id, JSON.stringify(item)]));
}

export function formatInboxItem(item: InboxItem): string {
  const ids = Object.values(item.subject)
    .map((id) => id.slice(0, 8))
    .join(" ");
  // Model text goes last and quoted, so it never sits next to the host's command.
  const model = item.modelText
    ? ` | untrusted model text: "${item.modelText.replaceAll('"', '\\"')}"`
    : "";
  return `[${item.weight}] ${item.kind} ${item.state}${ids ? ` ${ids}` : ""} | ${item.title} | ${item.next}${model}\n`;
}
