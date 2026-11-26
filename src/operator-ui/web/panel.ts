import {
  action,
  element,
  group,
  restoreFocus,
  sectionTitle,
  textElement,
} from "./dom.ts";
import {
  delegationPanel,
  goalDelegation,
  taskDelegation,
} from "./delegation-panel.ts";
import { taskStages } from "../../local-orchestrator/operator-estimates.ts";
import type { PanelAnswer } from "../../local-orchestrator/proposal-answer.ts";
import type { WorkplaceChannel } from "./channel.ts";
import {
  estimateLabel,
  gateLabels,
  settingLabel,
  formatDuration,
  formatTimestamp,
  formatTokens,
  pendingDecisions,
  groupProblems,
  retryCommand,
  withheld,
  type AgentDecision,
  type AnswerableProposal,
  type GoalDetail,
  type GoalSummary,
  type PanelInboxItem,
  type Problem,
  type Proposal,
  type TaskDetail,
  type TaskSummary,
} from "./protocol.ts";

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

const answerLabels = {
  goal: "Goal の提案",
  task: "Task の提案",
  integration: "統合",
} as const;
const proposalLabels: Partial<Record<PanelInboxItem["kind"], string>> = {
  "goal-registration": answerLabels.goal,
  "task-registration": answerLabels.task,
  integration: answerLabels.integration,
  "secret-test-required": "シークレットの動作確認",
} as const;

function chip(label: string, tone: string) {
  return textElement("span", label, `chip ${tone}`);
}

function displayState(state: keyof typeof labels) {
  const tone = {
    registered: "info",
    running: "accent",
    review: "accent",
    "awaiting-integration": "warn",
    done: "ok",
    failed: "danger",
    cancelled: "info",
    active: "accent",
  }[state];
  return chip(labels[state], tone);
}

function aiTag() {
  const tag = textElement("span", "AI", "aitag");
  tag.title = "モデルが書いた文";
  tag.setAttribute("role", "img");
  tag.setAttribute("aria-label", "モデル生成");
  return tag;
}

function modelTitle<K extends "h2" | "h3" | "span">(
  tag: K,
  value: string,
  classes = "title",
) {
  return group(tag, classes, aiTag(), textElement("bdi", value));
}

function modelBox(label: string, lines: readonly string[]) {
  return group(
    "div",
    "card",
    group("h3", "section-title", aiTag(), document.createTextNode(label)),
    ...lines.map((line) => textElement("pre", line, "model-content")),
  );
}

function facts(rows: readonly (readonly [string, string | Node])[]) {
  return group(
    "dl",
    "detail",
    ...rows.flatMap(([label, value]) => [
      textElement("dt", label),
      group(
        "dd",
        "",
        typeof value === "string" ? document.createTextNode(value) : value,
      ),
    ]),
  );
}

function empty(message: string) {
  return textElement("p", message, "card empty");
}

function time(at: string | null) {
  const node = textElement("time", formatTimestamp(at));
  if (at !== null) node.dateTime = at;
  return node;
}

function progress(value: number, max: number, label: string, over = false) {
  const track = textElement(
    "progress",
    "",
    over ? "progress over" : "progress",
  );
  track.max = max || 1;
  track.value = value;
  track.setAttribute("aria-label", label);
  return track;
}

function commandControls(
  command: string,
  label: string,
  key: string,
  show: boolean,
) {
  const text = textElement("pre", command, "cmd");
  text.hidden = !show;
  const status = textElement("span", "", "muted");
  status.setAttribute("role", "status");
  const copy = action(label, key, () => void copyCommand());
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      status.textContent = "コピーしました。";
    } catch {
      text.hidden = false;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      status.textContent = "コマンドを選択しました。";
    }
  }
  return { text, copy, status };
}

