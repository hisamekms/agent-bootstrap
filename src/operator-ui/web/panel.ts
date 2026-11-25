import { action, textElement } from "./dom.ts";
import {
  delegationPanel,
  goalDelegation,
  taskDelegation,
} from "./delegation-panel.ts";
import type { InboxItem } from "../../local-orchestrator/inbox.ts";
import { taskStages } from "../../local-orchestrator/operator-estimates.ts";
import type { PanelAnswer } from "../../local-orchestrator/proposal-answer.ts";
import type { WorkplaceChannel } from "./channel.ts";
import {
  estimateLabel,
  gateLabels,
  settingLabel,
  type AgentDecision,
  formatDuration,
  formatTimestamp,
  formatTokens,
  orderInbox,
  type AnswerableProposal,
  type GoalDetail,
  type GoalSummary,
  type PanelInboxItem,
  type Problem,
  type Proposal,
  type TaskDetail,
  type TaskSummary,
} from "./protocol.ts";

export function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing workplace element ${id}`);
  return node;
}

const subjectLabels = {
  goalId: "Goal ID",
  taskId: "Task ID",
  proposalId: "Proposal ID",
  executionId: "Execution ID",
} as const;

function createInboxPanel(channel: WorkplaceChannel, refresh: () => void) {
  const inbox = element("inbox-items");
  const details = element("details");
  const notice = element("inbox-notice");
  const batch = element("answer-batch");
  const confirmation = element("answer-confirmation");
  const results = element("answer-results");
  const chosen = new Map<string, string>();
  let proposals: AnswerableProposal[] = [];
  let controls: (() => void)[] = [];
  let answering = false;
  let buttons = new Map<string, HTMLButtonElement>();
  let selected: InboxItem | undefined;
  let previousItems = "";
  const marking = new Set<string>();
  const observed = new Map<Element, string>();
  const visible = new IntersectionObserver(
    (entries) => {
      const ids: string[] = [];
      for (const { target, intersectionRatio } of entries) {
        const id = observed.get(target);
        if (intersectionRatio < 0.1 || !id || marking.has(id)) continue;
        marking.add(id);
        ids.push(id);
        visible.unobserve(target);
      }
      if (!ids.length) return;
      void channel
        .request("inbox.markSeen", { ids })
        .catch(() => {
          notice.textContent = "Could not mark inbox items seen.";
        })
        .finally(() => ids.forEach((id) => marking.delete(id)));
    },
    { root: element("inbox"), threshold: 0.1 },
  );

  async function select(item: InboxItem) {
    if (selected)
      buttons.get(selected.id)?.setAttribute("aria-pressed", "false");
    selected = item;
    buttons.get(item.id)?.setAttribute("aria-pressed", "true");

    const fields = document.createElement("dl");
    function field(label: string, value: string) {
      const content = textElement("dd", value);
      fields.append(textElement("dt", label), content);
      return content;
    }
    const proposalInfo = textElement("p", "");
    details.replaceChildren(
      textElement("h3", item.title),
      fields,
      proposalInfo,
    );
    const kind = field("Kind", item.kind);
    for (const [key, label] of Object.entries(subjectLabels)) {
      const id = item.subject[key as keyof InboxItem["subject"]];
      if (id) field(label, id);
    }

    const command = textElement("pre", item.next);
    const copy = textElement("button", "Copy CLI command");
    copy.type = "button";
    const copyStatus = textElement("p", "");
    copyStatus.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.next);
        copyStatus.textContent = "Command copied.";
      } catch {
        copyStatus.textContent = "Could not copy the command.";
      }
    });
    details.append(command, copy, copyStatus);
    if (item.modelText !== undefined) {
      details.append(modelBox("提案", [item.modelText]));
    }

    if (!item.subject.proposalId) return;
    proposalInfo.textContent = "Loading proposal…";
    proposalInfo.setAttribute("role", "status");
    try {
      const proposal = await channel.request("proposal.get", {
        id: item.subject.proposalId,
      });
      kind.textContent = proposal.kind;
      field("Pinned digest", proposal.digest);
      if (proposal.diffStat !== null)
        field("変更規模", "").append(textElement("pre", proposal.diffStat));
      proposalInfo.remove();
      return proposal;
    } catch {
      proposalInfo.textContent = "Could not load the proposal.";
    }
  }

  const batchButton = action("", "approve-batch", () => {
    const approved = proposals.filter(
      ({ id, digest }) => chosen.get(id) === digest,
    );
    if (approved.length >= 2) confirm(approved, "approve");
  });
  batch.append(batchButton);

  function updateControls() {
    for (const update of controls) update();
    batchButton.hidden = chosen.size < 2;
    batchButton.disabled = answering;
    batchButton.textContent = `選んだ ${chosen.size} 件をまとめて承認`;
  }
  updateControls();

  function confirm(
    pinned: AnswerableProposal[],
    decision: PanelAnswer["decision"],
    selectedPreview?: Promise<Proposal | undefined>,
  ) {
    if (answering) return;
    const label =
      decision === "reject"
        ? "却下"
        : pinned.length === 1 && pinned[0]?.kind === "integration"
          ? "承認して統合"
          : "承認";
    const submit = action("確定", "submit-answer", () => void send());
    const cancel = action("やめる", "cancel-answer", () =>
      confirmation.replaceChildren(),
    );
    const previews: Promise<boolean>[] = [];
    confirmation.replaceChildren(
      textElement("h3", `${label}の確認`),
      list(pinned, ({ id, kind, title, digest, agentGates }) => {
        const node = document.createElement("div");
        node.append(
          textElement(
            "p",
            `${kind} · ${id.slice(0, 8)} · ${digest.slice(0, 12)}`,
          ),
        );
        if (title !== null) node.append(modelBox("タイトル", [title]));
        if (decision === "approve" && agentGates.length > 0) {
          const warning = textElement(
            "p",
            `この提案には AI へ判断を委任する設定が含まれます（${agentGates.join("、")}）。`,
          );
          warning.className = "warning";
          node.append(warning);
        }
        if (decision === "approve" && kind === "integration") {
          const stat = textElement("pre", "変更規模を読み込み中…");
          stat.setAttribute("role", "status");
          node.append(stat);
          previews.push(loadDiffStat(id, digest, stat));
        }
        return node;
      }),
      submit,
      cancel,
    );
    if (previews.length) {
      submit.disabled = true;
      void Promise.all(previews).then((ready) => {
        submit.disabled = !ready.every(Boolean);
      });
    }
    cancel.focus();

    async function loadDiffStat(id: string, digest: string, stat: HTMLElement) {
      try {
        const proposal = await (selectedPreview ??
          channel.request("proposal.get", { id }));
        if (proposal && proposal.digest !== digest) {
          stat.textContent = answerError("stale-digest");
          if (stat.isConnected) refresh();
          return false;
        }
        if (proposal && proposal.status !== "pending") {
          stat.textContent = answerError("invalid-transition");
          if (stat.isConnected) refresh();
          return false;
        }
        if (proposal?.diffStat != null) {
          stat.textContent = proposal.diffStat;
          return true;
        }
      } catch {
        // Keep confirmation disabled when the pinned diff is unavailable.
      }
      stat.textContent = "変更規模を取得できませんでした。";
      return false;
    }

    async function send() {
      if (answering) return;
      answering = true;
      submit.disabled = cancel.disabled = true;
      updateControls();
      results.replaceChildren();
      const answers = pinned.map(({ id, digest }) => ({
        id,
        digest,
        decision,
      }));
      try {
        const outcomes =
          answers.length === 1 && answers[0]
            ? [await channel.request("proposal.answer", answers[0])]
            : await channel.request("proposal.answerMany", { answers });
        results.replaceChildren(
          list(outcomes, (outcome) =>
            textElement(
              "span",
              `${outcome.id.slice(0, 8)} · ${"ok" in outcome ? `${label}を記録しました。` : answerError(outcome.error.code)}`,
            ),
          ),
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "write-failed";
        results.textContent = answerError(code);
      } finally {
        for (const { id } of answers) chosen.delete(id);
        answering = false;
        confirmation.replaceChildren();
        updateControls();
        refresh();
      }
    }
  }

  function answerError(code: string) {
    switch (code) {
      case "stale-digest":
        return "提案が変更されました。一覧を更新しています。";
      case "invalid-transition":
        return "この提案はすでに判断待ちではありません。";
      case "approval-forbidden":
        return "現在のポリシーではパネルから回答できません。";
      case "not-found":
        return "提案が見つかりません。";
      default:
        return `回答の結果を確認できませんでした（${code}）。`;
    }
  }

  function render(items: PanelInboxItem[]) {
    const snapshot = JSON.stringify(items);
    if (snapshot === previousItems) return;
    previousItems = snapshot;
    const ordered = orderInbox(items);
    proposals = ordered.flatMap((item) =>
      "answer" in item ? [item.answer] : [],
    );
    const approvable = new Map(
      proposals
        .filter(({ approve }) => approve)
        .map(({ id, digest }) => [id, digest]),
    );
    for (const [id, digest] of chosen)
      if (approvable.get(id) !== digest) chosen.delete(id);
    controls = [];
    const focused = [...buttons].find(
      ([, button]) => button === document.activeElement,
    );
    const current = ordered.find(({ id }) => id === selected?.id);
    if (!current) {
      selected = undefined;
      details.replaceChildren();
    }
    visible.disconnect();
    observed.clear();
    buttons = new Map();
    const rows = ordered.map((item) => {
      const row = document.createElement("li");
      const button = textElement("button", item.title);
      button.type = "button";
      button.setAttribute("aria-pressed", String(item.id === selected?.id));
      button.addEventListener("click", () => void select(item));
      row.append(
        textElement("small", item.weight === "action" ? "Action" : "Info"),
        button,
      );
      if ("answer" in item) {
        const proposal = item.answer;
        const group = document.createElement("div");
        group.className = "answer-controls";
        if (proposal.approve) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.setAttribute(
            "aria-label",
            `${item.title} をまとめて承認する項目に追加`,
          );
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) chosen.set(proposal.id, proposal.digest);
            else chosen.delete(proposal.id);
            updateControls();
          });
          controls.push(() => {
            checkbox.checked = chosen.get(proposal.id) === proposal.digest;
            checkbox.disabled =
              answering || (!checkbox.checked && chosen.size >= 20);
          });
          group.append(checkbox);
        }
        const actions = [
          ...(proposal.approve
            ? [
                action(
                  proposal.kind === "integration" ? "承認して統合" : "承認",
                  "approve",
                  () => {
                    confirm([proposal], "approve", select(item));
                  },
                ),
              ]
            : []),
          ...(proposal.reject
            ? [
                action("却下", "reject", () => {
                  void select(item);
                  confirm([proposal], "reject");
                }),
              ]
            : []),
        ];
        controls.push(() => {
          for (const button of actions) button.disabled = answering;
        });
        group.append(...actions);
        row.append(group);
      }
      buttons.set(item.id, button);
      if (item.state === "open") observed.set(button, item.id);
      return row;
    });
    inbox.replaceChildren(...rows);
    updateControls();
    element("empty-inbox").hidden = rows.length !== 0;
    for (const button of observed.keys()) visible.observe(button);
    if (focused)
      (buttons.get(focused[0]) ?? element("host")).focus({
        preventScroll: true,
      });
    if (current && selected) {
      const { state: _previousState, ...before } = selected;
      const { state: _currentState, ...after } = current;
      if (JSON.stringify(before) !== JSON.stringify(after))
        void select(current);
    }
  }

  return { render, disconnect: () => visible.disconnect() };
}

const labels = {
  registered: "登録",
  running: "実行",
  review: "レビュー",
  "awaiting-integration": "統合待ち",
  done: "完了",
  failed: "失敗",
  cancelled: "キャンセル",
  active: "進行中",
} as const;

function modelBox(label: string, lines: readonly string[]) {
  const box = document.createElement("div");
  box.className = "model-text";
  box.append(
    textElement("small", `${label}（モデル生成）`),
    ...lines.map((line) => textElement("pre", line)),
  );
  return box;
}

function facts(rows: [string, string][]) {
  const list = document.createElement("dl");
  for (const [label, value] of rows)
    list.append(textElement("dt", label), textElement("dd", value));
  return list;
}

function list<T>(items: readonly T[], row: (item: T) => Node) {
  const node = document.createElement("ul");
  node.className = "work-list";
  for (const item of items) {
    const entry = document.createElement("li");
    entry.append(row(item));
    node.append(entry);
  }
  return node;
}

function modelLink(
  label: string,
  title: string,
  id: string,
  select: () => void,
) {
  const button = action("", id, select);
  button.className = "model-text model-link";
  button.append(
    textElement("small", `${label}（モデル生成）`),
    textElement("span", title),
  );
  return button;
}

function progress(goal: GoalSummary) {
  const { done, total } = goal.progress;
  const track = document.createElement("progress");
  track.max = total || 1;
  track.value = done;
  const label = `${done} / ${total} Task 完了`;
  track.setAttribute("aria-label", label);
  return [track, textElement("small", label), ...estimateText(goal.estimate)];
}

function estimateText(estimate: GoalSummary["estimate"]) {
  const label = estimateLabel(estimate.remainingMs);
  return label ? [textElement("p", label)] : [];
}

function budgetText(budgets: TaskDetail["budgets"]) {
  return `${budgets.maxExecutionMs / 1000} 秒 / ${formatTokens(budgets.maxTokens)} トークン / 再試行 ${budgets.maxRetries} 回`;
}

function goalDetail(
  goal: GoalDetail,
  delegation: Node,
  selectTask: (id: string) => void,
) {
  const { scope } = goal;
  return [
    modelBox("Goal", [goal.title]),
    textElement("p", labels[goal.status]),
    ...progress(goal),
    facts([
      ["対象パス", scope.paths.join(", ")],
      ["利用できるアクター", scope.actors.join(", ") || "—"],
      ["プロファイル", scope.profiles.join(", ") || "—"],
      ["Task 上限", String(scope.maxTasks)],
      ["予算", budgetText(goal.budgets)],
      ["ブランチ", goal.branch],
      ["ベースコミット", goal.baseCommit ?? "—"],
    ]),
    ...(goal.description ? [modelBox("説明", [goal.description])] : []),
    modelBox("受け入れ条件", goal.acceptance),
    delegation,
    textElement("h3", "Task"),
    goal.tasks.length
      ? list(goal.tasks, (task: TaskSummary) => {
          const item = document.createElement("div");
          item.append(
            modelLink("Task", task.title, task.id, () => selectTask(task.id)),
            textElement("p", labels[task.stage]),
            ...estimateText(task.estimate),
          );
          return item;
        })
      : textElement("p", "Task はありません。"),
    ...(goal.progress.total > goal.tasks.length
      ? [
          textElement(
            "p",
            `${goal.progress.total} 件中 ${goal.tasks.length} 件を表示しています。`,
          ),
        ]
      : []),
  ];
}

function rejectedPaths(
  paths: NonNullable<NonNullable<TaskDetail["failure"]>["rejectedPaths"]>,
) {
  return list(paths, ({ path, symlink }) =>
    textElement("code", symlink ? `${path}（シンボリックリンク）` : path),
  );
}

function taskDetail(task: TaskDetail, delegation: Node) {
  const tokens = formatTokens(task.tokensUsed);
  const usage = task.tokensIncomplete
    ? task.tokensUsed
      ? `少なくとも ${tokens}`
      : "不明"
    : tokens;
  const track = document.createElement("ol");
  track.className = "stage-track";
  const current = task.failure?.stage ?? task.stage;
  for (const stage of taskStages) {
    const failed = task.failure && stage === current;
    const item = textElement(
      "li",
      failed ? `${labels[stage]}（失敗）` : labels[stage],
    );
    if (stage === current) item.setAttribute("aria-current", "step");
    if (failed) item.className = "warning";
    track.append(item);
  }
  const failure = document.createElement("div");
  if (task.failure) {
    failure.className = "warning failure";
    failure.append(
      textElement("h3", "失敗"),
      textElement("code", task.failure.code),
    );
    if (task.failure.rejectedPaths?.length)
      failure.append(
        textElement("p", "拒否されたパス"),
        rejectedPaths(task.failure.rejectedPaths),
      );
  }
  return [
    modelBox("Task", [task.title]),
    ...(task.category
      ? [modelBox("Planner の申告カテゴリー", [task.category])]
      : []),
    track,
    ...(task.stage === "cancelled" ? [textElement("p", labels.cancelled)] : []),
    ...estimateText(task.estimate),
    facts([
      ["アクター", task.actor],
      ["試行", `${task.attempt.current} / ${task.attempt.max}`],
      [
        "経過時間",
        `${formatDuration(task.elapsedMs)}（上限 ${formatDuration(task.budgets.maxExecutionMs)}）`,
      ],
      ["使用トークン", `${usage} / ${formatTokens(task.budgets.maxTokens)}`],
      ["対象パス", task.paths.join(", ") || "—"],
    ]),
    delegation,
    ...(task.failure ? [failure] : []),
    ...(task.description ? [modelBox("説明", [task.description])] : []),
    modelBox("受け入れ条件", task.acceptance),
    textElement("h3", "最近の実行"),
    task.executions.length
      ? list(
          task.executions,
          ({ actor, mode, status, startedAt, finishedAt, tokens }) =>
            textElement(
              "p",
              `${actor} / ${mode} / ${status} · ${formatTimestamp(startedAt)} → ${formatTimestamp(finishedAt)} · ${formatTokens(tokens)} トークン`,
            ),
        )
      : textElement("p", "実行はありません。"),
    textElement("h3", "最近のイベント"),
    task.events.length
      ? list(task.events, ({ kind, at }) =>
          textElement("p", `${formatTimestamp(at)} · ${kind}`),
        )
      : textElement("p", "イベントはありません。"),
  ];
}

function problemRow(problem: Problem, select: () => void) {
  const entry = document.createElement("div");
  const subject = problem.taskId ? "Task" : "Goal";
  const detail = textElement("p", problem.detail);
  detail.className = "warning";
  entry.append(detail);
  if (problem.title) entry.append(modelBox(subject, [problem.title]));
  if ("rejectedPaths" in problem && problem.rejectedPaths)
    entry.append(rejectedPaths(problem.rejectedPaths));
  entry.append(textElement("p", formatTimestamp(problem.at)));
  const key = problem.executionId ?? problem.taskId ?? problem.goalId;
  if (key && (problem.taskId || problem.goalId))
    entry.append(action(`${subject} の詳細`, `${problem.kind}:${key}`, select));
  return entry;
}

function decisionHistory(
  rows: AgentDecision[],
  openTask: (id: string) => void,
  openGoal: (id: string) => void,
) {
  return [
    textElement("h3", "AI が判断したもの"),
    rows.length
      ? list(rows, (entry) => {
          const item = document.createElement("div");
          item.append(
            textElement(
              "p",
              `${gateLabels[entry.gate]} · ${entry.result === "approve" ? "承認" : "却下"} · ${formatTimestamp(entry.at)}`,
            ),
            textElement("p", settingLabel(entry.setting)),
            modelBox(
              "Reviewer の理由",
              entry.reasons.length ? entry.reasons : ["—"],
            ),
          );
          if (entry.taskId) {
            const id = entry.taskId;
            item.append(action("Task の詳細", entry.id, () => openTask(id)));
          } else if (entry.goalId) {
            const id = entry.goalId;
            item.append(action("Goal の詳細", entry.id, () => openGoal(id)));
          }
          return item;
        })
      : textElement("p", "AI の判断はありません。"),
  ];
}

const tabs = ["decisions", "problems", "goals", "delegation"] as const;
type Tab = (typeof tabs)[number];
type View = {
  tab: Tab;
  goalId?: string;
  taskId?: string;
};

export function createHostPanel(channel: WorkplaceChannel) {
  const inbox = createInboxPanel(channel, () => void refresh());
  const notice = element("inbox-notice");
  let view: View = { tab: "decisions" };
  let previous = "";
  let previousHistory = "";
  const savedPolicy = () => {
    previous = "";
    void refresh();
  };
  let loading = false;
  let refreshNeeded = false;
  let badgesNeeded = false;
  let disconnected = false;

  function navigate(next: View) {
    view = next;
    previous = "";
    for (const tab of tabs) {
      const selected = tab === view.tab;
      const button = element(`tab-${tab}`);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      element(tab).hidden = !selected;
    }
    if (view.tab !== "decisions") {
      const panel = element(view.tab);
      const details = view.goalId || view.taskId;
      panel.replaceChildren(
        ...breadcrumb(view),
        textElement("p", "読み込み中…"),
      );
      if (details)
        panel.querySelector("button")?.focus({ preventScroll: true });
      panel.scrollTop = 0;
    }
    void refresh();
  }

  for (const [index, tab] of tabs.entries()) {
    const button = element(`tab-${tab}`);
    button.addEventListener("click", () => navigate({ tab }));
    button.addEventListener("keydown", (event) => {
      const next = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      const target = next === undefined ? undefined : tabs[next];
      if (!target) return;
      event.preventDefault();
      navigate({ tab: target });
      element(`tab-${target}`).focus();
    });
  }

  function breadcrumb({ tab, goalId, taskId }: View) {
    if (!goalId && !taskId) return [];
    const nav = document.createElement("nav");
    nav.className = "breadcrumb";
    nav.setAttribute("aria-label", "パンくずリスト");
    nav.append(
      action(tab === "goals" ? "Goal 一覧" : "問題", "back-list", () => {
        navigate({ tab });
        element(`tab-${tab}`).focus();
      }),
    );
    if (taskId && goalId)
      nav.append(
        action("Goal 詳細", "back-goal", () => navigate({ tab, goalId })),
      );
    return [nav];
  }

  function renderWork(view: View, data: unknown, contents: () => Node[]) {
    const snapshot = JSON.stringify(data);
    const panel = element(view.tab);
    if (snapshot === previous || panel.querySelector("[data-policy-editing]"))
      return;
    previous = snapshot;
    const focused = document.activeElement;
    const focusKey =
      focused instanceof HTMLButtonElement && panel.contains(focused)
        ? focused.dataset.focusKey
        : undefined;
    panel.replaceChildren(...breadcrumb(view), ...contents());
    if (focusKey) {
      const replacement = [...panel.querySelectorAll("button")].find(
        (button) => button.dataset.focusKey === focusKey,
      );
      (replacement ?? element(`tab-${view.tab}`)).focus({
        preventScroll: true,
      });
    }
  }

  async function refresh(updateBadges = true) {
    if (
      disconnected ||
      document.hidden ||
      channel.socket.readyState !== WebSocket.OPEN
    )
      return;
    refreshNeeded = true;
    badgesNeeded ||= updateBadges;
    if (loading) return;
    loading = true;
    try {
      do {
        refreshNeeded = false;
        const refreshBadges = badgesNeeded;
        badgesNeeded = false;
        const current = view;
        const listView = !current.goalId && !current.taskId;
        const [items, problems, goals, goal, task, policy, history] =
          await Promise.allSettled([
            refreshBadges || current.tab === "decisions"
              ? channel.request("inbox.list", {})
              : undefined,
            refreshBadges || (listView && current.tab === "problems")
              ? channel.request("problem.list", {})
              : undefined,
            refreshBadges || (listView && current.tab === "goals")
              ? channel.request("goal.list", {})
              : undefined,
            current.goalId && !current.taskId
              ? channel.request("goal.get", { id: current.goalId })
              : undefined,
            current.taskId
              ? channel.request("task.get", { id: current.taskId })
              : undefined,
            current.tab === "delegation"
              ? channel.request("policy.get", {})
              : undefined,
            current.tab === "decisions"
              ? channel.request("decision.history", {})
              : undefined,
          ] as const);
        if (disconnected) return;
        if (items.status === "fulfilled" && items.value) {
          element("badge-decisions").textContent = String(
            items.value.filter(
              ({ weight, state }) =>
                weight === "action" && state !== "resolved",
            ).length,
          );
          if (view.tab === "decisions") inbox.render(items.value);
        }
        if (problems.status === "fulfilled" && problems.value)
          element("badge-problems").textContent = String(problems.value.length);
        if (goals.status === "fulfilled" && goals.value)
          element("badge-goals").textContent = String(
            goals.value.filter(({ status }) => status === "active").length,
          );
        if (current !== view) continue;

        const { tab, goalId, taskId } = current;
        const active = taskId
          ? task
          : goalId
            ? goal
            : tab === "problems"
              ? problems
              : tab === "goals"
                ? goals
                : tab === "delegation"
                  ? policy
                  : items;
        notice.textContent =
          active.status === "rejected"
            ? "ホストパネルを更新できませんでした。"
            : "";
        if (tab === "decisions") {
          const snapshot = JSON.stringify(history);
          if (snapshot !== previousHistory) {
            previousHistory = snapshot;
            element("decision-history").replaceChildren(
              ...(history.status === "fulfilled" && history.value
                ? decisionHistory(
                    history.value,
                    (taskId) => navigate({ tab: "goals", taskId }),
                    (goalId) => navigate({ tab: "goals", goalId }),
                  )
                : [textElement("p", "AI の判断履歴を取得できませんでした。")]),
            );
          }
          continue;
        }
        if (active.status === "rejected") {
          renderWork(current, null, () => [
            textElement("p", "詳細または一覧を取得できませんでした。"),
          ]);
        } else if (task.status === "fulfilled" && task.value) {
          const detail = task.value;
          renderWork(current, detail, () =>
            taskDetail(detail, taskDelegation(detail, channel, savedPolicy)),
          );
        } else if (goal.status === "fulfilled" && goal.value) {
          const detail = goal.value;
          renderWork(current, detail, () =>
            goalDetail(
              detail,
              goalDelegation(detail, channel, savedPolicy),
              (taskId) => navigate({ tab, goalId: detail.id, taskId }),
            ),
          );
        } else if (
          tab === "delegation" &&
          policy.status === "fulfilled" &&
          policy.value
        ) {
          const settings = policy.value;
          renderWork(current, settings, () => [
            delegationPanel(settings, channel, savedPolicy),
          ]);
        } else if (
          tab === "goals" &&
          goals.status === "fulfilled" &&
          goals.value
        ) {
          const rows = goals.value;
          renderWork(current, rows, () =>
            rows.length
              ? [
                  list(rows, (goal) => {
                    const item = document.createElement("div");
                    item.append(
                      modelLink("Goal", goal.title, goal.id, () =>
                        navigate({ tab, goalId: goal.id }),
                      ),
                      textElement("p", labels[goal.status]),
                      ...progress(goal),
                    );
                    return item;
                  }),
                ]
              : [textElement("p", "Goal はありません。")],
          );
        } else if (
          tab === "problems" &&
          problems.status === "fulfilled" &&
          problems.value
        ) {
          const rows = problems.value;
          renderWork(current, rows, () =>
            rows.length
              ? [
                  list(rows, (problem) =>
                    problemRow(problem, () => {
                      if (problem.taskId)
                        navigate({ tab, taskId: problem.taskId });
                      else if (problem.goalId)
                        navigate({ tab, goalId: problem.goalId });
                    }),
                  ),
                ]
              : [textElement("p", "問題はありません。")],
          );
        }
      } while (refreshNeeded && !document.hidden);
    } finally {
      loading = false;
    }
  }

  let poll = 0;
  const interval = window.setInterval(
    () => void refresh(++poll % 4 === 0),
    5000,
  );
  const becameVisible = () => void refresh();
  document.addEventListener("visibilitychange", becameVisible);
  return {
    refresh,
    disconnect() {
      disconnected = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", becameVisible);
      inbox.disconnect();
    },
  };
}
