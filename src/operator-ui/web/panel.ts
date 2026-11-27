import {
  action,
  disclosure,
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
import { failureReason } from "../../local-orchestrator/operator-attention.ts";
import type { PanelAnswer } from "../../local-orchestrator/proposal-answer.ts";
import type { WorkplaceChannel } from "./channel.ts";
import {
  activityLabel,
  estimateLabel,
  gateLabels,
  settingLabel,
  formatDuration,
  formatTimestamp,
  formatTokens,
  pendingDecisions,
  planningDraft,
  groupProblems,
  retryCommand,
  withheld,
  type Activity,
  type ActivityRow,
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

function proposalHasWithheld(proposal: Proposal) {
  return (
    Object.values(proposal).some(withheld) ||
    Object.values(proposal.modelText).some(withheld)
  );
}

function proposalEvidence(proposal: Proposal) {
  const { origin, budgets, effectivePolicy, policySource, ruleId, ruleName } =
    proposal;
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
  if (proposalHasWithheld(proposal))
    content.append(textElement("p", withheldApproval, "warning"));
  return content;
}

type Watch = (
  node: HTMLElement,
  ids: readonly string[],
  load?: () => void,
) => void;
type GoalLink = (id?: string | null, ref?: string | null) => Node[];

export function createInboxPanel(
  channel: Pick<WorkplaceChannel, "request">,
  refresh: () => void,
  watch: Watch,
  unwatch: (root: HTMLElement) => void,
  onGoalApproved: (item: PanelInboxItem, ref: string) => void = () => {},
) {
  const inbox = element("inbox-items");
  const batch = element("answer-batch");
  const results = element("answer-results");
  const chosen = new Map<string, string>();
  const cards = new Map<
    string,
    Map<
      string,
      {
        signature: string;
        node: HTMLElement;
        updateButtons: () => void;
        updateSelection?: () => void;
      }
    >
  >();
  const expanded = new Set<string>();
  const stale = new Map<string, string>();
  const previews = new Map<
    string,
    { digest: string; pending: Promise<Proposal> }
  >();
  let proposals: PanelInboxItem[] = [];
  let controls: (() => void)[] = [];
  let answering = false;
  let cancelConfirmation: ((root?: HTMLElement) => void) | undefined;
  let previous = "";
  let revision = 0;

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
        (item) =>
          "answer" in item && chosen.get(item.answer.id) === item.answer.digest,
      );
      if (pinned.length >= 2)
        confirm(batch, pinned, "approve", batchButton, batchActions);
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

  function preview(id: string, digest: string) {
    const existing = previews.get(id);
    if (existing?.digest === digest) return existing.pending;
    const pending = channel
      .request("proposal.get", { id })
      .catch((error: unknown) => {
        if (previews.get(id)?.pending === pending) previews.delete(id);
        throw error;
      });
    previews.set(id, { digest, pending });
    return pending;
  }

  function staleAnswer(answer: AnswerableProposal, item: PanelInboxItem) {
    if (stale.get(answer.id) === answer.digest) return;
    stale.set(answer.id, answer.digest);
    expanded.add(item.id);
    previews.delete(answer.id);
    revision++;
    refresh();
  }

  async function validate(answer: AnswerableProposal) {
    const proposal = await preview(answer.id, answer.digest);
    if (proposal.digest !== answer.digest) throw new Error("stale-digest");
    if (proposal.status !== "pending") throw new Error("invalid-transition");
    if (proposalHasWithheld(proposal)) throw new Error("withheld");
    return proposal;
  }

  async function send(
    rows: PanelInboxItem[],
    decision: PanelAnswer["decision"],
    status: HTMLElement,
    done: () => void,
  ) {
    if (answering) return;
    answering = true;
    updateControls();
    const pinned = rows.flatMap((item) =>
      "answer" in item ? [{ item, answer: item.answer }] : [],
    );
    const answers = pinned.map(({ answer: { id, digest } }) => ({
      id,
      digest,
      decision,
    }));
    function report(code: string) {
      const message = textElement("p", answerError(code), "status-error");
      status.append(message);
      if (status !== results)
        results.append(textElement("p", answerError(code), "status-error"));
    }
    results.replaceChildren();
    status.replaceChildren();
    try {
      const outcomes =
        answers.length === 1 && answers[0]
          ? [await channel.request("proposal.answer", answers[0])]
          : await channel.request("proposal.answerMany", { answers });
      for (const outcome of outcomes) {
        const match = pinned.find(({ answer }) => answer.id === outcome.id);
        if (!match) continue;
        const { item, answer } = match;
        if ("error" in outcome) {
          if (outcome.error.code === "stale-digest") staleAnswer(answer, item);
          report(outcome.error.code);
          continue;
        }
        previews.delete(answer.id);
        if (decision === "approve" && answer.kind === "goal") {
          try {
            const approved = await channel.request("proposal.get", {
              id: answer.id,
            });
            if (
              approved.kind !== "goal" ||
              approved.status !== "approved" ||
              !approved.goalRef
            )
              throw new Error("invalid-response");
            onGoalApproved(item, approved.goalRef);
          } catch {
            results.append(
              textElement(
                "p",
                "承認を記録しました。Goal の参照を取得できませんでした。",
                "notice",
              ),
            );
          }
        } else {
          results.append(
            textElement(
              "p",
              `${item.subject.ref ? `${item.subject.ref} · ` : ""}${decision === "approve" ? "承認" : "却下"}を記録しました。`,
              "notice",
            ),
          );
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "write-failed";
      if (code === "stale-digest")
        for (const { answer, item } of pinned) staleAnswer(answer, item);
      report(code);
    } finally {
      for (const { id } of answers) chosen.delete(id);
      answering = false;
      done();
      updateControls();
      refresh();
    }
  }

  function confirm(
    container: HTMLElement,
    pinned: PanelInboxItem[],
    decision: PanelAnswer["decision"],
    trigger: HTMLElement,
    actions: HTMLElement,
    status = results,
  ) {
    if (answering) return;
    cancelConfirmation?.();
    const answers = pinned.flatMap((item) =>
      "answer" in item ? [item.answer] : [],
    );
    const first = answers[0];
    const integration = first?.kind === "integration";
    const reject = decision === "reject";
    const title = first?.title ?? pinned[0]?.modelText ?? "提案";
    const message = reject
      ? `「${title}」を却下します。`
      : pinned.length > 1
        ? `${pinned.length} 件を承認します。`
        : `「${title}」を${integration ? "統合" : "承認"}します。`;
    const msg = textElement("bdi", message, "q");
    const cancel = action("戻す", "cancel-answer", () => {
      close();
      trigger.focus();
    });
    const submit = action(
      reject
        ? "却下を確定"
        : integration && pinned.length === 1
          ? "承認して統合を確定"
          : "承認を確定",
      "submit-answer",
      () => {
        if (submit.disabled || cancelConfirmation !== close || answering)
          return;
        submit.disabled = cancel.disabled = true;
        void send(pinned, decision, status, () => {
          if (cancelConfirmation === close) {
            close();
            trigger.focus({ preventScroll: true });
          }
        });
      },
      reject ? "btn danger" : "btn primary",
    );
    const strip = group(
      "div",
      reject ? "confirm reject" : "confirm",
      msg,
      cancel,
      submit,
    );
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "回答の確認");
    actions.hidden = true;
    container.append(strip);
    cancelConfirmation = close;
    cancel.focus();

    function close(root?: HTMLElement) {
      if (root && !root.contains(strip)) return;
      strip.remove();
      actions.hidden = false;
      if (cancelConfirmation === close) cancelConfirmation = undefined;
    }

    if (!reject) {
      submit.disabled = true;
      void Promise.all(
        pinned.map(async (item) => {
          if (!("answer" in item)) return "提案を取得できませんでした。";
          const { answer } = item;
          try {
            await validate(answer);
            return "";
          } catch (error) {
            const code = error instanceof Error ? error.message : "read-failed";
            if (code === "stale-digest") staleAnswer(answer, item);
            if (code === "invalid-transition") refresh();
            return code === "withheld"
              ? withheldApproval
              : code === "stale-digest" || code === "invalid-transition"
                ? answerError(code)
                : "提案の詳細を取得できませんでした。";
          }
        }),
      ).then((messages) => {
        if (cancelConfirmation !== close) return;
        const errors = [...new Set(messages.filter(Boolean))];
        status.replaceChildren(
          ...errors.map((error) => textElement("p", error, "warning")),
        );
        submit.disabled = errors.length > 0;
      });
    }
  }

  function card(
    item: PanelInboxItem,
    goalLink: GoalLink,
    options: {
      batch?: boolean;
      goalRef?: string;
      flat?: boolean;
      surface?: "decisions" | "popover" | "list" | "goal";
      goalTitle?: string;
    } = {},
  ) {
    const answer = "answer" in item ? item.answer : undefined;
    const name = answer?.title ?? item.modelText;
    const id = item.subject.proposalId;
    const needsReview = id !== undefined && stale.has(id);
    const signature = JSON.stringify([
      decisionSnapshot([item]),
      options,
      id && stale.get(id),
    ]);
    const cached = options.surface && cards.get(item.id)?.get(options.surface);
    if (cached && signature === cached.signature) {
      if (options.batch) {
        controls.push(cached.updateButtons);
        if (cached.updateSelection) controls.push(cached.updateSelection);
      }
      watch(cached.node, item.state === "open" ? [item.id] : []);
      return cached.node;
    }
    const reason = textElement(
      "span",
      needsReview ? answerError("stale-digest") : "確認が必要です。",
    );
    const kind = proposalLabels[item.kind] ?? item.title;
    const top = group(
      "div",
      "card-top",
      chip(kind, item.kind === "integration" || !answer ? "warn" : "accent"),
      ...refNodes(item.subject.ref, options.goalRef),
      reason,
    );
    const row = textElement(
      options.batch ? "li" : "article",
      "",
      options.flat ? "card flat" : "card",
    );
    const detail = textElement("div", "", "stack decision-detail");
    detail.hidden = !expanded.has(item.id);
    const info = textElement("div", "", "stack");
    const status = textElement("div", "", "decision-event");
    status.setAttribute("role", "status");
    detail.append(info);
    const command = commandControls(
      item.next,
      "CLI コマンドをコピー",
      `copy:${item.id}`,
      true,
    );
    const fallback = group(
      "div",
      "stack",
      command.text,
      group("div", "actions", command.copy, command.status),
    );
    fallback.hidden = Boolean(answer?.approve);
    detail.append(fallback);
    const toggle = action(
      "",
      `detail:${item.id}`,
      () => {
        cancelConfirmation?.();
        detail.hidden = !detail.hidden;
        if (detail.hidden) expanded.delete(item.id);
        else {
          expanded.add(item.id);
          void load();
        }
        updateDisclosure();
        toggle.focus({ preventScroll: true });
      },
      "link",
    );
    const hint = textElement("span", "読んだ内容で確定します", "muted");
    const actions = group(
      "div",
      "actions decision-actions",
      toggle,
      textElement("span", "", "spacer"),
      hint,
    );
    const answerArea = group("div", "stack", actions, status);
    let viewed: Proposal | undefined;
    let approve: HTMLButtonElement | undefined;
    let reject: HTMLButtonElement | undefined;
    let sending = false;
    function updateButtons() {
      if (reject) reject.disabled = answering;
      if (approve)
        approve.disabled =
          answering ||
          (!detail.hidden &&
            (!viewed ||
              viewed.status !== "pending" ||
              viewed.digest !== answer?.digest ||
              proposalHasWithheld(viewed)));
    }
    function updateDisclosure() {
      const parent = detail.hidden ? answerArea : detail;
      if (actions.parentElement !== parent) parent.prepend(actions);
      if (!detail.hidden && detail.lastElementChild !== actions)
        detail.append(actions);
      hint.hidden = detail.hidden || !answer?.approve;
      toggle.textContent = detail.hidden ? "詳細" : "詳細を閉じる";
      toggle.setAttribute("aria-expanded", String(!detail.hidden));
      updateButtons();
    }
    let updateSelection: (() => void) | undefined;
    if (options.batch && answer?.approve) {
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
      updateSelection = () => {
        checkbox.checked = chosen.get(answer.id) === answer.digest;
        checkbox.disabled =
          answering || (!checkbox.checked && chosen.size >= 20);
      };
      controls.push(updateSelection);
      top.prepend(checkbox);
    }
    if (answer?.reject) {
      const button = action("却下", `reject:${item.id}`, () =>
        confirm(answerArea, [item], "reject", button, actions, status),
      );
      reject = button;
      actions.append(button);
    }
    if (answer?.approve) {
      const button = action(
        answer.kind === "integration" ? "承認して統合" : "承認",
        `approve:${item.id}`,
        () => {
          if (button.disabled || answering || sending) return;
          if (detail.hidden)
            confirm(answerArea, [item], "approve", button, actions, status);
          else {
            cancelConfirmation?.();
            sending = true;
            button.disabled = true;
            void send([item], "approve", status, () => {
              sending = false;
              updateButtons();
            });
          }
        },
        "btn primary",
      );
      approve = button;
      actions.append(button);
    }
    if (options.batch) controls.push(updateButtons);
    updateDisclosure();

    row.append(
      top,
      name ? modelTitle("h3", name) : textElement("h3", item.title, "title"),
      ...(options.goalRef
        ? []
        : goalLink(item.subject.goalId, item.subject.goalRef)),
      ...(answer?.agentGates.length
        ? [
            textElement(
              "p",
              `この提案には AI へ判断を委任する設定が含まれます（${answer.agentGates.map((gate) => gateLabels[gate]).join("、")}）。`,
              "warning",
            ),
          ]
        : []),
      detail,
      answerArea,
    );
    async function load() {
      if (!id || viewed) return;
      info.textContent = "提案の詳細を読み込み中…";
      try {
        const proposal = await preview(id, answer?.digest ?? "");
        if (answer && proposal.digest !== answer.digest) {
          reason.textContent = answerError("stale-digest");
          info.replaceChildren();
          staleAnswer(answer, item);
          return;
        }
        viewed = proposal;
        info.replaceChildren(proposalEvidence(proposal));
        if (proposalHasWithheld(proposal)) fallback.hidden = false;
        updateButtons();
      } catch {
        info.textContent = "提案の詳細を取得できませんでした。";
      }
    }
    if (!detail.hidden) {
      expanded.add(item.id);
      void load();
    }
    watch(row, item.state === "open" ? [item.id] : []);
    if (options.surface) {
      const surfaces = cards.get(item.id) ?? new Map();
      surfaces.set(options.surface, {
        signature,
        node: row,
        updateButtons,
        ...(updateSelection && { updateSelection }),
      });
      cards.set(item.id, surfaces);
    }
    return row;
  }

  return {
    card,
    cancelConfirmation(root: HTMLElement) {
      cancelConfirmation?.(root);
    },
    get revision() {
      return revision;
    },
    invalidate() {
      previous = "";
      revision++;
      previews.clear();
      cards.clear();
    },
    render(
      rows: PanelInboxItem[],
      goalLink: GoalLink,
      goalTitle: (id?: string) => string | undefined,
      extra: {
        anchors: string[];
        render: (id: string) => HTMLElement | undefined;
      } = { anchors: [], render: () => undefined },
      tracking: unknown = null,
    ) {
      const snapshot = JSON.stringify([
        revision,
        tracking,
        decisionSnapshot(rows),
        rows.map((row) => goalTitle(row.subject.goalId)),
      ]);
      if (snapshot === previous) return;
      previous = snapshot;
      const inboxChanged =
        JSON.stringify(decisionSnapshot(proposals)) !==
        JSON.stringify(decisionSnapshot(rows));
      proposals = rows;
      if (inboxChanged) cancelConfirmation?.(batch);
      const approvable = new Map(
        proposals.flatMap((item) =>
          "answer" in item && item.answer.approve
            ? [[item.answer.id, item.answer.digest]]
            : [],
        ),
      );
      const ids = new Set(rows.map((row) => row.subject.proposalId));
      for (const [id, digest] of chosen)
        if (approvable.get(id) !== digest) chosen.delete(id);
      for (const map of [stale, previews])
        for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
      const rowIds = new Set(rows.map(({ id }) => id));
      for (const id of expanded) if (!rowIds.has(id)) expanded.delete(id);
      for (const id of cards.keys()) if (!rowIds.has(id)) cards.delete(id);
      controls = [];
      restoreFocus(
        inbox,
        () => {
          unwatch(inbox);
          inbox.replaceChildren(
            ...withTracking(rows, extra, (item) =>
              card(item, goalLink, {
                batch: true,
                surface: "decisions",
                goalTitle: goalTitle(item.subject.goalId) ?? "",
              }),
            ),
          );
        },
        element("tab-decisions"),
      );
      element("empty-inbox").hidden =
        rows.length !== 0 || extra.anchors.length !== 0;
      updateControls();
    },
  };
}

function decisionSnapshot(items: readonly PanelInboxItem[]) {
  return items.map(({ state: _state, ...item }) => item);
}

function withTracking(
  rows: PanelInboxItem[],
  extra: { anchors: string[]; render: (id: string) => HTMLElement | undefined },
  card: (item: PanelInboxItem) => HTMLElement,
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...new Set([...extra.anchors, ...byId.keys()])].flatMap((id) => {
    const tracking = extra.render(id);
    const row = byId.get(id);
    return tracking ? [tracking] : row ? [card(row)] : [];
  });
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
              : textElement("span", taskId ? "Task" : goalId ? "Goal" : "提案");
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
              ...refNodes(entry.taskRef ?? entry.goalRef),
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

function refNodes(ref?: string | null, goalRef?: string) {
  if (!ref) return [];
  const display =
    goalRef && ref.startsWith(`${goalRef}-`)
      ? `#${ref.slice(goalRef.length + 1)}`
      : ref;
  return [textElement("span", display, "ref")];
}

const turnGroups = [
  { label: "あなたの番", owners: ["human"] },
  { label: "止まっている・誰も動いていない", owners: ["stopped", "idle"] },
  { label: "AI の番", owners: ["ai"] },
  { label: "終わった", owners: ["done"] },
];

function turnReason(reason: GoalSummary["turn"]["reason"]) {
  switch (reason.kind) {
    case "approvals":
      return `判断 ${reason.count} 件`;
    case "cancelled":
      return "Goal を取り消しました";
    case "failed":
      return `が${failureReason(reason.code)}で失敗`;
    case "planning":
      return "Planner が Task を分けています";
    case "running":
      return `${reason.taskRef ? "を" : ""}作業中（${reason.actor}）`;
    case "queued":
      return "順番待ち";
    case "not-planned":
      return "計画がまだ依頼されていません";
    case "exportable":
      return "統合済み。書き出せます";
    case "completed":
      return "Goal が完了しました";
    case "idle":
      return "動いている作業はありません";
  }
}

function goalTurn(goal: GoalSummary, local = false) {
  const { owner, reason } = goal.turn;
  const [label, tone] = (
    {
      human: ["あなたの番", "warn"],
      stopped: ["止まっています", "danger"],
      ai: ["AI の番", "accent"],
      idle: ["待機中", "info"],
      done: ["完了", "ok"],
    } as const
  )[owner];
  const task =
    "taskRef" in reason
      ? refNodes(reason.taskRef, local ? goal.ref : undefined)
      : [];
  return group(
    "div",
    "turn-line",
    chip(label, tone),
    group(
      "span",
      "meta",
      ...task,
      document.createTextNode(`${task.length ? " " : ""}${turnReason(reason)}`),
    ),
  );
}

function goalProgress(goal: GoalSummary) {
  const { done, total } = goal.progress;
  const estimate = estimateLabel(goal.estimate.remainingMs);
  return `${done} / ${total} Task 完了${estimate ? ` · ${estimate}` : ""}`;
}

function goalRow(
  goal: GoalSummary,
  open: () => void,
  decisions: () => Node[],
  hasDecisions: boolean,
  opened: Set<string>,
) {
  const link = action("", goal.id, open, "link goal-title");
  link.append(modelTitle("span", goal.title), " ›");
  const header = group(
    "div",
    "goal-head",
    ...refNodes(goal.ref),
    link,
    textElement("span", goalProgress(goal), "meta"),
  );
  const turn = goalTurn(goal);
  const row = group("article", "card goal-row", header, turn);
  if (hasDecisions) {
    const cards = group("div", "stack");
    const toggle = action(
      "",
      `inline:${goal.id}`,
      () => {
        if (opened.has(goal.id)) opened.delete(goal.id);
        else opened.add(goal.id);
        render();
      },
      "link",
    );
    function render() {
      const expanded = opened.has(goal.id);
      if (expanded && !cards.childElementCount) cards.append(...decisions());
      cards.hidden = !expanded;
      toggle.textContent = expanded ? "閉じる" : "ここで答える";
      toggle.setAttribute("aria-expanded", String(expanded));
    }
    render();
    turn.append(toggle);
    row.append(cards);
  }
  return row;
}

function taskRow(task: TaskSummary, goalRef: string, open: () => void) {
  const row = action("", task.id, open, "taskrow");
  const estimate = estimateLabel(task.estimate.remainingMs);
  row.append(
    ...refNodes(task.ref, goalRef),
    modelTitle("span", task.title, "t"),
    displayState(task.stage),
  );
  if (estimate) row.append(textElement("span", estimate, "eta"));
  return row;
}

function runningLine(run: ActivityRow, open: () => void, local?: string) {
  const elapsed = textElement("span", "", "meta elapsed");
  elapsed.dataset.startedAt = run.startedAt ?? "";
  elapsed.textContent = elapsedLabel(run.startedAt);
  const row = group(
    "div",
    "running-line",
    textElement("span", "", "now-dot"),
    ...refNodes(run.taskRef ?? run.goalRef, local),
    modelTitle("span", run.taskTitle ?? run.goalTitle ?? run.actor, "grow"),
    textElement(
      "span",
      run.preparingEnvironment ? "環境を準備中" : run.actor,
      "meta",
    ),
    elapsed,
  );
  if (!run.taskId && !run.goalId) return row;
  const link = action("", `run:${run.id}`, open, "link running-link");
  link.append(row);
  return link;
}

function elapsedLabel(startedAt: string | null) {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(started)
    ? formatDuration(Math.max(0, Date.now() - started))
    : "—";
}

function goalDetail(
  goal: GoalDetail,
  now: Node[],
  decisions: Node[],
  problem: Node[],
  delegation: Node,
  activity: PanelInboxItem[],
  selectTask: (id: string) => void,
  watch: Watch,
  exportControls: Node,
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
      ...refNodes(item.subject.taskRef ?? item.subject.goalRef, goal.ref),
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
    group(
      "header",
      "goal-head",
      ...refNodes(goal.ref),
      modelTitle("h2", goal.title),
      textElement("span", goalProgress(goal), "meta"),
    ),
    ...now,
    ...decisions,
    ...problem,
    exportControls,
    sectionTitle("Task"),
    goal.tasks.length
      ? group(
          "div",
          "card tasklist",
          ...goal.tasks.map((task) =>
            taskRow(task, goal.ref, () => selectTask(task.id)),
          ),
        )
      : empty("まだ Task はありません。"),
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

const exportBlockMessages = {
  "branch-checked-out":
    "書き出し先のブランチはワークツリーでチェックアウトされています。先に別のブランチに切り替えてください。",
  "non-fast-forward":
    "書き出し先のブランチに Goal に含まれないコミットがあるため、ブランチを移動できません。",
};

const alreadyExported = (head: string) =>
  `書き出し先のブランチはすでに Goal の先端（${head.slice(0, 12)}）を指しています。`;

export function goalExport(
  channel: Pick<WorkplaceChannel, "request">,
  goal: GoalDetail,
  message: string,
  refresh: (message: string) => void,
) {
  // A blocker message from an earlier attempt is stale once the blocker is gone.
  const stale = (Object.values(exportBlockMessages) as string[]).includes(
    message,
  );
  if (
    stale &&
    (!goal.exportBlockReason ||
      exportBlockMessages[goal.exportBlockReason] !== message)
  )
    message = "";
  const area = group("div", "stack");
  const feedback = textElement("p", message, "meta decision-event");
  feedback.setAttribute("role", "status");
  if (goal.turn.reason.kind !== "exportable") {
    if (message) area.append(feedback);
    else area.hidden = true;
    return area;
  }
  const preview = goal.exportPreview;
  if (preview && preview.from === preview.to) {
    const status = alreadyExported(preview.to);
    area.append(textElement("p", status, "meta"));
    if (message && message !== status) area.append(feedback);
    return group("section", "card", area);
  }
  const blocker = goal.exportBlockReason
    ? exportBlockMessages[goal.exportBlockReason]
    : null;
  if (blocker) area.append(textElement("p", blocker, "meta"));

  const key = goal.id;
  const { text, copy, status } = commandControls(
    `agent-bootstrap export-goal-branch ${goal.ref}`,
    "CLI コマンドをコピー",
    "export-goal",
    true,
  );
  const fallback = group(
    "div",
    "stack",
    text,
    group("div", "actions", copy, status),
  );
  const start = action(
    "ブランチを書き出す",
    `export:${key}`,
    () => {
      if (start.disabled) return;
      start.disabled = true;
      feedback.hidden = false;
      feedback.textContent = "書き出し先とブランチを確認しています…";
      void channel
        .request("goal.get", { id: key })
        .then((current) => {
          if (current.ref !== goal.ref) {
            changed();
            return;
          }
          const preview = current.exportPreview;
          if (current.exportBlockReason)
            refreshStatus(exportBlockMessages[current.exportBlockReason]);
          else if (!preview) changed();
          else if (preview.from === preview.to)
            refreshStatus(alreadyExported(preview.to));
          else confirm(preview);
        })
        .catch(() => {
          feedback.textContent = "書き出しの内容を確認できませんでした。";
          start.disabled = false;
        });
    },
    "btn primary",
  );
  feedback.hidden = !message || message === blocker;
  if (preview) area.append(group("div", "actions", start));
  area.append(feedback);

  function refreshStatus(text: string) {
    start.hidden = true;
    feedback.textContent = text;
    feedback.hidden = false;
    refresh(text);
  }

  function changed() {
    const message =
      "Goal または書き出し先のブランチが変わりました。更新した内容を確認してください。";
    feedback.textContent = message;
    refresh(message);
  }

  function confirm({
    branch,
    target,
    from,
    to,
  }: NonNullable<GoalDetail["exportPreview"]>) {
    feedback.textContent = "";
    feedback.hidden = true;
    start.hidden = true;
    const cancel = action("戻す", `back-export:${key}`, () => reset());
    const submit = action(
      "書き出しを確定",
      `confirm-export:${key}`,
      () => {
        if (submit.disabled) return;
        submit.disabled = cancel.disabled = true;
        void channel
          .request("goal.export", {
            id: key,
            confirm: `export-goal-branch ${goal.ref} ${to.slice(0, 12)}`,
            expectedHead: to,
          })
          .then(({ branch }) => {
            strip.remove();
            const message = `${target} で ${branch} をレビューしてください。準備ができたらプッシュし、main へのプルリクエストを作成してください。`;
            feedback.textContent = message;
            feedback.hidden = false;
            refresh(message);
          })
          .catch((error: unknown) => {
            feedback.hidden = false;
            const code = error instanceof Error ? error.message : "";
            if (code === "branch-checked-out" || code === "non-fast-forward") {
              strip.remove();
              refreshStatus(exportBlockMessages[code]);
              return;
            }
            if (code === "already-exported") {
              strip.remove();
              refreshStatus(alreadyExported(to));
              return;
            }
            if (
              code === "stale-base" ||
              code === "goal-inactive" ||
              code === "integration-uncertain" ||
              code === "not-found"
            ) {
              strip.remove();
              changed();
              return;
            }
            if (code === "goal-export-record-failed") {
              strip.remove();
              const message = `${target} の ${branch} は更新されましたが、書き出しの完了を記録できませんでした。ブランチはすでに Goal の先端にあるので、書き出し直す必要はありません。監査記録を確認してください。`;
              feedback.textContent = message;
              refresh(message);
              return;
            }
            reset();
            feedback.textContent =
              code === "credential-leak"
                ? "資格情報の検査でブロックされたため、ブランチを書き出せませんでした。"
                : "ブランチの書き出しを確定できませんでした。";
          });
      },
      "btn primary",
    );
    const strip = group(
      "div",
      "confirm",
      group(
        "div",
        "q",
        facts([
          ["ブランチ", branch],
          ["書き出し先", target],
          ["コミット", `${from?.slice(0, 12) ?? "なし"} → ${to.slice(0, 12)}`],
        ]),
        textElement(
          "p",
          "ローカルブランチを作成または更新します。プッシュは行いません。",
        ),
      ),
      cancel,
      submit,
    );
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "ブランチの書き出しの確認");
    area.append(strip);
    cancel.focus();

    function reset() {
      strip.remove();
      start.hidden = false;
      start.disabled = false;
      start.focus();
    }
  }

  return group("section", "card", area, fallback);
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
  const { code, next, rejectedPaths: paths } = task.failure;
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
      ...(next ? [textElement("p", next, "meta")] : []),
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
        ...refNodes(task.ref),
        modelTitle("h2", task.title, "title large grow"),
        displayState(task.stage),
      ),
      stages,
      facts([
        ...(estimate ? [["残り時間", estimate] as const] : []),
        ["対象パス", task.paths.join(", ") || "—"],
        [
          "実行者",
          task.executions.find(
            ({ actor, mode }) => actor === "Executor" && mode === "task",
          )?.harness === "codex"
            ? "Executor（Codex）"
            : task.actor,
        ],
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
            ({
              actor,
              mode,
              status,
              startedAt,
              finishedAt,
              tokens,
              harness,
              model,
              environment,
            }) =>
              textElement(
                "p",
                `${actor === "Executor" && harness === "codex" ? "Executor（Codex）" : actor}${model ? ` / ${model}` : ""} / ${mode} / ${status} · ${formatTimestamp(startedAt)} → ${formatTimestamp(finishedAt)} · ${formatTokens(tokens)} トークン${environment ? ` · 環境 ${environment.key}（${environment.failure ? failureReason(environment.failure) : environment.cacheHit ? "キャッシュ" : "ビルド"}）` : ""}`,
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

type OperatorRequest = Pick<WorkplaceChannel, "request">;

function draftButton(
  channel: OperatorRequest,
  label: string,
  key: string,
  text: string,
  status: HTMLElement,
  onDraft: () => void,
  success: string,
) {
  const button = action(label, key, () => {
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = "";
    void channel
      .request("concierge.draft", { text })
      .then(() => {
        status.textContent = success;
        if (key.startsWith("plan:")) button.remove();
        onDraft();
      })
      .catch(() => {
        status.textContent = "Concierge に下書きを入れられませんでした。";
        button.disabled = false;
      });
  });
  return button;
}

function consultation(
  channel: OperatorRequest,
  problem: Problem,
  status: HTMLElement,
  focus: () => void,
) {
  const ref = problem.ref ?? "";
  const reason =
    "code" in problem
      ? failureReason(problem.code)
      : problem.kind === "execution-over-budget"
        ? "予算超過"
        : "対象範囲外の変更";
  return draftButton(
    channel,
    "Concierge に相談",
    `consult:${problem.taskId ?? problem.goalId}`,
    `${ref}「${problem.title}」が${reason}で失敗しました。原因を調べて、次にどうするか提案してください。`,
    status,
    focus,
    "左の Concierge に下書きを入れました。送るまで何も起きません。",
  );
}

export function problemActions(
  channel: OperatorRequest,
  problem: Problem,
  goalTitle: string | undefined,
  goalLink: GoalLink,
  focusConcierge: () => void,
  accepted: (receipt: "retried" | "cancelled") => void,
) {
  const { goalId, goalRef, taskId, expectedRetries } = problem;
  const key = taskId ?? goalId ?? "problem";
  const area = group("div", "stack");
  const status = textElement("p", "", "meta decision-event");
  status.setAttribute("role", "status");
  const buttons = group(
    "div",
    "actions",
    textElement("span", "", "spacer"),
    consultation(channel, problem, status, focusConcierge),
  );
  area.append(buttons, status);

  function confirm(
    message: string,
    label: string,
    trigger: HTMLElement,
    danger: boolean,
    send: () => Promise<unknown>,
    receipt: "retried" | "cancelled",
  ) {
    status.textContent = "";
    buttons.hidden = true;
    const msg = textElement("bdi", message, "q");
    if (danger)
      msg.append(textElement("span", "取り消すと戻せません。", "danger-text"));
    const cancel = action("戻す", `back:${key}`, () => reset());
    const submit = action(
      label,
      `confirm:${key}`,
      () => {
        if (submit.disabled) return;
        submit.disabled = cancel.disabled = true;
        void send()
          .then(() => {
            area.replaceChildren(problemReceipt(problem, receipt, goalLink));
            accepted(receipt);
          })
          .catch((error: unknown) => {
            reset();
            const code = error instanceof Error ? error.message : "";
            status.textContent =
              code === "stale-base"
                ? "Goal が変わりました。もう一度確認してください。"
                : code === "goal-head-unavailable"
                  ? "Goal のブランチを確認できないため、取り消せません。"
                  : code === "goal-busy"
                    ? "Goal は作業中のため、取り消せません。"
                    : code === "task-retry-changed"
                      ? "Task が変わりました。もう一度確認してください。"
                      : "操作を確定できませんでした。";
          });
      },
      danger ? "btn danger" : "btn primary",
    );
    const strip = group(
      "div",
      danger ? "confirm reject" : "confirm",
      msg,
      cancel,
      submit,
    );
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "操作の確認");
    area.append(strip);
    cancel.focus();

    function reset() {
      strip.remove();
      buttons.hidden = false;
      trigger.focus();
    }
  }

  if (goalId && goalRef) {
    const discard = action(
      "Goal を取り消す",
      `discard:${key}`,
      () => {
        if (buttons.hidden || discard.disabled) return;
        discard.disabled = true;
        buttons.hidden = true;
        status.textContent = "Goal を確認しています…";
        void channel
          .request("goal.get", { id: goalId })
          .then((goal) => {
            if (goal.headAvailable !== true || goal.ref !== goalRef)
              throw new Error("goal-head-unavailable");
            confirm(
              `${goal.ref}「${goal.title || goalTitle || goal.ref}」を取り消します。`,
              "取り消しを確定",
              discard,
              true,
              () =>
                channel.request("goal.discard", {
                  id: goal.id,
                  confirm: goal.ref,
                  expectedHead: goal.head,
                }),
              "cancelled",
            );
          })
          .catch(() => {
            buttons.hidden = false;
            status.textContent =
              "Goal のブランチを確認できないため、取り消せません。";
            discard.focus();
          })
          .finally(() => {
            discard.disabled = false;
          });
      },
      "btn quiet",
    );
    buttons.prepend(discard);
  }
  if (
    taskId &&
    typeof expectedRetries === "number" &&
    "canRetry" in problem &&
    problem.canRetry
  ) {
    const retry = action(
      "やり直す",
      `retry:${key}`,
      () => {
        if (buttons.hidden) return;
        confirm(
          `「${problem.title}」を同じ内容でやり直します（予算はリセット）。`,
          "やり直しを確定",
          retry,
          false,
          () => channel.request("task.retry", { id: taskId, expectedRetries }),
          "retried",
        );
      },
      "btn primary",
    );
    buttons.append(retry);
  }
  return area;
}

function problemReceipt(
  problem: Problem,
  receipt: "retried" | "cancelled",
  goalLink: GoalLink,
) {
  const text =
    receipt === "retried"
      ? [chip("受け付けました", "ok"), textElement("span", "· 順番待ち")]
      : [textElement("span", `${problem.goalRef} を取り消しました。`)];
  return group(
    "div",
    "confirm",
    ...text,
    ...goalLink(problem.goalId, problem.goalRef),
  );
}

function goalProblem(
  goal: GoalDetail,
  problem: Problem,
  channel: OperatorRequest,
  goProblems: () => void,
  focusConcierge: () => void,
) {
  const status = textElement("p", "", "meta decision-event");
  status.setAttribute("role", "status");
  return [
    sectionTitle("止まっている理由"),
    group(
      "article",
      "card",
      group(
        "p",
        "meta",
        ...refNodes(problem.taskRef, goal.ref),
        textElement(
          "bdi",
          `「${problem.title}」が${"code" in problem ? failureReason(problem.code) : "実行エラー"}で失敗しました。`,
        ),
      ),
      ...("code" in problem && problem.code === "env-missing"
        ? [textElement("p", problem.detail, "reason")]
        : []),
      group(
        "div",
        "actions",
        consultation(channel, problem, status, focusConcierge),
        action("指示を選ぶ", "goal-problems", goProblems, "btn primary"),
      ),
      status,
    ),
  ];
}

function problemReason(rows: Problem[]) {
  if (rows.some(({ kind }) => kind === "execution-over-budget"))
    return "予算超過";
  const failure = rows.find((row) => "code" in row);
  return failure ? failureReason(failure.code) : "パス違反";
}

function problemCard(
  rows: Problem[],
  items: PanelInboxItem[],
  channel: WorkplaceChannel,
  goalLink: GoalLink,
  select: (subject: { goalId?: string; taskId?: string }) => void,
  title: string | undefined,
  focusConcierge: () => void,
  accepted: (problem: Problem, receipt: "retried" | "cancelled") => void,
  watch: Watch,
) {
  const first = rows[0]!;
  const { goalId, taskId } = first;
  const model = rows.find(({ title }) => title)?.title;
  const failed = rows.find((row) => "canRetry" in row);
  const over = rows.filter(({ kind }) => kind === "execution-over-budget");
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

  const card = group(
    "article",
    "card",
    group(
      "div",
      "card-top",
      chip(problemReason(rows), "danger"),
      ...refNodes(first.ref),
      time(first.at),
    ),
    model
      ? modelTitle("h3", model)
      : textElement("h3", taskId ?? goalId ?? "問題", "title"),
    ...goalLink(goalId, first.goalRef),
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
    taskId
      ? action(
          "Task を開く",
          `problem:${taskId}`,
          () => select({ taskId }),
          "link",
        )
      : textElement("span", ""),
    problemActions(
      channel,
      failed ?? first,
      title,
      goalLink,
      focusConcierge,
      (receipt) => accepted(failed ?? first, receipt),
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

export function createHostPanel(
  channel?: WorkplaceChannel,
  focusConcierge = () => {},
) {
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
  const exportMessages = new Map<string, string>();
  const nowButton = element("now-toggle");
  const nowPopover = element("now-popover");
  const now = disclosure(nowButton, nowPopover, () =>
    inbox?.cancelConfirmation(nowPopover),
  );
  const inlineGoals = new Set<string>();
  const draftedPlans = new Set<string>();
  const tracks = new Map<string, { ref: string; title: string }>();
  const problemReceipts = new Map<
    string,
    { problem: Problem; receipt: "retried" | "cancelled" }
  >();
  let decisionOrder: string[] = [];
  let previousNow = "";
  let activity: Activity = {
    running: [],
    queued: [],
    queuedCount: 0,
    yourTurn: 0,
  };

  function planButton(ref: string, title: string) {
    const status = textElement("span", "", "muted");
    status.setAttribute("role", "status");
    const message = "下書きを入れました（Enter で送ります）";
    if (draftedPlans.has(ref)) status.textContent = message;
    const button =
      channel &&
      draftButton(
        channel,
        "Concierge に計画を頼む",
        `plan:${ref}`,
        planningDraft(ref, title),
        status,
        () => {
          draftedPlans.add(ref);
          focusConcierge();
          void refresh(false);
        },
        message,
      );
    return group(
      "span",
      "plan-action",
      ...(button && !draftedPlans.has(ref) ? [button] : []),
      status,
    );
  }

  function trackingData() {
    return [...tracks].map(([id, track]) => [
      id,
      track,
      draftedPlans.has(track.ref),
      goals.find(({ ref }) => ref === track.ref),
      activity.running.find(
        (run) => run.goalRef === track.ref && run.actor === "Planner",
      ),
      activity.queued.some(
        (run) => run.goalRef === track.ref && run.actor === "Planner",
      ),
    ]);
  }

  function trackingCard(id: string, inList: boolean) {
    const track = tracks.get(id);
    if (!track) return;
    const { ref, title } = track;
    const goal = goals.find((entry) => entry.ref === ref);
    const planner = activity.running.find(
      (run) => run.goalRef === ref && run.actor === "Planner",
    );
    const queued = activity.queued.some(
      (run) => run.goalRef === ref && run.actor === "Planner",
    );
    const started = Boolean(
      planner ||
      queued ||
      goal?.progress.total ||
      goal?.turn.reason.kind === "planning",
    );
    const plannerStatus = planner
      ? runningLine(planner, () => selectRun(planner))
      : textElement(
          "span",
          queued ? "順番待ち" : goal?.progress.total ? "Task を分けました" : "",
          "muted",
        );
    const step = (label: string, note?: Node, complete = false) =>
      group(
        "li",
        complete ? "complete" : "",
        textElement("span", complete ? "✓" : "○", "track-mark"),
        textElement("span", label),
        ...(note ? [note] : []),
      );
    const card = group(
      inList ? "li" : "article",
      "card tracking-card",
      group("div", "card-top", chip("受け付けました", "ok"), ...refNodes(ref)),
      modelTitle("h3", title),
      group(
        "ol",
        "tracking-steps",
        step(
          "Goal を承認",
          textElement("span", `${ref} を作りました`, "muted"),
          true,
        ),
        step(
          "Concierge に知らせる",
          started ? undefined : planButton(ref, title),
          started || draftedPlans.has(ref),
        ),
        step(
          "Planner が Task を分ける",
          plannerStatus,
          Boolean(goal?.progress.total),
        ),
        step(
          "Task の承認",
          textElement("span", "あなたの番になったら、ここに出ます", "muted"),
        ),
      ),
      group(
        "div",
        "actions",
        ...goalLink(goal?.id, ref),
        textElement("span", "", "spacer"),
        action(
          "閉じる",
          `track-close:${id}`,
          () => {
            tracks.delete(id);
            previousNow = "";
            renderNow(pendingDecisions(items));
            inbox?.render(
              pendingDecisions(items),
              goalLink,
              goalTitle,
              trackSlots(true),
              trackingData(),
            );
          },
          "link",
        ),
      ),
    );
    card.setAttribute("aria-live", "polite");
    return card;
  }

  function trackSlots(inList: boolean) {
    return {
      anchors: tracks.size ? decisionOrder : [],
      render: (id: string) => trackingCard(id, inList),
    };
  }

  function selectRun({ goalId, taskId }: ActivityRow) {
    if (goalId || taskId)
      navigate({
        tab: "goals",
        ...(goalId && { goalId }),
        ...(taskId && { taskId }),
      });
  }

  function renderNow(pending: PanelInboxItem[]) {
    nowButton.textContent = activityLabel({
      ...activity,
      yourTurn: pending.length + problems.length,
    });
    nowButton.dataset.running = String(activity.running.length > 0);
    if (nowPopover.hidden) return;
    const snapshot = JSON.stringify([
      activity,
      decisionSnapshot(pending),
      trackingData(),
      inbox?.revision,
      pending.map(({ subject }) => goalTitle(subject.goalId)),
      problems,
    ]);
    if (snapshot === previousNow) return;
    previousNow = snapshot;
    const refs = [
      ...new Set(
        activity.queued.flatMap((row) => {
          const ref = row.taskRef ?? row.goalRef;
          return ref ? [row.actor === "Planner" ? `${ref}（計画）` : ref] : [];
        }),
      ),
    ];
    restoreFocus(
      nowPopover,
      () => {
        unwatch(nowPopover);
        nowPopover.replaceChildren(
          sectionTitle("AI が動いているもの"),
          ...(activity.running.length
            ? activity.running.map((row) =>
                runningLine(row, () => selectRun(row)),
              )
            : [textElement("p", "AI は待機中", "meta")]),
          textElement(
            "p",
            `順番待ち ${activity.queuedCount} 件${refs.length ? ` · ${refs.join("、")}` : ""}`,
            "meta",
          ),
          ...Array.from(tracks.keys(), (id) => trackingCard(id, false)).filter(
            (card) => card !== undefined,
          ),
          ...(pending.length || problems.length
            ? [sectionTitle("あなたの番")]
            : []),
          ...(inbox
            ? pending.map((item) =>
                inbox.card(item, goalLink, {
                  flat: true,
                  surface: "popover",
                  goalTitle: goalTitle(item.subject.goalId) ?? "",
                }),
              )
            : []),
          ...problems.map((rows) => {
            const { taskId, goalId, executionId, ref } = rows[0]!;
            const title = rows.find((row) => row.title)?.title;
            return group(
              "div",
              "now-problem",
              ...refNodes(ref),
              title
                ? modelTitle("span", title, "grow")
                : textElement("span", taskId ?? goalId ?? "実行", "grow"),
              chip(problemReason(rows), "danger"),
              ...rows
                .filter((row) => "code" in row && row.code === "env-missing")
                .map(({ detail }) => textElement("p", detail, "reason")),
              action(
                "問題を見る ›",
                `now-problem:${taskId ?? executionId ?? goalId}`,
                () => navigate({ tab: "problems" }),
                "link",
              ),
            );
          }),
        );
      },
      nowPopover,
    );
  }

  nowButton.addEventListener("click", () => {
    now.toggle();
    previousNow = "";
    renderNow(pendingDecisions(items));
    // Refresh problems too, so the list matches the header count.
    if (!nowPopover.hidden) void refresh();
  });

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
    channel &&
    createInboxPanel(
      channel,
      () => void refresh(),
      watch,
      unwatch,
      (item, ref) => {
        if (!decisionOrder.includes(item.id)) decisionOrder.push(item.id);
        tracks.set(item.id, {
          ref,
          title: ("answer" in item ? item.answer.title : item.modelText) ?? ref,
        });
      },
    );

  function goalTitle(id?: string | null) {
    return id === lastGoal?.id
      ? lastGoal?.title
      : goals.find((goal) => goal.id === id)?.title;
  }

  function goalLink(id?: string | null, ref?: string | null) {
    if (!id) return [];
    const title = goalTitle(id);
    ref ??= goals.find((goal) => goal.id === id)?.ref;
    if (!title && !ref) return [];
    const link = action(
      "",
      `goal:${id}`,
      () => navigate({ tab: "goals", goalId: id }),
      "link",
    );
    link.append(
      ...refNodes(ref),
      ...(title ? [textElement("bdi", title)] : []),
      " ›",
    );
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
    now.close(false);
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
      back.append(
        ...refNodes(task?.goalRef),
        textElement("bdi", title ?? "Goal 詳細"),
      );
      nav.append(back);
    }
    separator();
    const here = textElement(
      "bdi",
      task?.title ?? title ?? (current.taskId ? "Task 詳細" : "Goal 詳細"),
    );
    here.setAttribute("aria-current", "page");
    nav.append(...refNodes(task?.ref ?? goal?.ref), here);
    return [nav];
  }

  function navigate(next: View, decisionId?: string) {
    now.close(false);
    if (view.tab === "problems" && next.tab !== "problems")
      problemReceipts.clear();
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
      else element(`tab-${view.tab}`).focus();
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
          activityResult,
        ] = await Promise.allSettled([
          refreshBadges || loadWork
            ? channel.request("inbox.list", {})
            : undefined,
          refreshBadges || loadWork
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
          channel.request("activity.get", {}),
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
        if (activityResult.status === "fulfilled")
          activity = activityResult.value;
        const pending = pendingDecisions(items);
        for (const [id, { ref }] of tracks) {
          const goal = goals.find((entry) => entry.ref === ref);
          if (
            pending.some(
              ({ subject }) =>
                subject.goalRef === ref || (goal && subject.goalId === goal.id),
            )
          )
            tracks.delete(id);
        }
        if (!tracks.size) decisionOrder = pending.map(({ id }) => id);
        else {
          const active = new Set([
            ...pending.map(({ id }) => id),
            ...tracks.keys(),
          ]);
          decisionOrder = [
            ...new Set([
              ...decisionOrder.filter((id) => active.has(id)),
              ...pending.map(({ id }) => id),
            ]),
          ];
        }
        renderNow(pending);
        if (itemResult.status === "fulfilled")
          inbox?.render(
            pending,
            goalLink,
            goalTitle,
            trackSlots(true),
            trackingData(),
          );
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
          activityResult,
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
          const exportMessage = exportMessages.get(detail.id) ?? "";
          const tasks = new Set(detail.tasks.map(({ id }) => id));
          const related = (item: PanelInboxItem) =>
            item.subject.goalId === detail.id ||
            Boolean(item.subject.taskId && tasks.has(item.subject.taskId));
          const decisions = pending.filter(related);
          const recent = items.filter(
            (item) => item.weight === "info" && related(item),
          );
          const running = activity.running.filter(
            ({ goalId }) => goalId === detail.id,
          );
          const problem = (
            problemResult.status === "fulfilled"
              ? problemResult.value
              : undefined
          )?.find((row) => row.goalId === detail.id && "canRetry" in row);
          renderWork(
            [
              {
                ...detail,
                tasks: detail.tasks.map(
                  ({ elapsedMs: _elapsed, estimate, ...task }) => [
                    task,
                    estimateLabel(estimate.remainingMs),
                  ],
                ),
              },
              decisionSnapshot(decisions),
              inbox?.revision,
              decisionSnapshot(recent),
              running,
              problem,
              draftedPlans.has(detail.ref),
              exportMessage,
            ],
            () =>
              goalDetail(
                detail,
                [
                  group(
                    "section",
                    "card goal-now",
                    sectionTitle("いま"),
                    goalTurn(detail, true),
                    ...running.map((row) =>
                      runningLine(row, () => selectRun(row), detail.ref),
                    ),
                    ...(detail.turn.reason.kind === "not-planned"
                      ? [planButton(detail.ref, detail.title)]
                      : []),
                  ),
                ],
                decisions.length && inbox
                  ? [
                      sectionTitle("あなたの番"),
                      ...decisions.map((item) =>
                        inbox.card(item, goalLink, {
                          goalRef: detail.ref,
                          surface: "goal",
                        }),
                      ),
                    ]
                  : [],
                problem
                  ? goalProblem(
                      detail,
                      problem,
                      channel,
                      () => navigate({ tab: "problems" }),
                      focusConcierge,
                    )
                  : [],
                goalDelegation(detail, channel, savedPolicy),
                recent,
                (taskId) =>
                  navigate({ tab: "goals", goalId: detail.id, taskId }),
                watch,
                goalExport(channel, detail, exportMessage, (message) => {
                  exportMessages.set(detail.id, message);
                  previousView = "";
                  void refresh(false);
                }),
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
          for (const [id, { problem }] of problemReceipts) {
            if (
              problems.some((rows) =>
                rows.some(
                  (row) =>
                    row.taskId === id &&
                    row.expectedRetries !== problem.expectedRetries,
                ),
              )
            )
              problemReceipts.delete(id);
          }
          const receipts = [...problemReceipts.values()];
          const currentProblems = problems.filter(
            (rows) =>
              !receipts.some(({ problem, receipt }) =>
                rows.some((row) =>
                  receipt === "cancelled"
                    ? row.goalId === problem.goalId
                    : row.taskId === problem.taskId,
                ),
              ),
          );
          renderWork(
            [
              currentProblems,
              receipts,
              currentProblems.map(([row]) => goalTitle(row?.goalId)),
            ],
            () => [
              ...receipts.map(({ problem, receipt }) =>
                problemReceipt(problem, receipt, goalLink),
              ),
              ...(currentProblems.length
                ? currentProblems.map((rows) =>
                    problemCard(
                      rows,
                      items,
                      channel,
                      goalLink,
                      (subject) => navigate({ tab: "goals", ...subject }),
                      goalTitle(rows[0]?.goalId),
                      focusConcierge,
                      (problem, receipt) => {
                        const key =
                          (receipt === "retried"
                            ? problem.taskId
                            : problem.goalId) ?? "";
                        problemReceipts.set(key, { problem, receipt });
                        void refresh();
                      },
                      watch,
                    ),
                  )
                : receipts.length
                  ? []
                  : [empty("問題はありません。")]),
            ],
          );
        } else if (
          goalTab &&
          !current.goalId &&
          !current.taskId &&
          goalResult.status === "fulfilled"
        ) {
          const byGoal = new Map(
            goals.map((goal) => [
              goal.id,
              pending.filter(
                ({ subject }) =>
                  subject.goalId === goal.id || subject.goalRef === goal.ref,
              ),
            ]),
          );
          renderWork([goals, decisionSnapshot(pending), inbox?.revision], () =>
            goals.length
              ? turnGroups.flatMap(({ label, owners }) => {
                  const groupGoals = goals.filter(({ turn }) =>
                    owners.includes(turn.owner),
                  );
                  return groupGoals.length
                    ? [
                        sectionTitle(label),
                        ...groupGoals.map((entry) => {
                          const decisions = byGoal.get(entry.id) ?? [];
                          return goalRow(
                            entry,
                            () => navigate({ tab: "goals", goalId: entry.id }),
                            () =>
                              inbox
                                ? decisions.map((item) =>
                                    inbox.card(item, goalLink, {
                                      flat: true,
                                      surface: "list",
                                      goalTitle:
                                        goalTitle(item.subject.goalId) ?? "",
                                    }),
                                  )
                                : [],
                            decisions.length > 0,
                            inlineGoals,
                          );
                        }),
                      ]
                    : [];
                })
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
    window.setInterval(() => {
      void refresh(++poll % 4 === 0);
      for (const elapsed of document.querySelectorAll<HTMLElement>(".elapsed"))
        elapsed.textContent = elapsedLabel(elapsed.dataset.startedAt ?? null);
    }, 5000);
    document.addEventListener("visibilitychange", () => void refresh());
  }
  return {
    refresh,
    closeSettings,
    closeNow: now.close,
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