function answerError(code: string) {
  switch (code) {
    case "stale-digest":
      return "内容が変わりました。もう一度確認してください";
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

const withheldText = "資格情報のような文字列を含むため隠しました";
const withheldApproval =
  "隠した項目があるため、画面からは承認できません。CLI で内容を確認してください。";

function proposalList(
  value: readonly string[] | { readonly withheld: true },
  classes?: string,
) {
  return "withheld" in value
    ? textElement("p", withheldText)
    : textElement("pre", value.join("\n") || "なし", classes);
}

function proposalEvidence(proposal: Proposal) {
  const { origin, budgets, effectivePolicy, policySource, ruleId, ruleName } =
    proposal;
  const hasWithheld =
    Object.values(proposal).some(withheld) ||
    Object.values(proposal.modelText).some(withheld);
  const policy =
    effectivePolicy && policySource
      ? `${effectivePolicy === "human" ? "人" : "AI"} · ${settingLabel({
          policy: effectivePolicy,
          source: policySource,
          ...(ruleId !== undefined && {
            ruleId: typeof ruleId === "string" ? ruleId : withheldText,
          }),
          ...(ruleName !== undefined && {
            ruleName: typeof ruleName === "string" ? ruleName : withheldText,
          }),
          ...(proposal.invariant && { invariant: proposal.invariant }),
        })}`
      : "—";
  const hostFacts: [string, string | Node][] = [
    [
      "提案元",
      origin.kind === "actor"
        ? origin.actor
        : origin.kind === "host"
          ? "ホスト"
          : "オペレーター",
    ],
    ["適用ポリシー", policy],
    [
      "予算",
      `${formatDuration(budgets.maxExecutionMs)} / ${formatTokens(budgets.maxTokens)} トークン / 再試行 ${budgets.maxRetries} 回`,
    ],
    ["範囲外のパス", proposalList(proposal.pathViolations)],
  ];
  if (proposal.humanAnswerRequired || proposal.humanApprovalRequired)
    hostFacts.push(["人の判断", "必要"]);
  if (proposal.loosening.length)
    hostFacts.push(["委任範囲", "拡大を含みます。"]);

  const model = group(
    "section",
    "stack",
    textElement("h4", "AI の記述", "section-title"),
  );
  if (proposal.kind === "integration") {
    hostFacts.unshift(
      ["変更ファイル数", String(proposal.changedFiles)],
      [
        "変更行数",
        proposal.changedLines === null ? "—" : String(proposal.changedLines),
      ],
      ["変更パス", proposalList(proposal.changedPaths)],
      [
        "変更規模",
        typeof proposal.diffStat === "string"
          ? textElement("pre", proposal.diffStat.trim())
          : withheldText,
      ],
    );
    const { verdict, findings } = proposal.modelText;
    model.append(textElement("p", `レビュー（AI）: ${verdict}`));
    if (findings !== null)
      model.append(
        facts([
          [
            "所見",
            textElement(
              "pre",
              typeof findings === "string" ? findings : withheldText,
              "model-content proposal-text",
            ),
          ],
        ]),
      );
  } else {
    hostFacts.unshift(["対象パス", proposalList(proposal.paths)]);
    if (proposal.kind === "goal")
      hostFacts.push(
        ["実行ロール", proposal.actors.join("、") || "なし"],
        ["プロファイル", proposal.profiles.join("、") || "なし"],
        ["Task 上限", String(proposal.maxTasks)],
      );
    else
      hostFacts.push(
        ["実行ロール", proposal.actor],
        ["プロファイル", proposal.profile],
      );
    const { description, acceptance } = proposal.modelText;
    model.append(
      facts([
        [
          "説明",
          textElement(
            "pre",
            typeof description === "string"
              ? description || "なし"
              : withheldText,
            "model-content proposal-text",
          ),
        ],
        [
          "受け入れ条件",
          "withheld" in acceptance
            ? textElement("p", withheldText)
            : acceptance.length
              ? group(
                  "ul",
                  "",
                  ...acceptance.map((item) =>
                    textElement("li", item, "model-content proposal-text"),
                  ),
                )
              : textElement("p", "なし"),
        ],
      ]),
    );
  }
  const content = group("div", "stack", facts(hostFacts), model);
  if (hasWithheld)
    content.append(textElement("p", withheldApproval, "warning"));
  return { content, hasWithheld };
}

type Watch = (
  node: HTMLElement,
  ids: readonly string[],
  load?: () => void,
) => void;
type GoalLink = (id?: string | null) => Node[];

export function createInboxPanel(
  channel: Pick<WorkplaceChannel, "request">,
  refresh: () => void,
  watch: Watch,
  unwatch: (root: HTMLElement) => void,
) {
  const inbox = element("inbox-items");
  const batch = element("answer-batch");
  const results = element("answer-results");
  const chosen = new Map<string, string>();
  const expanded = new Set<string>();
  let proposals: AnswerableProposal[] = [];
  let controls: (() => void)[] = [];
  let answering = false;
  let cancelConfirmation: (() => void) | undefined;
  let activeSubmit: HTMLButtonElement | undefined;
  let previous = "";
  const stale = new Set<string>();

  const selection = textElement("span", "", "q");
  const clear = action(
    "選択を解除",
    "clear-selection",
    () => {
      cancelConfirmation?.();
      chosen.clear();
      updateControls();
      inbox.querySelector<HTMLElement>("input")?.focus();
    },
    "link",
  );
  const batchButton = action(
    "",
    "approve-batch",
    () => {
      const pinned = proposals.filter(
        ({ id, digest }) => chosen.get(id) === digest,
      );
      if (pinned.length >= 2) confirm(batch, pinned, "approve", batchButton);
    },
    "btn primary",
  );
  const batchActions = group("div", "actions", selection, clear, batchButton);
  batch.append(batchActions);

  function updateControls() {
    for (const update of controls) update();
    batch.hidden = chosen.size < 2;
    clear.disabled = batchButton.disabled = answering;
    selection.textContent = `${chosen.size} 件を選択中`;
    batchButton.textContent = `${chosen.size} 件をまとめて承認`;
  }

  function confirm(
    container: HTMLElement,
    pinned: AnswerableProposal[],
    decision: PanelAnswer["decision"],
    trigger: HTMLElement,
  ) {
    if (answering) return;
    cancelConfirmation?.();
    const reject = decision === "reject";
    const integration =
      pinned.length === 1 && pinned[0]?.kind === "integration";
    const label = reject ? "却下" : integration ? "承認して統合" : "承認";
    const question = reject
      ? "この提案を却下しますか。"
      : pinned.length > 1
        ? `${pinned.length} 件をまとめて承認しますか。${pinned.some(({ kind }) => kind === "integration") ? "統合を含む提案は承認すると Goal のブランチに統合されます。" : ""}`
        : integration
          ? "この変更を Goal のブランチに統合しますか。"
          : "この提案を承認しますか。";
    const review = group("div", "q", textElement("p", question));
    if (pinned.length > 1) review.tabIndex = 0;
    const cancel = action("戻す", "cancel-answer", () => {
      close();
      trigger.focus();
    });
    const submit = action(
      pinned.length > 1 ? "確定" : `${label}を確定`,
      "submit-answer",
      () => void send(),
      reject ? "btn danger" : "btn primary",
    );
    const strip = group(
      "div",
      reject ? "confirm reject" : "confirm",
      review,
      cancel,
      submit,
    );
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "回答の確認");
    const actions =
      container === batch
        ? batchActions
        : container.querySelector<HTMLElement>(".decision-actions");
    if (actions) actions.hidden = true;
    container.append(strip);
    activeSubmit = submit;
    cancelConfirmation = close;
    const previews: Promise<boolean>[] = [];
    for (const proposal of pinned) {
      const { id, kind, title, agentGates } = proposal;
      const evidence = textElement(
        "p",
        `${answerLabels[kind]} · ${id.slice(0, 8)}`,
        "muted",
      );
      if (title !== null && pinned.length > 1)
        evidence.prepend(modelTitle("span", title, "model-content"), " · ");
      review.append(evidence);
      if (!reject && agentGates.length)
        review.append(
          textElement(
            "p",
            `この提案には AI へ判断を委任する設定が含まれます（${agentGates.map((gate) => gateLabels[gate]).join("、")}）。`,
            "warning",
          ),
        );
      if (!reject) {
        const detail = textElement("div", "提案の詳細を読み込み中…");
        detail.setAttribute("role", "status");
        review.append(detail);
        previews.push(loadEvidence(proposal, detail));
      }
    }
    if (previews.length) {
      submit.disabled = true;
      void Promise.all(previews).then((ready) => {
        if (activeSubmit === submit) submit.disabled = !ready.every(Boolean);
      });
    }
    cancel.focus();

    function close() {
      strip.remove();
      if (actions) actions.hidden = false;
      activeSubmit = undefined;
      cancelConfirmation = undefined;
    }

    async function loadEvidence(
      answer: AnswerableProposal,
      detail: HTMLElement,
    ) {
      try {
        const proposal = await channel.request("proposal.get", {
          id: answer.id,
        });
        if (activeSubmit !== submit) return false;
        if (proposal.digest !== answer.digest) {
          stale.add(answer.id);
          detail.textContent = answerError("stale-digest");
          previous = "";
          refresh();
          return false;
        }
        if (proposal.status !== "pending") {
          detail.textContent = answerError("invalid-transition");
          refresh();
          return false;
        }
        const { content, hasWithheld } = proposalEvidence(proposal);
        detail.replaceChildren(content);
        return !hasWithheld;
      } catch {
        detail.textContent = "提案の詳細を取得できませんでした。";
        return false;
      }
    }

    async function send() {
      if (answering || activeSubmit !== submit || submit.disabled) return;
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
        for (const outcome of outcomes)
          if ("error" in outcome && outcome.error.code === "stale-digest")
            stale.add(outcome.id);
        results.replaceChildren(
          ...outcomes.map((outcome) =>
            textElement(
              "p",
              `${outcome.id.slice(0, 8)} · ${
                "ok" in outcome
                  ? `${label}を記録しました。`
                  : answerError(outcome.error.code)
              }`,
              "ok" in outcome ? "notice" : "status-error",
            ),
          ),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "stale-digest")
          for (const { id } of answers) stale.add(id);
        results.replaceChildren(
          textElement(
            "p",
            answerError(
              error instanceof Error ? error.message : "write-failed",
            ),
            "status-error",
          ),
        );
      } finally {
        if (answers.some(({ id }) => stale.has(id))) previous = "";
        for (const { id } of answers) chosen.delete(id);
        answering = false;
        if (activeSubmit === submit) {
          close();
          (pinned.length === 1 ? trigger : element("tab-decisions")).focus({
            preventScroll: true,
          });
        }
        updateControls();
        refresh();
      }
    }
  }

  function card(item: PanelInboxItem, goalLink: GoalLink) {
    const answer = "answer" in item ? item.answer : undefined;
    const name = answer?.title ?? item.modelText;
    const id = item.subject.proposalId;
    const needsReview = id !== undefined && stale.has(id);
    const reason = textElement(
      "span",
      needsReview ? answerError("stale-digest") : "確認が必要です。",
    );
    const kind = proposalLabels[item.kind] ?? item.title;
    const top = group(
      "div",
      "card-top",
      chip(kind, item.kind === "integration" || !answer ? "warn" : "accent"),
      reason,
    );
    const row = textElement("li", "", "card");
    const detail = textElement("div", "", "stack");
    detail.hidden = !needsReview && !expanded.has(item.id);
    if (needsReview) expanded.add(item.id);
    const fields = facts([
      ...Object.entries(item.subject),
      ["時刻", time(item.at)],
    ]);
    const command = commandControls(
      item.next,
      "CLI コマンドをコピー",
      `copy:${item.id}`,
      true,
    );
    const info = textElement("div", "", "stack");
    detail.append(
      fields,
      info,
      command.text,
      group("div", "actions", command.copy, command.status),
    );
    const toggle = action(
      "",
      `detail:${item.id}`,
      () => {
        detail.hidden = !detail.hidden;
        if (detail.hidden) expanded.delete(item.id);
        else {
          expanded.add(item.id);
          void load();
        }
        updateDisclosure();
      },
      "link",
    );
    function updateDisclosure() {
      toggle.textContent = detail.hidden ? "詳細" : "詳細を閉じる";
      toggle.setAttribute("aria-expanded", String(!detail.hidden));
    }
    updateDisclosure();
    const actions = group(
      "div",
      "actions decision-actions",
      toggle,
      textElement("span", "", "spacer"),
    );
    const answerArea = group("div", "", actions);
    if (answer?.approve) {
      const checkbox = textElement("input", "", "check");
      checkbox.type = "checkbox";
      checkbox.dataset.focusKey = `choose:${item.id}`;
      checkbox.setAttribute(
        "aria-label",
        `${name ?? kind} をまとめて承認する項目に追加`,
      );
      checkbox.addEventListener("change", () => {
        cancelConfirmation?.();
        if (checkbox.checked) chosen.set(answer.id, answer.digest);
        else chosen.delete(answer.id);
        updateControls();
      });
      controls.push(() => {
        checkbox.checked = chosen.get(answer.id) === answer.digest;
        checkbox.disabled =
          answering || (!checkbox.checked && chosen.size >= 20);
      });
      top.prepend(checkbox);
    }
    if (answer) {
      if (answer.reject) answerButton("却下", "reject", "btn secondary");
      if (answer.approve)
        answerButton(
          answer.kind === "integration" ? "承認して統合" : "承認",
          "approve",
          "btn primary",
        );
    }
    function answerButton(
      label: string,
      decision: PanelAnswer["decision"],
      classes: string,
    ) {
      if (!answer) return;
      const button = action(
        label,
        `${decision}:${item.id}`,
        () => confirm(answerArea, [answer], decision, button),
        classes,
      );
      actions.append(button);
      controls.push(() => {
        button.disabled = answering;
      });
    }
    row.append(
      top,
      name ? modelTitle("h3", name) : textElement("h3", item.title, "title"),
      ...goalLink(item.subject.goalId),
      detail,
      answerArea,
    );
    let requested = false;
    async function load() {
      if (!id || requested) return;
      requested = true;
      info.textContent = "提案の詳細を読み込み中…";
      try {
        const proposal = await channel.request("proposal.get", { id });
        if (answer && proposal.digest !== answer.digest) {
          reason.textContent = answerError("stale-digest");
          if (!stale.has(id)) {
            stale.add(id);
            previous = "";
            refresh();
          }
        }
        info.replaceChildren(proposalEvidence(proposal).content);
      } catch {
        requested = false;
        info.textContent = "提案の詳細を取得できませんでした。";
      }
    }
    if (!detail.hidden) void load();
    watch(row, item.state === "open" ? [item.id] : []);
    return row;
  }

  return {
    invalidate() {
      previous = "";
    },
    render(
      rows: PanelInboxItem[],
      goalLink: GoalLink,
      goalTitle: (id?: string) => string | undefined,
    ) {
      const snapshot = JSON.stringify(
        rows.map(({ state: _state, ...row }) => [
          row,
          goalTitle(row.subject.goalId),
        ]),
      );
      if (snapshot === previous) return;
      previous = snapshot;
      proposals = rows.flatMap((item) =>
        "answer" in item ? [item.answer] : [],
      );
      const approvable = new Map(
        proposals
          .filter(({ approve }) => approve)
          .map(({ id, digest }) => [id, digest]),
      );
      for (const [id, digest] of chosen)
        if (approvable.get(id) !== digest) chosen.delete(id);
      for (const id of stale)
        if (!rows.some((row) => row.subject.proposalId === id))
          stale.delete(id);
      for (const id of expanded)
        if (!rows.some((row) => row.id === id)) expanded.delete(id);
      controls = [];
      restoreFocus(
        inbox,
        () => {
          cancelConfirmation?.();
          unwatch(inbox);
          inbox.replaceChildren(...rows.map((item) => card(item, goalLink)));
        },
        element("tab-decisions"),
      );
      element("empty-inbox").hidden = rows.length !== 0;
      updateControls();
    },
  };
}

function historyCards(
  rows: AgentDecision[],
  openSettings: () => void,
  titleFor: (entry: AgentDecision) => string | undefined,
  openSubject: (subject: { goalId?: string; taskId?: string }) => void,
) {
  return [
    sectionTitle("AI が判断したもの"),
    rows.length
      ? group(
          "div",
          "card",
          ...rows.map((entry) => {
            const approved = entry.result === "approve";
            const title = titleFor(entry);
            const { goalId, taskId } = entry;
            const subject = taskId || goalId;
            const caption = title
              ? modelTitle("span", title, "model-content")
              : textElement(
                  "span",
                  `${taskId ? "Task" : goalId ? "Goal" : "提案"} ${(subject ?? entry.proposalId).slice(0, 8)}`,
                );
            const link = action(
              "",
              `history:${entry.id}`,
              () =>
                openSubject({
                  ...(goalId && { goalId }),
                  ...(taskId && { taskId }),
                }),
              "link",
            );
            link.append(caption);
            const names = group(
              "span",
              "grow",
              document.createTextNode(`${gateLabels[entry.gate]} · `),
              subject ? link : caption,
              document.createTextNode(" · "),
              action(
                settingLabel(entry.setting),
                `rule:${entry.id}`,
                openSettings,
                "link",
              ),
            );
            const row = group(
              "div",
              "activity",
              time(entry.at),
              chip(
                approved ? "AI が承認" : "AI が却下",
                approved ? "ok" : "info",
              ),
              names,
            );
            if (!entry.reasons.length) return row;
            const more = group(
              "details",
              "",
              textElement("summary", "Reviewer の理由", "muted"),
              modelBox("理由", entry.reasons),
            );
            return group("div", "", row, more);
          }),
        )
      : empty("AI の判断はありません。"),
  ];
}

function goalOverview(
  goal: GoalSummary,
  pending: number,
  openDecisions?: () => void,
) {
  const { done, total } = goal.progress;
  const summary = `${done} / ${total} Task 完了`;
  const estimate = estimateLabel(goal.estimate.remainingMs);
  return [
    group(
      openDecisions ? "div" : "span",
      "rowline",
      modelTitle(openDecisions ? "h2" : "span", goal.title, "title grow"),
      displayState(goal.status),
    ),
    progress(done, total, summary),
    group(
      openDecisions ? "div" : "span",
      "rowline meta",
      textElement(
        "span",
        estimate ? `${summary} · ${estimate}` : summary,
        "grow",
      ),
      ...(pending
        ? [
            openDecisions
              ? action(
                  `判断待ち ${pending} 件を見る ›`,
                  "goal-decisions",
                  openDecisions,
                  "link",
                )
              : chip(`判断待ち ${pending}`, "warn"),
          ]
        : []),
    ),
  ];
}

function goalRow(goal: GoalSummary, pending: number, open: () => void) {
  const button = action("", goal.id, open, "card goalrow");
  button.append(...goalOverview(goal, pending));
  return button;
}

function taskRow(task: TaskSummary, open: () => void) {
  const row = action("", task.id, open, "taskrow");
  const estimate = estimateLabel(task.estimate.remainingMs);
  row.append(modelTitle("span", task.title, "t"), displayState(task.stage));
  if (estimate) row.append(textElement("span", estimate, "eta"));
  return row;
}

function goalDetail(
  goal: GoalDetail,
  pending: number,
  delegation: Node,
  activity: PanelInboxItem[],
  selectTask: (id: string) => void,
  openDecisions: () => void,
  watch: Watch,
) {
  const scope = goal.scope;
  const details = group(
    "details",
    "card",
    textElement("summary", "Goal の詳細"),
    facts([
      ["対象パス", scope.paths.join(", ")],
      ["利用できるアクター", scope.actors.join(", ") || "—"],
      ["プロファイル", scope.profiles.join(", ") || "—"],
      ["Task 上限", String(scope.maxTasks)],
      [
        "予算",
        `${formatDuration(goal.budgets.maxExecutionMs)} / ${formatTokens(goal.budgets.maxTokens)} トークン / 再試行 ${goal.budgets.maxRetries} 回`,
      ],
      ["ブランチ", goal.branch],
      ["ベースコミット", goal.baseCommit ?? "—"],
    ]),
    ...(goal.description ? [modelBox("説明", [goal.description])] : []),
    modelBox("受け入れ条件", goal.acceptance),
  );
  const activityLabels: Partial<Record<PanelInboxItem["kind"], string>> = {
    "task-running": "Task の実行を開始しました。",
    "task-succeeded": "Task が完了しました。",
    "goal-completed": "Goal が完了しました。",
  };
  const recent = activity.map((item) => {
    const row = group(
      "div",
      "activity",
      time(item.at),
      group(
        "span",
        "grow",
        document.createTextNode(activityLabels[item.kind] ?? item.title),
        ...(item.modelText
          ? [
              document.createTextNode(" "),
              modelTitle("span", item.modelText, "model-content"),
            ]
          : []),
      ),
    );
    watch(row, item.state === "open" ? [item.id] : []);
    return row;
  });
  return [
    group("header", "card", ...goalOverview(goal, pending, openDecisions)),
    sectionTitle("Task"),
    goal.tasks.length
      ? group(
          "div",
          "card tasklist",
          ...goal.tasks.map((task) => taskRow(task, () => selectTask(task.id))),
        )
      : empty("Task はありません。"),
    ...(goal.progress.total > goal.tasks.length
      ? [
          textElement(
            "p",
            `${goal.progress.total} 件中 ${goal.tasks.length} 件を表示しています。`,
            "meta",
          ),
        ]
      : []),
    delegation,
    sectionTitle("最近の動き"),
    recent.length
      ? group("div", "card", ...recent)
      : empty("最近の動きはありません。"),
    details,
  ];
}

function tokenBudget(task: TaskDetail) {
  const tokens = task.tokensUsed;
  const max = task.budgets.maxTokens;
  const usage =
    tokens === null
      ? "不明"
      : `${task.tokensIncomplete ? "少なくとも " : ""}${formatTokens(tokens)}`;
  const label = `${usage} / ${formatTokens(max)} トークン`;
  return [
    textElement("p", label, "meta"),
    ...(tokens === null || max === 0
      ? []
      : [progress(tokens, max, label, tokens > max)]),
  ];
}

function rejectedPaths(
  paths: NonNullable<NonNullable<TaskDetail["failure"]>["rejectedPaths"]>,
) {
  return group(
    "ul",
    "stack",
    ...paths.map(({ path, symlink }) =>
      group(
        "li",
        "",
        textElement("code", symlink ? `${path}（シンボリックリンク）` : path),
      ),
    ),
  );
}

function failureCard(task: TaskDetail, command: string | undefined) {
  if (!task.failure) return [];
  const { code, rejectedPaths: paths } = task.failure;
  const retry = command
    ? commandControls(command, "再試行コマンドをコピー", "copy-retry", true)
    : undefined;
  return [
    group(
      "div",
      "card banner-danger",
      group(
        "div",
        "rowline",
        chip("失敗", "danger"),
        textElement("code", code, "grow"),
        ...(retry ? [retry.copy, retry.status] : []),
      ),
      ...(paths?.length
        ? [sectionTitle("拒否されたパス"), rejectedPaths(paths)]
        : []),
      ...(retry ? [retry.text] : []),
    ),
  ];
}

function taskDetail(
  task: TaskDetail,
  delegation: Node,
  pending: PanelInboxItem | undefined,
  openDecisions: () => void,
  command: string | undefined,
) {
  const current = task.failure?.stage ?? task.stage;
  const currentIndex = taskStages.findIndex((stage) => stage === current);
  const stages = group(
    "ol",
    "stages",
    ...taskStages.map((stage, index) => {
      const active = stage === current;
      const failed = Boolean(task.failure && active);
      const tone = failed
        ? "fail"
        : active
          ? "now"
          : index < currentIndex
            ? "done"
            : "";
      const item = textElement(
        "li",
        failed ? `${labels[stage]}（失敗）` : labels[stage],
        `stage ${tone}`,
      );
      if (active) item.setAttribute("aria-current", "step");
      return item;
    }),
  );
  stages.setAttribute("aria-label", "段階");
  const estimate = estimateLabel(task.estimate.remainingMs);
  return [
    ...(pending
      ? [
          group(
            "div",
            "card banner-warn",
            group(
              "div",
              "rowline",
              chip("判断待ち", "warn"),
              textElement(
                "span",
                "この Task の判断を待っています。",
                "grow meta",
              ),
              action(
                "判断待ちで答える",
                "task-decision",
                openDecisions,
                "btn primary",
              ),
            ),
          ),
        ]
      : []),
    ...failureCard(task, command),
    group(
      "header",
      "card",
      group(
        "div",
        "rowline",
        modelTitle("h2", task.title, "title large grow"),
        displayState(task.stage),
      ),
      stages,
      facts([
        ...(estimate ? [["残り時間", estimate] as const] : []),
        ["対象パス", task.paths.join(", ") || "—"],
        ["実行者", task.actor],
        ["試行", `${task.attempt.current} / ${task.attempt.max}`],
        [
          "経過時間",
          `${formatDuration(task.elapsedMs)}（上限 ${formatDuration(task.budgets.maxExecutionMs)}）`,
        ],
      ]),
      ...tokenBudget(task),
    ),
    delegation,
    group(
      "details",
      "card",
      textElement("summary", "Task の詳細"),
      ...(task.category
        ? [modelBox("Planner の申告カテゴリー", [task.category])]
        : []),
      ...(task.description ? [modelBox("説明", [task.description])] : []),
      modelBox("受け入れ条件", task.acceptance),
      sectionTitle("最近の実行"),
      ...(task.executions.length
        ? task.executions.map(
            ({ actor, mode, status, startedAt, finishedAt, tokens }) =>
              textElement(
                "p",
                `${actor} / ${mode} / ${status} · ${formatTimestamp(startedAt)} → ${formatTimestamp(finishedAt)} · ${formatTokens(tokens)} トークン`,
                "meta",
              ),
          )
        : [textElement("p", "実行はありません。", "meta")]),
      sectionTitle("最近のイベント"),
      ...(task.events.length
        ? task.events.map(({ kind, at }) =>
            textElement("p", `${formatTimestamp(at)} · ${kind}`, "meta"),
          )
        : [textElement("p", "イベントはありません。", "meta")]),
    ),
  ];
}

function problemCard(
  rows: Problem[],
  items: PanelInboxItem[],
  channel: WorkplaceChannel,
  goalLink: GoalLink,
  select: (subject: { goalId?: string; taskId?: string }) => void,
  watch: Watch,
) {
  const first = rows[0]!;
  const { goalId, taskId } = first;
  const model = rows.find(({ title }) => title)?.title;
  const failed = rows.some((row) => "canRetry" in row);
  const over = rows.filter(({ kind }) => kind === "execution-over-budget");
  const canRetry = rows.some((row) => "canRetry" in row && row.canRetry);
  const command = taskId && canRetry ? retryCommand(taskId, items) : undefined;
  const matching = items.filter(
    (item) =>
      item.state === "open" &&
      ((item.kind === "task-failed" &&
        Boolean(taskId) &&
        item.subject.taskId === taskId) ||
        (item.kind === "execution-over-budget" &&
          over.some(
            (problem) => problem.executionId === item.subject.executionId,
          ))),
  );
  const usage = textElement("div", "", "stack");
  const actions = group("div", "actions", textElement("span", "", "spacer"));
  const card = group(
    "article",
    "card",
    group(
      "div",
      "card-top",
      chip(failed ? "失敗" : over.length ? "予算超過" : "対象範囲外", "danger"),
      time(first.at),
    ),
    model
      ? modelTitle("h3", model)
      : textElement("h3", taskId ?? goalId ?? "問題", "title"),
    ...goalLink(goalId),
    ...rows.map((row) =>
      group(
        "div",
        "reason",
        ...(row !== first
          ? [time(row.at), document.createTextNode(" · ")]
          : []),
        document.createTextNode(row.detail),
        ...("rejectedPaths" in row && row.rejectedPaths?.length
          ? [rejectedPaths(row.rejectedPaths)]
          : []),
      ),
    ),
    usage,
    actions,
  );
  if (command) {
    const { text, copy, status } = commandControls(
      command,
      "再試行コマンドをコピー",
      `retry:${taskId}`,
      false,
    );
    actions.append(copy, status);
    card.append(text);
  }
  if (taskId || goalId)
    actions.append(
      action(
        taskId ? "Task を開く" : "Goal を開く",
        `problem:${taskId ?? goalId}`,
        () => select({ ...(goalId && { goalId }), ...(taskId && { taskId }) }),
        "btn primary",
      ),
    );
  watch(
    card,
    matching.map(({ id }) => id),
    over.length && taskId
      ? () => {
          void channel
            .request("task.get", { id: taskId })
            .then((task) => {
              const max = task.budgets.maxTokens;
              const reports = over.flatMap(({ executionId }) => {
                const tokens = task.executions.find(
                  ({ id }) => id === executionId,
                )?.tokens;
                if (tokens == null) return [];
                const label = `${formatTokens(tokens)} / ${formatTokens(max)} トークン`;
                return [
                  textElement(
                    "p",
                    `実行 ${executionId?.slice(0, 8)} · ${label}`,
                    "meta",
                  ),
                  ...(max ? [progress(tokens, max, label, true)] : []),
                ];
              });
              usage.append(...reports);
              if (reports.length === 0) {
                usage.append(
                  sectionTitle("Task 全体のトークン使用量"),
                  ...tokenBudget(task),
                );
              }
            })
            .catch(() => {
              usage.textContent = "トークン使用量を取得できませんでした。";
            });
        }
      : undefined,
  );
  return card;
}

const tabs = ["decisions", "problems", "goals"] as const;
type Tab = (typeof tabs)[number];
type View = { tab: Tab; goalId?: string; taskId?: string };
const settingsSections = {
  delegation: "delegation",
  display: "display-settings",
  connection: "connection-settings",
} as const;
type SettingsSection = keyof typeof settingsSections;

export function createHostPanel(channel?: WorkplaceChannel) {
  const notice = element("inbox-notice");
  let view: View = { tab: "decisions" };
  let settings: SettingsSection | undefined;
  let settingsTrigger: HTMLElement | undefined;
  let previousView = "";
  let previousPolicy = "";
  let previousHistory = "";
  let pendingFocus: string | undefined;
  let loading = false;
  let refreshNeeded = false;
  let badgesNeeded = false;
  let disconnected = true;
  let items: PanelInboxItem[] = [];
  let goals: GoalSummary[] = [];
  let problems: Problem[][] = [];
  let lastGoal: GoalDetail | undefined;
  const marked = new Set<string>();
  const observed = new WeakMap<
    Element,
    { ids: readonly string[]; load?: () => void }
  >();
  const visible = new IntersectionObserver(
    (entries) => {
      const ids = new Set<string>();
      for (const { target, intersectionRatio } of entries) {
        if (intersectionRatio < 0.1 || !target.isConnected) continue;
        const entry = observed.get(target);
        if (!entry) continue;
        visible.unobserve(target);
        entry.load?.();
        for (const id of entry.ids) {
          if (!marked.has(id)) ids.add(id);
        }
      }
      if (!channel || disconnected || !ids.size) return;
      for (const id of ids) marked.add(id);
      void channel.request("inbox.markSeen", { ids: [...ids] }).catch(() => {
        for (const id of ids) marked.delete(id);
        notice.textContent = "受信項目を確認済みにできませんでした。";
      });
    },
    { threshold: 0.1 },
  );
  const watch: Watch = (node, ids, load) => {
    if (!ids.length && !load) return;
    observed.set(node, { ids, ...(load && { load }) });
    visible.observe(node);
  };
  function unwatch(root: HTMLElement) {
    for (const node of root.querySelectorAll("*")) {
      if (observed.has(node)) {
        observed.delete(node);
        visible.unobserve(node);
      }
    }
  }
  const inbox =
    channel && createInboxPanel(channel, () => void refresh(), watch, unwatch);

  function goalTitle(id?: string | null) {
    return id === lastGoal?.id
      ? lastGoal?.title
      : goals.find((goal) => goal.id === id)?.title;
  }

  function goalLink(id?: string | null) {
    if (!id) return [];
    const title = goalTitle(id);
    if (!title) return [];
    const link = action(
      "",
      `goal:${id}`,
      () => navigate({ tab: "goals", goalId: id }),
      "link",
    );
    link.append(textElement("bdi", title), " ›");
    return [group("div", "meta", document.createTextNode("Goal: "), link)];
  }

  function updateVisibility() {
    for (const tab of tabs) {
      const selected = tab === view.tab;
      const button = element(`tab-${tab}`);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      element(tab).hidden = Boolean(settings) || !selected;
    }
    element("host-tabs").hidden = Boolean(settings);
    element("settings-back").hidden = !settings;
    element("settings").hidden = !settings;
    element("settings-toggle").setAttribute(
      "aria-pressed",
      String(Boolean(settings)),
    );
    for (const [key, id] of Object.entries(settingsSections)) {
      const nav = element(`settings-${key}`);
      if (key === settings) nav.setAttribute("aria-current", "page");
      else nav.removeAttribute("aria-current");
      element(id).hidden = key !== settings;
    }
  }

  function openSettings(
    section: SettingsSection,
    trigger = document.activeElement,
  ) {
    if (!settings && trigger instanceof HTMLElement) settingsTrigger = trigger;
    settings = section;
    updateVisibility();
    element(`settings-${section}`).focus();
    if (section === "delegation" && !previousPolicy)
      element("delegation").replaceChildren(
        empty(disconnected ? "ホストに接続されていません。" : "読み込み中…"),
      );
    void refresh(false);
  }

  function closeSettings() {
    if (!settings) return false;
    settings = undefined;
    updateVisibility();
    const target =
      settingsTrigger?.isConnected && !settingsTrigger.closest("[hidden]")
        ? settingsTrigger
        : element(`tab-${view.tab}`);
    target.focus({ preventScroll: true });
    settingsTrigger = undefined;
    void refresh(false);
    return true;
  }
  element("settings-toggle").addEventListener("click", () => {
    if (!closeSettings()) openSettings("delegation");
  });
  element("connection").addEventListener("click", () =>
    openSettings("connection"),
  );
  element("settings-back").addEventListener("click", closeSettings);
  for (const key of Object.keys(settingsSections) as SettingsSection[])
    element(`settings-${key}`).addEventListener("click", () =>
      openSettings(key),
    );

  function breadcrumb(current: View, task?: TaskDetail, goal?: GoalDetail) {
    if (!current.goalId && !current.taskId) return [];
    const nav = group(
      "nav",
      "crumbs",
      action(
        "Goal 一覧",
        "back-list",
        () => {
          navigate({ tab: "goals" });
          element("tab-goals").focus();
        },
        "link",
      ),
    );
    nav.setAttribute("aria-label", "現在地");
    function separator() {
      const node = textElement("span", "›");
      node.setAttribute("aria-hidden", "true");
      nav.append(node);
    }
    const goalId = task?.goalId ?? current.goalId;
    const title = goal?.title ?? goalTitle(goalId);
    if (current.taskId && goalId) {
      separator();
      const back = action(
        "",
        "back-goal",
        () => navigate({ tab: "goals", goalId }),
        "link",
      );
      back.append(textElement("bdi", title ?? "Goal 詳細"));
      nav.append(back);
    }
    separator();
    const here = textElement(
      "bdi",
      task?.title ?? title ?? (current.taskId ? "Task 詳細" : "Goal 詳細"),
    );
    here.setAttribute("aria-current", "page");
    nav.append(here);
    return [nav];
  }

  function navigate(next: View, decisionId?: string) {
    view = next;
    previousView = "";
    pendingFocus = decisionId;
    updateVisibility();
    element(view.tab).scrollTop = 0;
    if (view.tab !== "decisions") {
      const contents = element(
        view.tab === "goals" ? "goal-content" : "problem-content",
      );
      unwatch(contents);
      contents.replaceChildren(
        ...breadcrumb(view),
        empty(disconnected ? "ホストに接続されていません。" : "読み込み中…"),
      );
      if (view.goalId || view.taskId) contents.querySelector("button")?.focus();
    } else {
      if (!focusDecision()) element("tab-decisions").focus();
    }
    void refresh();
  }

  function focusDecision() {
    if (!pendingFocus) return false;
    const target = Array.from(
      element("inbox-items").querySelectorAll<HTMLButtonElement>("button"),
    ).find((node) => node.dataset.focusKey === `detail:${pendingFocus}`);
    if (!target) return false;
    pendingFocus = undefined;
    target.focus();
    return true;
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

  function renderWork(
    data: unknown,
    contents: () => Node[],
    task?: TaskDetail,
    goal?: GoalDetail,
  ) {
    const snapshot = JSON.stringify(data);
    const panel = element(
      view.tab === "goals" ? "goal-content" : "problem-content",
    );
    if (
      snapshot === previousView ||
      panel.querySelector("[data-policy-editing]")
    )
      return;
    previousView = snapshot;
    restoreFocus(
      panel,
      () => {
        const open = panel.querySelector<HTMLDetailsElement>("details[open]");
        unwatch(panel);
        panel.replaceChildren(...breadcrumb(view, task, goal), ...contents());
        const disclosure = panel.querySelector("details");
        if (disclosure && open) disclosure.open = true;
      },
      element(`tab-${view.tab}`),
    );
  }

  function savedPolicy() {
    previousView = previousPolicy = "";
    void refresh(false);
  }

  function badge(tab: Tab, count: number) {
    element(`badge-${tab}`).textContent = count ? String(count) : "";
  }

  async function refresh(updateBadges = true) {
    if (
      !channel ||
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
        const section = settings;
        const socket = channel.socket;
        const loadWork = !section;
        const decisionTab = loadWork && current.tab === "decisions";
        const problemTab = loadWork && current.tab === "problems";
        const goalTab = loadWork && current.tab === "goals";
        const [
          itemResult,
          problemResult,
          goalResult,
          goal,
          task,
          policy,
          history,
        ] = await Promise.allSettled([
          refreshBadges || loadWork
            ? channel.request("inbox.list", {})
            : undefined,
          refreshBadges || problemTab
            ? channel.request("problem.list", {})
            : undefined,
          refreshBadges || (goalTab && !current.goalId && !current.taskId)
            ? channel.request("goal.list", {})
            : undefined,
          goalTab && current.goalId && !current.taskId
            ? channel.request("goal.get", { id: current.goalId })
            : undefined,
          goalTab && current.taskId
            ? channel.request("task.get", { id: current.taskId })
            : undefined,
          section === "delegation"
            ? channel.request("policy.get", {})
            : undefined,
          decisionTab ? channel.request("decision.history", {}) : undefined,
        ] as const);
        if (disconnected || socket !== channel.socket) continue;
        if (itemResult.status === "fulfilled" && itemResult.value) {
          items = itemResult.value;
          const activeIds = new Set(items.map(({ id }) => id));
          for (const id of marked) if (!activeIds.has(id)) marked.delete(id);
        }
        if (problemResult.status === "fulfilled" && problemResult.value)
          problems = groupProblems(problemResult.value);
        if (goalResult.status === "fulfilled" && goalResult.value)
          goals = goalResult.value;
        const pending = pendingDecisions(items);
        badge("decisions", pending.length);
        badge("problems", problems.length);
        badge(
          "goals",
          goals.filter(({ status }) => status === "active").length,
        );
        const reads = [
          itemResult,
          problemResult,
          goalResult,
          goal,
          task,
          policy,
          history,
        ];
        if (
          reads.some(
            (result) =>
              result.status === "fulfilled" && result.value !== undefined,
          )
        )
          element("connection-update").textContent = new Date().toLocaleString(
            "ja-JP",
          );
        if (current !== view || section !== settings) continue;
        if (reads.some(({ status }) => status === "rejected"))
          notice.textContent = "作業の状況を一部更新できませんでした。";
        else if (!section || section === "delegation") notice.textContent = "";

        if (section === "delegation") {
          const panel = element("delegation");
          if (policy.status === "fulfilled" && policy.value) {
            const value = policy.value;
            const snapshot = JSON.stringify(value);
            if (
              snapshot !== previousPolicy &&
              !panel.querySelector("[data-policy-editing]")
            ) {
              previousPolicy = snapshot;
              restoreFocus(
                panel,
                () =>
                  panel.replaceChildren(
                    delegationPanel(value, channel, savedPolicy),
                  ),
                element("settings-delegation"),
              );
            }
          } else if (!previousPolicy)
            panel.replaceChildren(empty("設定を取得できませんでした。"));
          continue;
        }

        if (decisionTab) {
          if (itemResult.status === "fulfilled") {
            inbox?.render(pending, goalLink, goalTitle);
            // A decision answered meanwhile never gets a card: drop the request.
            if (!focusDecision()) pendingFocus = undefined;
          }
          const rows =
            history.status === "fulfilled" ? history.value : undefined;
          const historyTitle = (entry: AgentDecision) =>
            entry.taskId
              ? (lastGoal?.tasks.find(({ id }) => id === entry.taskId)?.title ??
                problems.flat().find(({ taskId }) => taskId === entry.taskId)
                  ?.title)
              : goalTitle(entry.goalId);
          const snapshot = JSON.stringify(
            rows?.map((entry) => [entry, historyTitle(entry)]) ?? null,
          );
          if (snapshot !== previousHistory) {
            previousHistory = snapshot;
            const panel = element("decision-history");
            restoreFocus(panel, () =>
              panel.replaceChildren(
                ...(rows
                  ? historyCards(
                      rows,
                      () => openSettings("delegation"),
                      historyTitle,
                      (subject) => navigate({ tab: "goals", ...subject }),
                    )
                  : [empty("AI の判断履歴を取得できませんでした。")]),
              ),
            );
          }
        } else if (goal.status === "fulfilled" && goal.value) {
          const detail = (lastGoal = goal.value);
          const tasks = new Set(detail.tasks.map(({ id }) => id));
          const related = (item: PanelInboxItem) =>
            item.subject.goalId === detail.id ||
            Boolean(item.subject.taskId && tasks.has(item.subject.taskId));
          const decisions = pending.filter(related);
          const activity = items.filter(
            (item) => item.weight === "info" && related(item),
          );
          renderWork(
            [
              detail,
              decisions,
              activity.map(({ state: _state, ...item }) => item),
            ],
            () =>
              goalDetail(
                detail,
                decisions.length,
                goalDelegation(detail, channel, savedPolicy),
                activity,
                (taskId) =>
                  navigate({ tab: "goals", goalId: detail.id, taskId }),
                () => navigate({ tab: "decisions" }, decisions[0]?.id),
                watch,
              ),
            undefined,
            detail,
          );
        } else if (task.status === "fulfilled" && task.value) {
          const detail = task.value;
          const decision = pending.find(
            (item) => item.subject.taskId === detail.id,
          );
          const command = retryCommand(detail.id, items);
          renderWork(
            [detail, decision?.id, command, goalTitle(detail.goalId)],
            () =>
              taskDetail(
                detail,
                taskDelegation(detail, channel, savedPolicy),
                decision,
                () => navigate({ tab: "decisions" }, decision?.id),
                command,
              ),
            detail,
          );
        } else if (problemTab && problemResult.status === "fulfilled") {
          const context = problems.map(([row]) => [
            row && goalTitle(row.goalId),
            row?.taskId && retryCommand(row.taskId, items),
          ]);
          renderWork([problems, context], () =>
            problems.length
              ? problems.map((rows) =>
                  problemCard(
                    rows,
                    items,
                    channel,
                    goalLink,
                    (subject) => navigate({ tab: "goals", ...subject }),
                    watch,
                  ),
                )
              : [empty("問題はありません。")],
          );
        } else if (
          goalTab &&
          !current.goalId &&
          !current.taskId &&
          goalResult.status === "fulfilled"
        ) {
          const entries = goals.map((entry) => ({
            entry,
            count: pending.filter(({ subject }) => subject.goalId === entry.id)
              .length,
          }));
          renderWork(entries, () =>
            entries.length
              ? entries.map(({ entry, count }) =>
                  goalRow(entry, count, () =>
                    navigate({ tab: "goals", goalId: entry.id }),
                  ),
                )
              : [empty("Goal はありません。")],
          );
        } else if (goalTab || problemTab) {
          renderWork(null, () => [
            empty("詳細または一覧を取得できませんでした。"),
          ]);
        }
      } while (refreshNeeded && !document.hidden);
    } finally {
      loading = false;
    }
  }

  let poll = 0;
  if (channel) {
    window.setInterval(() => void refresh(++poll % 4 === 0), 5000);
    document.addEventListener("visibilitychange", () => void refresh());
  }
  return {
    refresh,
    closeSettings,
    connect() {
      disconnected = false;
      inbox?.invalidate();
      void refresh();
    },
    disconnect() {
      disconnected = true;
    },
  };
}
