import {
  proposalWithheldFields,
  type ProposalScreenedField,
} from "../../local-orchestrator/proposal-screening.ts";
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
import {
  goalPublishConfirmation,
  goalPrOpenGuidance,
  type GoalPublishConfirmationPr,
  type GoalPrActions,
  type GoalPublishView,
} from "../../publish/protocol.ts";
import {
  autoMergeMethods,
  mergeMethods,
  type PublishChecks,
  type PublishCheckState,
  type PublishFailure,
} from "../../publish/port.ts";
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
  planningDraft,
  groupProblems,
  retryCommand,
  type Activity,
  type ActivityRow,
  type AgentDecision,
  type AnswerableProposal,
  type GoalDetail,
  type GoalSummary,
  type Methods,
  type PanelInboxItem,
  type Problem,
  type Proposal,
  type TaskDetail,
  type TaskSummary,
} from "./protocol.ts";

import { icon, visual } from "./icons.ts";

const labels = {
  registered: "登録",
  running: "実行",
  review: "レビュー",
  "awaiting-integration": "統合待ち",
  "awaiting-host-check": "ホスト検証待ち",
  done: "完了",
  failed: "失敗",
  cancelled: "キャンセル",
  active: "進行中",
} as const;

const answerLabels = {
  "host-check": "ホスト検証",
  goal: "Goal の提案",
  task: "Task の提案",
  integration: "統合",
} as const;
const proposalKinds = {
  "goal-registration": ["flag", answerLabels.goal],
  "task-registration": ["checklist", answerLabels.task],
  integration: ["merge", answerLabels.integration],
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
    "awaiting-host-check": "warn",
    done: "ok",
    failed: "danger",
    cancelled: "info",
    active: "accent",
  }[state];
  return chip(labels[state], tone);
}

function modelAttribution() {
  return textElement("span", "AI の記述 ", "sr-only");
}

function modelTitle<K extends "h2" | "h3" | "span">(
  tag: K,
  value: string,
  classes = "title",
) {
  return group(
    tag,
    `${classes} model-title`,
    modelAttribution(),
    textElement("bdi", value),
  );
}

function packageDiffLines(entries: readonly string[], total: number) {
  const more = total - entries.length;
  return more > 0 ? [...entries, `ほか ${more} 件`] : entries;
}

function modelBox(label: string, lines: readonly string[]) {
  return group(
    "div",
    "card",
    group(
      "h3",
      "section-title",
      modelAttribution(),
      document.createTextNode(label),
    ),
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
    case "stale-policy":
      return "適用ルールが変わりました。もう一度確認してください。";
    case "invalid-transition":
      return "この提案はすでに判断待ちではありません。";
    case "approval-forbidden":
      return "現在のポリシーではパネルから回答できません。";
    case "goal-pr-open":
      return goalPrOpenGuidance;
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

const proposalFieldLabels: Record<ProposalScreenedField, string> = {
  description: "説明",
  acceptance: "受け入れ条件",
  findings: "所見",
  paths: "対象パス",
  pathViolations: "範囲外のパス",
  changedPaths: "変更パス",
  diffStat: "変更規模",
  ruleId: "ルール ID",
  ruleName: "ルール名",
};

function maskedExplanation(fields: readonly ProposalScreenedField[]) {
  return `${fields.map((field) => proposalFieldLabels[field]).join("・")}に資格情報らしい文字列があり、伏せています。`;
}

function proposalHasWithheld(proposal: Proposal) {
  return proposalWithheldFields(proposal).length > 0;
}

function aiPending(item: PanelInboxItem) {
  return (
    "answer" in item &&
    item.answer.takeover === true &&
    !item.answer.approve &&
    !item.answer.reject
  );
}

function workplaceDecisions(items: readonly PanelInboxItem[]) {
  return [
    ...pendingDecisions(items),
    ...items.filter(
      ({ kind, state }) => kind === "pr-auto-merge" && state !== "resolved",
    ),
  ];
}

function splitDecisions(items: readonly PanelInboxItem[]) {
  const human: PanelInboxItem[] = [];
  const ai: PanelInboxItem[] = [];
  const armed: PanelInboxItem[] = [];
  for (const item of items) {
    const section =
      item.kind === "pr-auto-merge" ? armed : aiPending(item) ? ai : human;
    section.push(item);
  }
  return { human, ai, armed };
}

function rememberedDetails(
  label: string,
  key: string,
  opened: Set<string>,
  ...children: Node[]
) {
  const summary = textElement("summary", label);
  summary.dataset.focusKey = key;
  const details = group("details", "card fold", summary, ...children);
  details.open = opened.has(key);
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    if (details.open) opened.add(key);
    else opened.delete(key);
  });
  return details;
}

function aiSection(
  items: PanelInboxItem[],
  surface: string,
  opened: Set<string>,
  render: (item: PanelInboxItem) => HTMLElement,
) {
  return rememberedDetails(
    `AI が答える予定（${items.length} 件）`,
    `ai-decisions:${surface}`,
    opened,
    group("div", "stack", ...items.map(render)),
  );
}

function diffSummary(proposal: Extract<Proposal, { kind: "integration" }>) {
  const { changedLines, diffStat } = proposal;
  const stat = typeof diffStat === "string" ? diffStat.trim() : "";
  const summary =
    /^\d+ files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/.exec(
      stat.slice(stat.lastIndexOf("\n") + 1).trim(),
    );
  const added = Number(summary?.[1] ?? 0);
  const removed = Number(summary?.[2] ?? 0);
  const total = added + removed;
  const split =
    Boolean(summary) &&
    Number.isSafeInteger(total) &&
    (changedLines === null
      ? !/\|\s+Bin \d+ -> \d+ bytes$/m.test(stat)
      : total === changedLines);
  return diffCounts(added, removed, split, changedLines);
}

function diffCounts(
  added: number,
  removed: number,
  split: boolean,
  changedLines: number | null = null,
) {
  const total = added + removed;
  const addedBlocks =
    split && added > 0
      ? removed === 0
        ? 5
        : Math.min(4, Math.max(1, Math.round((added / total) * 5)))
      : 0;
  const blocks = group(
    "span",
    "diff-blocks",
    ...Array.from({ length: 5 }, (_, index) => {
      const kind =
        !split || total === 0
          ? "neutral"
          : index < addedBlocks
            ? "added"
            : "removed";
      return group(
        "span",
        `diff-block ${kind}`,
        icon(
          kind === "added" ? "plus" : kind === "removed" ? "minus" : "circle",
        ),
      );
    }),
  );
  const label = split
    ? `追加 ${added} 行、削除 ${removed} 行`
    : changedLines === null
      ? "変更行数は不明"
      : `変更 ${changedLines} 行`;
  const result = group(
    "span",
    "visual diff-summary",
    blocks,
    ...(split
      ? [
          textElement("span", `+${added}`, "added"),
          textElement("span", `−${removed}`, "removed"),
        ]
      : [
          textElement(
            "span",
            changedLines === null ? "—" : String(changedLines),
          ),
        ]),
  );
  result.setAttribute("role", "img");
  result.setAttribute("aria-label", label);
  result.title = label;
  return result;
}

function proposalKeyFacts(proposal: Proposal) {
  if (proposal.kind === "integration") {
    const passed = proposal.modelText.verdict === "pass";
    return [
      visual(
        passed ? "check" : "cross",
        passed ? "AI レビュー合格" : "AI レビューに懸念あり",
        passed ? "added" : "removed",
      ),
      visual(
        "file",
        `${proposal.changedFiles} ファイル`,
        "",
        String(proposal.changedFiles),
      ),
      diffSummary(proposal),
    ];
  }
  const { acceptance } = proposal.modelText;
  const conditions =
    "withheld" in acceptance
      ? textElement("span", withheldText)
      : visual(
          "checklist",
          `受け入れ条件 ${acceptance.length} 件`,
          "",
          String(acceptance.length),
        );
  const paths = proposal.paths;
  const pathFact =
    "withheld" in paths
      ? textElement("span", withheldText)
      : visual(
          "folder",
          paths.length ? `対象パス ${paths.join("、")}` : "対象パスなし",
          "path-fact",
          textElement("bdi", paths[0] ?? "—"),
          ...(paths.length > 1
            ? [textElement("span", `+${paths.length - 1}`, "chip info")]
            : []),
        );
  return [
    conditions,
    ...(proposal.kind === "goal"
      ? [
          visual(
            "tasks",
            `Task 上限 ${proposal.maxTasks}`,
            "",
            String(proposal.maxTasks),
          ),
        ]
      : []),
    pathFact,
  ];
}

function delegationExplanation(gates: readonly (keyof typeof gateLabels)[]) {
  return `承認すると、この先の判断を AI に任せる設定が入ります（${gates.map((gate) => gateLabels[gate]).join("、")}）。`;
}

function warningSummary(label: string, explanation: string, key: string) {
  const warning = group(
    "span",
    "visual warning warning-summary",
    icon("warning"),
  );
  warning.append(
    label,
    textElement("span", ` ${explanation}`, "warning-explanation"),
  );
  warning.title = explanation;
  warning.tabIndex = 0;
  warning.dataset.focusKey = key;
  return warning;
}

function delegationWarning(
  gates: readonly (keyof typeof gateLabels)[],
  key: string,
) {
  return warningSummary(
    "委任を拡大",
    delegationExplanation(gates),
    `delegation:${key}`,
  );
}

function proposalWarnings(
  proposal: Proposal,
  pendingGates: readonly (keyof typeof gateLabels)[],
  key: string,
) {
  const violations = proposal.pathViolations;
  const hidden = proposalWithheldFields(proposal);
  const gates = [...new Set([...pendingGates, ...proposal.loosening])];
  return [
    ...("withheld" in violations || violations.length
      ? [
          warningSummary(
            "withheld" in violations ? "範囲外" : `範囲外 ${violations.length}`,
            "withheld" in violations
              ? withheldText
              : `範囲外のパス\n${violations.join("\n")}`,
            `scope:${key}`,
          ),
        ]
      : []),
    ...(gates.length ? [delegationWarning(gates, key)] : []),
    ...(proposal.maskedFields
      ? [
          warningSummary(
            "伏せ字あり",
            maskedExplanation(proposal.maskedFields),
            `masked:${key}`,
          ),
        ]
      : []),
    ...(hidden.length
      ? [
          textElement(
            "p",
            `${withheldApproval} 非表示の項目は${hidden.map((field) => proposalFieldLabels[field]).join("・")}です。`,
            "warning",
          ),
        ]
      : []),
  ];
}

function proposalEvidence(
  proposal: Proposal,
  pendingGates: readonly (keyof typeof gateLabels)[],
) {
  const { pathViolations } = proposal;
  const gates = [...new Set([...pendingGates, ...proposal.loosening])];
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
  ];

  const model = group(
    "section",
    "stack",
    textElement("h4", "AI の記述", "section-title"),
  );
  let evidence: HTMLElement;
  if (proposal.kind === "integration") {
    evidence = facts([
      ["変更パス", proposalList(proposal.changedPaths)],
      [
        "変更規模",
        typeof proposal.diffStat === "string"
          ? textElement("pre", proposal.diffStat.trim())
          : withheldText,
      ],
    ]);
    const { verdict, findings } = proposal.modelText;
    model.append(
      verdict === "pass"
        ? textElement("p", "AI レビューに合格しました。")
        : textElement("p", "AI レビューで懸念が報告されました。", "warning"),
    );
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
    evidence = facts([["対象パス", proposalList(proposal.paths)]]);
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
  return group(
    "div",
    "stack",
    ...("withheld" in pathViolations || pathViolations.length
      ? [facts([["範囲外のパス", proposalList(pathViolations)]])]
      : []),
    ...(gates.length
      ? [textElement("p", delegationExplanation(gates), "warning")]
      : []),
    ...(proposal.maskedFields
      ? [textElement("p", maskedExplanation(proposal.maskedFields), "warning")]
      : []),
    evidence,
    model,
    group(
      "details",
      "execution-conditions",
      textElement("summary", "実行の条件"),
      ...(proposal.humanAnswerRequired || proposal.humanApprovalRequired
        ? [textElement("p", "人の判断が必要")]
        : []),
      facts(hostFacts),
    ),
  );
}

type Watch = (
  node: HTMLElement,
  ids: readonly string[],
  load?: () => void,
) => void;
type GoalLink = (id?: string | null, ref?: string | null) => Node[];

export function createInboxPanel(
  channel: Pick<WorkplaceChannel, "request">,
  refresh: (message?: string) => void,
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
  const openedSections = new Set<string>();
  const stale = new Map<string, string>();
  const previews = new Map<
    string,
    { key: string; pending: Promise<Proposal> }
  >();
  let prefetch = Promise.resolve();
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

  function preview(id: string, answer?: AnswerableProposal) {
    const key = JSON.stringify([
      answer?.digest,
      answer?.approve,
      answer?.reject,
      answer?.takeover,
    ]);
    const existing = previews.get(id);
    if (existing?.key === key) return existing.pending;
    const pending = channel
      .request("proposal.get", { id })
      .catch((error: unknown) => {
        if (previews.get(id)?.pending === pending) previews.delete(id);
        throw error;
      });
    previews.set(id, { key, pending });
    return pending;
  }

  function staleAnswer(
    answer: AnswerableProposal,
    item: PanelInboxItem,
    policyChanged = false,
  ) {
    if (!policyChanged && stale.get(answer.id) === answer.digest) return;
    if (!policyChanged) stale.set(answer.id, answer.digest);
    expanded.add(item.id);
    previews.delete(answer.id);
    revision++;
    refresh();
  }

  async function validate(answer: AnswerableProposal) {
    const proposal = await preview(answer.id, answer);
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
    takeover?: true,
  ) {
    if (answering) return;
    if (
      rows.some(
        (item) => "answer" in item && item.answer.kind === "host-check",
      ) &&
      (decision === "approve" || rows.length !== 1)
    ) {
      status.replaceChildren(
        textElement("p", answerError("approval-forbidden"), "status-error"),
      );
      return;
    }
    answering = true;
    updateControls();
    const pinned = rows.flatMap((item) =>
      "answer" in item ? [{ item, answer: item.answer }] : [],
    );
    const answers = pinned.map(({ answer: { id, digest } }) => ({
      id,
      digest,
      decision,
      ...(takeover && { takeover }),
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
          if (
            outcome.error.code === "stale-digest" ||
            outcome.error.code === "stale-policy"
          )
            staleAnswer(answer, item, outcome.error.code === "stale-policy");
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
      if (code === "stale-digest" || code === "stale-policy")
        for (const { answer, item } of pinned)
          staleAnswer(answer, item, code === "stale-policy");
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
    decision: PanelAnswer["decision"] | "takeover",
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
    const takeover = decision === "takeover";
    const rejectOnly = reject || (takeover && first?.approve);
    const title = first?.title ?? pinned[0]?.modelText ?? "提案";
    const message = takeover
      ? `「${title}」に AI の代わりに回答します。`
      : reject
        ? `「${title}」を却下します。`
        : pinned.length > 1
          ? `${pinned.length} 件を承認します。`
          : `「${title}」を${integration ? "統合" : "承認"}します。`;
    const msg = textElement("bdi", message, "q");
    const cancel = action("戻す", "cancel-answer", () => {
      close();
      trigger.focus();
    });
    const approval =
      integration && pinned.length === 1 ? "承認して統合を確定" : "承認を確定";
    const submit = submitButton(rejectOnly ? "reject" : "approve");
    const decline =
      takeover && !rejectOnly && !first?.reject
        ? submitButton("reject")
        : undefined;
    function submitButton(answer: PanelAnswer["decision"]) {
      const button = action(
        answer === "reject" ? "却下を確定" : approval,
        takeover ? `submit-takeover:${answer}` : "submit-answer",
        () => {
          if (button.disabled || cancelConfirmation !== close || answering)
            return;
          submit.disabled = cancel.disabled = true;
          if (decline) decline.disabled = true;
          void send(
            pinned,
            answer,
            status,
            () => {
              if (cancelConfirmation === close) {
                close();
                trigger.focus({ preventScroll: true });
              }
            },
            takeover ? true : undefined,
          );
        },
        answer === "reject" ? "btn danger" : "btn primary",
      );
      return button;
    }
    const strip = group(
      "div",
      rejectOnly ? "confirm reject" : "confirm",
      msg,
      cancel,
      ...(decline ? [decline] : []),
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

    if (!rejectOnly) {
      submit.disabled = true;
      void Promise.all(
        pinned.map(async (item) => {
          if (!("answer" in item)) return "提案を取得できませんでした。";
          const { answer } = item;
          try {
            const proposal = await validate(answer);
            return { masked: Boolean(proposal.maskedFields?.length) };
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
        const errors = [
          ...new Set(messages.filter((result) => typeof result === "string")),
        ];
        if (
          messages.some((result) => typeof result === "object" && result.masked)
        )
          msg.textContent = `${message} 伏せ字を含む提案があります。`;
        status.replaceChildren(
          ...errors.map((error) => textElement("p", error, "warning")),
        );
        submit.disabled = errors.length > 0;
        submit.hidden = errors.includes(withheldApproval);
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
    if ("pullRequest" in item) {
      const row = prDecisionCard(
        channel,
        item,
        goalLink,
        Boolean(options.flat),
        refresh,
      );
      watch(row, item.state === "open" ? [item.id] : []);
      if (options.surface) {
        const surfaces = cards.get(item.id) ?? new Map();
        surfaces.set(options.surface, {
          signature,
          node: row,
          updateButtons: () => {},
        });
        cards.set(item.id, surfaces);
      }
      return row;
    }
    const reason = textElement(
      "span",
      needsReview
        ? answerError("stale-digest")
        : !aiPending(item) && (!options.surface || options.surface === "list")
          ? "あなたが答える"
          : "",
      "decision-reason",
    );
    const kind =
      item.kind in proposalKinds
        ? proposalKinds[item.kind as keyof typeof proposalKinds]
        : undefined;
    const subject = item.subject;
    const goalProposal = item.kind === "goal-registration";
    const subjectRef =
      subject.taskRef ??
      (goalProposal ? (subject.ref ?? subject.goalRef) : undefined);
    const top = group(
      "div",
      "card-top",
      kind
        ? visual(kind[0], kind[1], "chip info")
        : chip(
            item.kind === "secret-test-required"
              ? "シークレットの動作確認"
              : item.title,
            "warn",
          ),
      ...refNodes(subjectRef, options.goalRef),
      ...(aiPending(item) ? [chip("AI が回答予定", "ai-pending")] : []),
      reason,
    );
    const row = textElement(
      options.batch ? "li" : "article",
      "",
      `card${options.flat ? " flat" : ""}${aiPending(item) ? " ai-pending-card" : ""}`,
    );
    const keyFact = textElement("div", "", "decision-key-fact");
    keyFact.hidden = true;
    const warnings = group("div", "stack decision-warnings");
    if (answer?.approveReason === "host-check-detail-required")
      warnings.append(
        textElement("p", "ホスト検証の承認には詳細画面が必要です。", "muted"),
      );
    if (answer?.agentGates.length)
      warnings.append(delegationWarning(answer.agentGates, item.id));
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
      !answer,
    );
    const more = textElement("summary", "…");
    more.setAttribute("aria-label", "提案のその他の操作");
    more.dataset.focusKey = `more:${item.id}`;
    const menu = group("details", "decision-menu", more, command.copy);
    command.status.className = "muted decision-command-status";
    command.copy.addEventListener("click", () => {
      if (menu.hidden) return;
      menu.open = false;
      more.focus();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      event.stopPropagation();
      menu.open = false;
      more.focus();
    });
    const inlineCopy = group("div", "actions");
    inlineCopy.hidden = true;
    function showCommand() {
      menu.hidden = true;
      command.text.hidden = false;
      inlineCopy.hidden = false;
      inlineCopy.append(command.copy);
    }
    if (!answer) showCommand();
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
    toggle.hidden = answer?.kind === "host-check";
    const hint = textElement("span", "読んだ内容で確定します", "muted");
    const actions = group(
      "div",
      "actions decision-actions",
      toggle,
      menu,
      textElement("span", "", "spacer"),
      hint,
    );
    const answerArea = group("div", "stack", actions, status);
    let viewed: Proposal | undefined;
    let loading = false;
    let approvalWithheld = false;
    let approve: HTMLButtonElement | undefined;
    let reject: HTMLButtonElement | undefined;
    let takeover: HTMLButtonElement | undefined;
    let sending = false;
    function canApprove() {
      return (
        !answering &&
        !sending &&
        viewed?.status === "pending" &&
        viewed.digest === answer?.digest &&
        !approvalWithheld
      );
    }
    function updateButtons() {
      if (reject) reject.disabled = answering;
      if (takeover) takeover.disabled = answering;
      if (approve) {
        approve.disabled = !canApprove();
        approve.hidden = approvalWithheld;
      }
      hint.hidden = detail.hidden || !answer?.approve || approvalWithheld;
    }
    function updateDisclosure() {
      const parent = detail.hidden ? answerArea : detail;
      if (actions.parentElement !== parent) parent.prepend(actions);
      if (!detail.hidden && detail.lastElementChild !== actions)
        detail.append(actions);
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
        if (checkbox.disabled) return;
        cancelConfirmation?.();
        if (checkbox.checked) chosen.set(answer.id, answer.digest);
        else chosen.delete(answer.id);
        updateControls();
      });
      updateSelection = () => {
        checkbox.checked = chosen.get(answer.id) === answer.digest;
        checkbox.disabled =
          !canApprove() || (!checkbox.checked && chosen.size >= 20);
        checkbox.hidden = approvalWithheld;
      };
      updateSelection();
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
    if (answer?.takeover) {
      const button = action("自分で答える", `takeover:${item.id}`, () => {
        if (answering) return;
        detail.hidden = false;
        expanded.add(item.id);
        updateDisclosure();
        void load();
        confirm(answerArea, [item], "takeover", button, actions, status);
      });
      takeover = button;
      actions.append(button);
    }
    if (options.batch) controls.push(updateButtons);
    updateDisclosure();

    row.append(
      top,
      name ? modelTitle("h3", name) : textElement("h3", item.title, "title"),
      ...(options.goalRef || (goalProposal && subjectRef)
        ? []
        : goalLink(subject.goalId, subject.goalRef)),
      keyFact,
      warnings,
      command.text,
      inlineCopy,
      command.status,
      detail,
      answerArea,
    );
    function renderEvidence() {
      if (viewed && !detail.hidden && !info.firstElementChild)
        info.replaceChildren(
          proposalEvidence(viewed, answer?.agentGates ?? []),
        );
    }
    async function load() {
      if (viewed) {
        renderEvidence();
        return;
      }
      if (!id || answer?.kind === "host-check") return;
      if (!detail.hidden) info.textContent = "提案の詳細を読み込み中…";
      if (loading) return;
      loading = true;
      try {
        const proposal = await preview(id, answer);
        if (answer && proposal.digest !== answer.digest) {
          reason.textContent = answerError("stale-digest");
          info.replaceChildren();
          staleAnswer(answer, item);
          return;
        }
        viewed = proposal;
        approvalWithheld = proposalHasWithheld(proposal);
        keyFact.replaceChildren(...proposalKeyFacts(proposal));
        keyFact.hidden = false;
        restoreFocus(warnings, () =>
          warnings.replaceChildren(
            ...proposalWarnings(proposal, answer?.agentGates ?? [], item.id),
          ),
        );
        if (approvalWithheld) {
          showCommand();
          if (answer && chosen.get(answer.id) === answer.digest) {
            cancelConfirmation?.(batch);
            chosen.delete(answer.id);
            updateControls();
          }
        }
        renderEvidence();
        updateButtons();
        updateSelection?.();
      } catch {
        info.textContent = "提案の詳細を取得できませんでした。";
      } finally {
        loading = false;
      }
    }
    // Proposal reads can be expensive and share the host's serial connection.
    // Keep eager summaries in order while detail and answer actions can read immediately.
    if (detail.hidden)
      prefetch = prefetch.then(() => (row.isConnected ? load() : undefined));
    else void load();
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
    openedSections,
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
      if (
        snapshot === previous ||
        inbox.querySelector("[data-operator-confirming]")
      )
        return;
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
          const { human, ai, armed } = splitDecisions(rows);
          const aiIds = new Set(ai.map(({ id }) => id));
          const humanCards = withTracking(
            human,
            { ...extra, anchors: extra.anchors.filter((id) => !aiIds.has(id)) },
            (item) =>
              card(item, goalLink, {
                batch: true,
                surface: "decisions",
                goalTitle: goalTitle(item.subject.goalId) ?? "",
              }),
          );
          inbox.replaceChildren(
            ...(rows.length || humanCards.length
              ? [
                  group(
                    "section",
                    "stack",
                    sectionTitle(`あなたが答える（${human.length} 件）`),
                    humanCards.length
                      ? group("ul", "stack", ...humanCards)
                      : textElement(
                          "p",
                          "あなたが答える項目はありません。",
                          "meta",
                        ),
                  ),
                ]
              : []),
            ...(ai.length
              ? [
                  aiSection(ai, "decisions", openedSections, (item) =>
                    card(item, goalLink, {
                      surface: "decisions",
                      goalTitle: goalTitle(item.subject.goalId) ?? "",
                    }),
                  ),
                ]
              : []),
            ...(armed.length
              ? [
                  armedSection(armed, "decisions", openedSections, (item) =>
                    card(item, goalLink, { flat: true, surface: "decisions" }),
                  ),
                ]
              : []),
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

const timelineIcons = {
  started: "start",
  succeeded: "check",
  failed: "stop",
  approved: "approved",
  rejected: "rejected",
  integrated: "merge",
  exported: "export",
} as const;

function timelineMark(kind: keyof typeof timelineIcons, label: string) {
  return visual(timelineIcons[kind], label, `timeline-mark ${kind}`);
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
          "card timeline",
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
              timelineMark(
                approved ? "approved" : "rejected",
                approved ? "AI が承認" : "AI が却下",
              ),
              time(entry.at),
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

const publishStateLabels = {
  disabled: "無効",
  pending: "未公開",
  pushing: "送信中",
  pushed: "プッシュ済み",
  "pr-open": "オープン",
  merged: "マージ済み",
  "merged-stale": "マージ後に変更あり",
  closed: "クローズ済み",
  failed: "公開処理に失敗",
} satisfies Record<GoalSummary["publish"]["state"], string>;

const publishStateIcons = {
  disabled: "idle",
  pending: "hourglass",
  pushing: "export",
  pushed: "export",
  "pr-open": "pullRequest",
  merged: "merge",
  "merged-stale": "merge",
  closed: "cross",
  failed: "warning",
} as const;

const checkState = {
  none: ["circle", "チェックなし"],
  pending: ["hourglass", "チェック中"],
  failed: ["cross", "チェック失敗"],
  passed: ["check", "チェック通過"],
  unknown: ["circle", "チェックの状態は不明"],
} as const satisfies Record<PublishChecks, readonly [string, string]>;

const autoMergeLabels = {
  off: "オフ",
  squash: "スカッシュ",
  merge: "マージコミット",
  rebase: "リベース",
} as const;

const publishFailures = {
  "publish-disabled": [
    "PR 公開が無効",
    "local.json の公開設定を確認してください。",
  ],
  "publish-not-ready": [
    "公開の準備ができていない",
    "Task の統合と判断待ちを確認してください。",
  ],
  "publish-busy": [
    "別の処理が実行中",
    "処理が終わってからもう一度送ってください。",
  ],
  "publish-stale-head": [
    "Goal の先端が変更された",
    "最新の先端を確認してもう一度送ってください。",
  ],
  "publish-destination-invalid": [
    "公開先が無効",
    "local.json のリモートとベースを確認してください。",
  ],
  "publish-destination-changed": [
    "公開先が変更された",
    "最初に使った公開先とブランチを確認してください。",
  ],
  "publish-remote-head-changed": [
    "リモートの先端が変更された",
    "リモートを最後に送った先端に戻してから、もう一度送ってください。",
  ],
  "publish-export-failed": [
    "書き出しに失敗",
    "手元のブランチを確認してから、もう一度送ってください。",
  ],
  "branch-checked-out": [
    "書き出し先が使用中",
    "書き出し先を使用中の worktree で別のブランチに切り替えてください。",
  ],
  "non-fast-forward": [
    "手元のブランチを早送りできない",
    "手元のブランチの履歴を確認してください。",
  ],
  "invalid-object": [
    "コミットを確認できない",
    "手元に Goal のコミットがあるか確認してください。",
  ],
  "unsafe-repository": [
    "リポジトリの安全性を確認できない",
    "手元のリポジトリ設定を確認してください。",
  ],
  "publish-non-fast-forward": [
    "リモートのブランチを早送りできない",
    "リモートのブランチの履歴を確認してください。",
  ],
  "publish-screen-blocked": [
    "公開前の検査で停止",
    "履歴と PR に含まれる文面を確認してください。",
  ],
  "publish-push-failed": [
    "プッシュに失敗",
    "リモートへの接続と書き込み権限を確認してください。",
  ],
  "publish-pr-failed": [
    "PR の作成または取得に失敗",
    "GitHub の接続と PR の状態を確認してください。",
  ],
  "publish-merge-failed": [
    "PR をマージできませんでした",
    "GitHub で PR の状態を確認してください。",
  ],
  "publish-close-failed": [
    "PR を閉じられませんでした",
    "GitHub で PR の状態を確認してください。",
  ],
  "publish-checks-failed": [
    "チェック失敗",
    "GitHub で失敗したチェックを確認してください。",
  ],
  "publish-checks-pending": [
    "チェック中",
    "チェックが通るまで待つか、自動マージを設定してください。",
  ],
  "publish-checks-unknown": [
    "チェックの状態は不明",
    "GitHub でチェックの状態を確認するか、自動マージを設定してください。",
  ],
  "publish-not-mergeable": [
    "PR をマージできません",
    "GitHub でマージを妨げている条件を確認してください。",
  ],
  "publish-no-checks": [
    "チェックがありません",
    "最新の PR の状態を確認してからマージしてください。",
  ],
  "publish-auto-merge-failed": [
    "自動マージの設定に失敗",
    "GitHub で PR の自動マージ設定を確認してください。",
  ],
  "auto-merge-disarm-failed": [
    "自動マージを解除できない",
    "GitHub で PR の自動マージを解除してください。",
  ],
  "auto-merge-unavailable": [
    "自動マージを利用できない",
    "GitHub の設定を確認するか、PR を手動でマージしてください。",
  ],
  "publish-poll-failed": [
    "PR の状態を取得できない",
    "GitHub への接続と PR の状態を確認してください。",
  ],
  "publish-audit-failed": [
    "公開の監査記録に失敗",
    "Workplace の保存先を確認してください。",
  ],
} satisfies Record<PublishFailure, readonly [string, string]>;

function turnReason(goal: GoalSummary): string {
  const { reason } = goal.turn;
  switch (reason.kind) {
    case "approvals":
      return `判断 ${reason.count} 件`;
    case "cancelled":
      return "取り消し済み";
    case "failed":
      return `${reason.taskRef} ${failureReason(reason.code)}`;
    case "planning":
      return "計画中";
    case "running":
      return "作業中";
    case "queued":
      return "順番待ち";
    case "not-planned":
      return "計画前";
    case "exportable":
      return "書き出し可能";
    case "exported":
      return "手元に書き出し済み";
    case "publishing":
      return "公開中";
    case "pr-open":
      return `PR #${reason.prNumber} · ${prShortState(goal.publish)}`;
    case "merged":
      return `PR #${reason.prNumber} · ${publishStateLabels[goal.publish.state]}`;
    case "pr-closed":
      return `PR #${reason.prNumber} · クローズ済み`;
    case "publish-failed":
      return publishFailures[reason.code][0];
    case "completed":
      return "作業完了";
    case "idle":
      return "作業なし";
  }
}

function goalTurn(goal: GoalSummary, showReason = false, linkPr = false) {
  const { owner, reason } = goal.turn;
  const [glyph, label] = (
    {
      human: ["person", "あなたの番"],
      stopped: ["stop", "止まっています"],
      ai: ["robot", "AI の番"],
      idle: ["idle", "待機中"],
      done: ["check", "完了"],
    } as const
  )[owner];
  const explanation = turnReason(goal);
  const resultGlyph =
    reason.kind === "exported"
      ? "export"
      : reason.kind === "pr-open" ||
          reason.kind === "publishing" ||
          reason.kind === "merged" ||
          reason.kind === "pr-closed" ||
          reason.kind === "publish-failed"
        ? publishStateIcons[goal.publish.state]
        : null;
  const visible =
    showReason || reason.kind === "failed" || resultGlyph !== null;
  const mark = visual(
    resultGlyph ?? glyph,
    `${label}。 ${explanation}`,
    `owner ${owner}`,
  );
  mark.title = explanation;
  const prLink = linkPr ? goalPrLink(goal.publish) : null;
  const prLabel = prLink?.textContent ?? "";
  const reasonText =
    prLink && explanation.startsWith(prLabel)
      ? [prLink, explanation.slice(prLabel.length)]
      : [explanation, ...(prLink ? [" · ", prLink] : [])];
  const reasonLabel = textElement("span", "", "meta");
  reasonLabel.append(...reasonText);
  return group(
    "div",
    "turn-line",
    mark,
    ...(visible ? [reasonLabel] : []),
    ...(reason.kind === "pr-open" && reason.checks
      ? [
          visual(
            checkState[reason.checks][0],
            checkState[reason.checks][1],
            "pr-check",
          ),
        ]
      : []),
  );
}

function shortEta(estimate: GoalSummary["estimate"]) {
  const label = estimateLabel(estimate.remainingMs);
  return label
    ? [visual("clock", label, "eta", label.replace("（現時点の計画では）", ""))]
    : [];
}

export function goalProgress(goal: GoalSummary) {
  const { done, total, running, failed, cancelled = 0 } = goal.progress;
  const waiting = total - done - running - failed - cancelled;
  const segments = [
    ["done", "check", done, "完了"],
    ["running", "start", running, "実行中"],
    ["waiting", "hourglass", waiting, "待機"],
    ["failed", "cross", failed, "失敗"],
    ["cancelled", "rejected", cancelled, "キャンセル"],
  ] as const;
  const bar = group("span", "goal-progress-bar");
  for (const [stage, glyph, count, name] of segments) {
    if (!count) continue;
    const segment = group(
      "span",
      `goal-progress-segment ${stage}`,
      icon(glyph),
    );
    // Hovering one segment names its stage and count.
    segment.title = `${name} ${count} 件`;
    segment.style.flexGrow = String(count);
    bar.append(segment);
  }
  const summary = group(
    "span",
    "visual goal-progress",
    bar,
    textElement("span", `${done}/${total}`),
  );
  const label = `Task ${done} / ${total} 完了、実行中 ${running}、待機 ${waiting}、失敗 ${failed}${cancelled ? `、キャンセル ${cancelled}` : ""}`;
  summary.setAttribute("role", "img");
  summary.setAttribute("aria-label", label);
  summary.title = label;
  return group("span", "goal-metrics", summary, ...shortEta(goal.estimate));
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
    goalProgress(goal),
  );
  const prLink = goalPrLink(goal.publish);
  const armed = goal.publish.autoMergeEnabled && !goal.publish.prActionOutcome;
  const turn =
    goal.turn.reason.kind === "pr-open" && prLink
      ? group(
          "div",
          "turn-line pr-list-row",
          visual(
            "merge",
            armed ? "自動マージ待ち" : "PR のマージ",
            armed ? "chip pr-armed" : "chip info",
          ),
          prLink,
          prCheckMark(goal.publish),
          textElement("span", prShortState(goal.publish), "grow meta"),
        )
      : goalTurn(goal, false, true);
  const row = group("article", "card goal-row", header, turn);
  if (goal.turn.owner === "human" && hasDecisions) {
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

function taskStepper(task: TaskSummary) {
  const steps = ["作業", "検証", "レビュー", "統合", "完了"];
  const stage =
    task.failureStage ?? (task.verification ? "review" : task.stage);
  const index =
    stage === "review"
      ? task.verification
        ? 1
        : 2
      : stage === "awaiting-integration"
        ? 3
        : stage === "done"
          ? 4
          : 0;
  const markers = {
    failed: [`失敗（${steps[index]}）`, "cross", "failed"],
    cancelled: ["キャンセル", "rejected", "current"],
    registered: ["待機", "hourglass", "current"],
    done: ["完了", "check", "current"],
    running: [steps[index], "start", "current"],
    review: [steps[index], "start", "current"],
    "awaiting-integration": [steps[index], "start", "current"],
    "awaiting-host-check": [labels["awaiting-host-check"], "start", "current"],
  } as const;
  const [status, glyph, tone] = markers[task.stage];
  const label = `現在: ${status}`;
  const stepper = group(
    "span",
    "task-stepper",
    ...steps.map((_, step) => {
      if (step === index) return group("span", `step ${tone}`, icon(glyph));
      return group("span", "step", icon(step < index ? "minus" : "circle"));
    }),
  );
  stepper.setAttribute("role", "img");
  stepper.setAttribute("aria-label", label);
  stepper.title = `${steps.join(" → ")}。 ${label}`;
  return stepper;
}

function taskRow(task: TaskSummary, goalRef: string, open: () => void) {
  const row = action("", task.id, open, "taskrow");
  row.append(
    ...refNodes(task.ref, goalRef),
    modelTitle("span", task.title, "t"),
    taskStepper(task),
    ...shortEta(task.estimate),
  );
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
      run.resolvingDependencies
        ? "依存を解決中"
        : run.preparingEnvironment
          ? "環境を準備中"
          : run.actor,
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

const goalTabs = [
  ["overview", "概要"],
  ["delegation", "任せ方"],
  ["history", "履歴"],
  ["details", "詳細"],
] as const;
type GoalTab = (typeof goalTabs)[number][0];

function goalDetailTabs(
  selected: GoalTab,
  contents: Record<GoalTab, Node[]>,
  remember: (tab: GoalTab) => void,
) {
  const tabs = group("div", "goal-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Goal の表示");
  const entries = goalTabs.map(([key, label], index) => {
    const tab = action(label, `goal-tab:${key}`, () => select(key), "tab");
    const panel = group("section", "stack", ...contents[key]);
    tab.id = `goal-tab-${key}`;
    panel.id = `goal-panel-${key}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.tabIndex = 0;
    panel.dataset.focusKey = `goal-panel:${key}`;
    tab.addEventListener("keydown", (event) => {
      const next = {
        ArrowLeft: (index + goalTabs.length - 1) % goalTabs.length,
        ArrowRight: (index + 1) % goalTabs.length,
        Home: 0,
        End: goalTabs.length - 1,
      }[event.key];
      const entry = next === undefined ? undefined : entries[next];
      if (!entry) return;
      event.preventDefault();
      select(entry.key);
      entry.tab.focus();
    });
    tabs.append(tab);
    return { key, tab, panel };
  });
  function select(key: GoalTab) {
    remember(key);
    for (const entry of entries) {
      const active = entry.key === key;
      entry.tab.setAttribute("aria-selected", String(active));
      entry.tab.tabIndex = active ? 0 : -1;
      entry.panel.hidden = !active;
    }
  }
  select(selected);
  return [tabs, ...entries.map(({ panel }) => panel)];
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
  goalControls: Node[],
  selectedTab: GoalTab,
  selectTab: (tab: GoalTab) => void,
) {
  const scope = goal.scope;
  const details = [
    group(
      "div",
      "card",
      facts([
        ["対象パス", scope.paths.join(", ")],
        ["アクター", scope.actors.join(", ") || "—"],
        ["プロファイル", scope.profiles.join(", ") || "—"],
        ["Task 上限", String(scope.maxTasks)],
        [
          "予算",
          `${formatDuration(goal.budgets.maxExecutionMs)} / ${formatTokens(goal.budgets.maxTokens)} トークン / 再試行 ${goal.budgets.maxRetries} 回`,
        ],
        ["ブランチ", goal.branch],
        ["ベースコミット", goal.baseCommit ?? "—"],
      ]),
    ),
    ...(goal.description ? [modelBox("説明", [goal.description])] : []),
    modelBox("受け入れ条件", goal.acceptance),
  ];
  const recent = [
    ...activity.map((item) => {
      const kind =
        item.kind === "task-running"
          ? "started"
          : item.kind === "task-failed"
            ? "failed"
            : "succeeded";
      const label =
        kind === "started" ? "開始" : kind === "failed" ? "失敗" : "完了";
      const row = group(
        "div",
        "activity",
        timelineMark(kind, label),
        time(item.at),
        ...refNodes(item.subject.taskRef ?? item.subject.goalRef, goal.ref),
        ...(item.modelText ? [modelTitle("span", item.modelText, "grow")] : []),
        textElement("span", kind === "failed" ? item.title : label),
      );
      watch(row, item.state === "open" ? [item.id] : []);
      return { at: item.at, row };
    }),
    ...(goal.timeline ?? []).map(({ kind, at, ref, proposalKind }) => {
      const result = {
        approved: "承認",
        rejected: "却下",
        integrated: "統合",
        exported: "書き出し",
      }[kind];
      const label = proposalKind
        ? `${answerLabels[proposalKind]}を${result}`
        : result;
      return {
        at,
        row: group(
          "div",
          "activity",
          timelineMark(kind, result),
          time(at),
          ...refNodes(ref, goal.ref),
          textElement("span", label),
        ),
      };
    }),
  ].sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
  const header = group(
    "header",
    "goal-head",
    ...refNodes(goal.ref),
    modelTitle("h2", goal.title),
    goalProgress(goal),
  );
  const overview = [
    ...now,
    ...decisions,
    ...problem,
    ...goalControls,
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
  ];
  return [
    header,
    ...goalDetailTabs(
      selectedTab,
      {
        overview,
        delegation: [delegation],
        history: [
          sectionTitle("最近の動き"),
          recent.length
            ? group("div", "card timeline", ...recent.map(({ row }) => row))
            : empty("最近の動きはありません。"),
        ],
        details,
      },
      selectTab,
    ),
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

function tokenBudget(
  tokens: number | null,
  max: number,
  incomplete = false,
  prefix = "",
) {
  const usage =
    tokens === null
      ? "不明"
      : `${incomplete ? "少なくとも " : ""}${formatTokens(tokens)}`;
  const label = `${usage} / ${formatTokens(max)} トークン`;
  const over = tokens !== null && max > 0 && tokens > max;
  const caption = textElement("p", prefix + label, "meta");
  if (over) caption.append(" ", visual("warning", "予算超過", "removed"));
  return [
    caption,
    ...(tokens === null || max === 0
      ? []
      : [progress(tokens, max, label, over)]),
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
  const pr = task.pullRequest && goalPrLink(task.pullRequest);
  const prLine = textElement("p", "", "meta");
  if (pr) prLine.append("この Task は ", pr, " に含まれます");
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
      ...(pr ? [prLine] : []),
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
      ...tokenBudget(
        task.tokensUsed,
        task.budgets.maxTokens,
        task.tokensIncomplete,
      ),
    ),
    delegation,
    group(
      "details",
      "card",
      textElement("summary", "Task の詳細"),
      ...(task.verificationNote
        ? [
            sectionTitle("検証の失敗出力"),
            textElement("pre", task.verificationNote, "model-content"),
          ]
        : []),
      ...(task.category
        ? [modelBox("Planner の申告カテゴリー", [task.category])]
        : []),
      ...(task.description ? [modelBox("説明", [task.description])] : []),
      modelBox("受け入れ条件", task.acceptance),
      ...(task.environment
        ? [
            modelBox("依存の更新", [
              task.environment.update.packages === "all"
                ? "すべてのパッケージ"
                : task.environment.update.packages.join(", "),
              task.environment.update.allowMajor
                ? "メジャー更新を許可"
                : "宣言された範囲内で更新",
            ]),
          ]
        : []),
      ...(task.packageDiff
        ? [
            ...(task.packageDiff.added.length
              ? [
                  modelBox(
                    "追加された依存",
                    packageDiffLines(
                      task.packageDiff.added,
                      task.packageDiff.totals.added,
                    ),
                  ),
                ]
              : []),
            ...(task.packageDiff.removed.length
              ? [
                  modelBox(
                    "削除された依存",
                    packageDiffLines(
                      task.packageDiff.removed,
                      task.packageDiff.totals.removed,
                    ),
                  ),
                ]
              : []),
            ...(task.packageDiff.changed.length
              ? [
                  modelBox(
                    "変更された依存",
                    packageDiffLines(
                      task.packageDiff.changed.map(
                        ({ name, from, to }) =>
                          `${from.map((version) => `${name}@${version}`).join(", ")} → ${to.map((version) => `${name}@${version}`).join(", ")}`,
                      ),
                      task.packageDiff.totals.changed,
                    ),
                  ),
                ]
              : []),
          ]
        : []),
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
              code,
              next,
            }) =>
              group(
                "div",
                "stack",
                textElement(
                  "p",
                  `${actor === "Executor" && harness === "codex" ? "Executor（Codex）" : actor}${model ? ` / ${model}` : ""} / ${mode} / ${status} · ${formatTimestamp(startedAt)} → ${formatTimestamp(finishedAt)}${environment ? ` · 環境 ${environment.key}（${environment.failure ? failureReason(environment.failure) : environment.cacheHit ? "キャッシュ" : "ビルド"}）` : ""}`,
                  "meta",
                ),
                ...tokenBudget(tokens, task.budgets.maxTokens),
                ...(code ? [textElement("code", code)] : []),
                ...(next ? [textElement("p", next, "meta")] : []),
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

function confirmedAction(
  label: string,
  key: string,
  getPreview: () => Promise<{
    lines: string[];
    phrase?: string;
    submitLabel?: string;
    danger?: boolean;
    apply: (confirm: string) => Promise<unknown>;
  }>,
  refresh: (message?: string) => void,
  options?: {
    changeSource: EventTarget;
    available: () => boolean;
    onConfirming: (confirming: boolean) => void;
  },
) {
  const panel = group(
    "div",
    options ? "stack publish-setting-action" : "stack",
  );
  const status = textElement("p", "", "meta");
  status.setAttribute("role", "status");
  status.hidden = true;
  const start = action(label, key, () => {
    if (start.disabled || start.hidden) return;
    start.disabled = true;
    options?.onConfirming(true);
    panel.dataset.operatorConfirming = "true";
    status.hidden = true;
    void getPreview()
      .then(({ lines, phrase, submitLabel, danger, apply }) => {
        const input = phrase ? document.createElement("input") : undefined;
        if (input) {
          input.type = "text";
          input.setAttribute("aria-label", "確認の文言");
          input.autocomplete = "off";
        }
        const cancel = action("キャンセル", `${key}:cancel`, () => {
          reset();
          start.focus();
          refresh();
        });
        const submit = action(
          submitLabel ?? label,
          `${key}:confirm`,
          () => {
            if (submit.disabled) return;
            submit.disabled = cancel.disabled = true;
            void apply(input?.value ?? label)
              .then(() => {
                reset();
                refresh();
              })
              .catch(failed);
          },
          danger ? "btn danger" : "btn primary",
        );
        if (input) {
          submit.disabled = true;
          input.addEventListener("input", () => {
            submit.disabled = input.value !== phrase;
          });
        }
        confirmation.className = danger ? "confirm reject" : "confirm";
        confirmation.hidden = false;
        confirmation.append(
          ...lines.map((line) => textElement("p", line)),
          ...(phrase && input ? [textElement("code", phrase), input] : []),
          group("div", "actions", cancel, submit),
        );
        (input ?? cancel).focus();
      })
      .catch(failed);
  });
  const confirmation = group("div", "");
  confirmation.setAttribute("role", "group");
  confirmation.setAttribute("aria-label", "操作の確認");
  confirmation.hidden = true;
  panel.append(start, status, confirmation);
  if (options) {
    start.hidden = !options.available();
    options.changeSource.addEventListener("change", () => {
      start.hidden = !options.available();
    });
  }
  return panel;

  function reset() {
    confirmation.replaceChildren();
    confirmation.className = "";
    confirmation.hidden = true;
    start.disabled = false;
    options?.onConfirming(false);
    if (options) start.hidden = !options.available();
    delete panel.dataset.operatorConfirming;
  }

  function failed(error: unknown) {
    const code = error instanceof Error ? error.message : "";
    reset();
    status.hidden = false;
    if (
      key === "workplace:stop" &&
      ["write-failed", "read-failed", "closed"].includes(code)
    ) {
      status.textContent =
        "終了を記録できませんでした。Workplace のターミナルで Ctrl-C を押してください。";
      return;
    }
    status.textContent =
      code === "environment-build-running"
        ? "別の環境の準備が進行中です"
        : code === "workplace-stopping"
          ? "Workplace を終了しています。"
          : [
                "stale-base",
                "stale-confirmation",
                "confirmation-mismatch",
                "goal-base-stale",
                "goal-base-ineligible",
                "invalid-transition",
                "environment-current",
                "publish-stale-head",
              ].includes(code)
            ? "状況が変わりました。最新の内容を確認してください。"
            : code === "goal-head-unavailable"
              ? "Goal のブランチを確認できないため、取り消せません。"
              : code === "goal-busy"
                ? "Goal は作業中のため、取り消せません。"
                : "操作を完了できませんでした。";
    if (Object.hasOwn(publishFailures, code)) {
      const [label, next] = publishFailures[code as PublishFailure];
      status.textContent = `${label}。 ${next}`;
    }
    if (code === "goal-pr-open") status.textContent = goalPrOpenGuidance;
    refresh(status.textContent);
  }
}

function autoMergeBlock(goal: GoalDetail) {
  const { enabled } = goal.publish;
  if (!enabled) return "プロジェクトで PR 公開が無効です。";
  if (goal.status === "cancelled") return "Goal は取り消し済みです。";
  if (goal.prState === "closed") return "PR はクローズ済みです。";
  if (goal.prState === "merged") return "PR はマージ済みです。";
  return "";
}

/** The only external origin the panel links to (navigation, never loading). */
const GITHUB_ORIGIN = "https://github.com";

function goalPrLink(
  { prNumber, prUrl }: Pick<GoalPublishView, "prNumber" | "prUrl">,
  label = `PR #${prNumber}`,
) {
  if (!prNumber || !prUrl) return null;
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return null;
  }
  if (
    url.href !== prUrl ||
    url.origin !== GITHUB_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[a-z0-9-]+\/[a-z0-9_.-]+\/pull\/[1-9][0-9]*$/i.test(url.pathname) ||
    !url.pathname.endsWith(`/pull/${prNumber}`)
  )
    return null;
  const link = textElement("a", label);
  link.setAttribute("href", prUrl);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  return link;
}

type PullRequestItem = Extract<PanelInboxItem, { pullRequest: unknown }>;

const reviewLabels = {
  approved: "承認",
  "changes-requested": "変更リクエストあり",
  "review-required": "レビューが必要",
  none: "なし",
} as const;

const methodNotes = {
  squash: "1 つのコミットにまとめる",
  merge: "マージコミットを作る",
  rebase: "コミットを main に積み直す",
} as const;

const checkMarks = {
  pass: ["check", "通過", "added"],
  pending: ["hourglass", "チェック中", "pr-pending"],
  fail: ["cross", "失敗", "removed"],
} as const;

function prReview({ review = "none" }: GoalPublishView) {
  return visual(
    "eye",
    `GitHub のレビュー ${reviewLabels[review]}`,
    review === "approved" ? "added" : "meta",
    reviewLabels[review],
  );
}

function prDiff({ changedFiles, additions, deletions }: GoalPublishView) {
  return group(
    "span",
    "pr-diff",
    visual(
      "file",
      changedFiles === undefined
        ? "変更ファイル数は不明"
        : `変更 ${changedFiles} ファイル`,
      "",
      changedFiles === undefined ? "—" : `${changedFiles} ファイル`,
    ),
    diffCounts(
      additions ?? 0,
      deletions ?? 0,
      additions !== undefined && deletions !== undefined,
    ),
  );
}

function prCheckMark({ checks }: GoalPublishView) {
  const mark = checks && checkState[checks];
  return mark
    ? visual(
        mark[0],
        mark[1],
        checks === "passed"
          ? "added"
          : checks === "failed"
            ? "removed"
            : checks === "none"
              ? "meta"
              : "pr-pending",
      )
    : visual("circle", "チェックの結果なし", "meta");
}

function prCheckCount(publish: GoalPublishView, state: PublishCheckState) {
  return (
    publish.checkCounts?.[state] ??
    publish.checkRuns?.filter((check) => check.state === state).length
  );
}

function prCheckCounts(publish: GoalPublishView) {
  return group(
    "span",
    "pr-checks",
    ...(["pass", "pending", "fail"] as const).map((state) => {
      const [glyph, label, tone] = checkMarks[state];
      const count = prCheckCount(publish, state);
      return visual(
        glyph,
        `${label} ${count ?? "不明"}`,
        tone,
        String(count ?? "—"),
      );
    }),
  );
}

function prBlock(publish: GoalPublishView) {
  if (publish.mergeable === "conflict")
    return `${publish.base ?? "main"} とぶつかっています`;
  if (publish.mergeable === "blocked") return "マージがブロックされています";
  return "";
}

function prShortState(publish: GoalPublishView): string {
  if (publish.failure) return publishFailures[publish.failure][0];
  if (publish.prActionOutcome === "unknown") return "結果を確認中";
  if (publish.autoMergeEnabled)
    return `自動マージ待ち（${publish.autoMergeEnabled}）`;
  const block = prBlock(publish);
  if (publish.checks === "failed" || block)
    return [publish.checks === "failed" ? "チェック失敗" : "", block]
      .filter(Boolean)
      .join(" · ");
  if (publish.checks === "passed" && publish.mergeable === "clean")
    return "マージできます";
  if (publish.checks === "pending") return "チェック中";
  if (publish.checks === "none") return "チェックなし";
  if (publish.checks === "unknown") return checkState.unknown[1];
  return "マージ可否を確認中";
}

function prActionWarning(publish: GoalPublishView) {
  const failure = publish.prActionFailure;
  return failure ? [chip(publishFailures[failure.code][0], "warn")] : [];
}

function prWarnings(publish: GoalPublishView) {
  const failed =
    publish.checkRuns?.filter(({ state }) => state === "fail") ?? [];
  const block = prBlock(publish);
  const failedCount = prCheckCount(publish, "fail");
  return [
    ...(publish.checks === "failed"
      ? [
          visual(
            "cross",
            "チェック失敗",
            "chip danger",
            `チェック失敗${failedCount ? ` ${failedCount}` : ""}${failed.length ? `（${failed.map(({ name }) => name).join("、")}）` : ""}`,
          ),
        ]
      : []),
    ...(block ? [visual("warning", block, "chip warn", block)] : []),
    ...(publish.checks === "none" ? [chip("チェックなし", "neutral")] : []),
    ...prActionWarning(publish),
    ...(publish.failure
      ? [chip(publishFailures[publish.failure][0], "warn")]
      : []),
  ];
}

function prHeaderLink(publish: GoalPublishView) {
  const link = goalPrLink(publish);
  if (!link) return textElement("span", `PR #${publish.prNumber}`);
  link.className = "visual pr-external";
  link.append(icon("external"));
  return link;
}

function armedSection(
  items: PanelInboxItem[],
  surface: string,
  opened: Set<string>,
  render: (item: PanelInboxItem) => HTMLElement,
) {
  return rememberedDetails(
    `自動マージ待ち（${items.length} 件）`,
    `pr-armed:${surface}`,
    opened,
    group("div", "stack", ...items.map(render)),
  );
}

function prDecisionCard(
  channel: OperatorRequest,
  item: PullRequestItem,
  goalLink: GoalLink,
  flat: boolean,
  refresh: (message?: string) => void,
) {
  const { publish, actions } = item.pullRequest;
  const { goalId, goalRef } = item.subject;
  const waiting = item.kind === "pr-auto-merge";
  const controls = prControls(
    channel,
    goalId!,
    publish,
    actions,
    waiting ? "armed" : "card",
    refresh,
  );
  const title = modelTitle(waiting ? "span" : "h3", item.title, "title grow");
  if (waiting && publish.autoMergeEnabled)
    return group(
      "div",
      "pr-armed-row",
      group(
        "div",
        "rowline",
        ...goalLink(goalId, goalRef),
        title,
        publish.checks === "pending"
          ? visual(
              "hourglass",
              "チェック中",
              "pr-pending",
              `チェック中 ${prCheckCount(publish, "pending") ?? "—"}`,
            )
          : prCheckMark(publish),
        chip(publish.autoMergeEnabled, "pr-armed"),
        ...prActionWarning(publish),
        controls,
      ),
    );
  const warnings = prWarnings(publish);
  return group(
    flat ? "article" : "li",
    "card stack pr-decision",
    group(
      "div",
      "rowline",
      visual("merge", "PR のマージ", "chip info"),
      ...goalLink(goalId, goalRef),
      prHeaderLink(publish),
    ),
    title,
    group(
      "div",
      "rowline pr-facts",
      prCheckCounts(publish),
      prDiff(publish),
      prReview(publish),
    ),
    ...(warnings.length ? [group("div", "rowline", ...warnings)] : []),
    ...(publish.failure
      ? [textElement("p", publishFailures[publish.failure][1], "meta")]
      : []),
    controls,
  );
}

function prDetailFacts(publish: GoalPublishView) {
  const facts = group("dl", "pr-detail-facts");
  function entry(label: string, ...value: Node[]) {
    facts.append(textElement("dt", label), group("dd", "rowline", ...value));
  }
  entry(
    "チェック",
    ...(publish.checkRuns?.length
      ? publish.checkRuns.map(({ name, state }) => {
          const [glyph, label, tone] = checkMarks[state];
          return visual(glyph, `${name} · ${label}`, tone, name);
        })
      : [
          textElement(
            "span",
            checkState[publish.checks ?? "unknown"][1],
            "meta",
          ),
        ]),
  );
  entry("レビュー", prReview(publish));
  entry("変更", prDiff(publish));
  const block = prBlock(publish);
  entry(
    "ぶつかり",
    block
      ? visual("warning", block, "pr-pending", block)
      : publish.mergeable === "clean"
        ? visual("check", "なし", "added", "なし")
        : textElement("span", "不明", "meta"),
  );
  return facts;
}

function prControls(
  channel: OperatorRequest,
  id: string,
  publish: GoalPublishView,
  permissions: GoalPrActions,
  layout: "card" | "detail" | "armed",
  refresh: (message?: string) => void,
) {
  const controls = group("div", "pr-controls");
  const actions = group("div", "actions pr-actions");
  const strip = group("div", "confirm pr-confirm");
  strip.setAttribute("role", "group");
  strip.hidden = true;
  const status = textElement("p", "", "meta");
  status.setAttribute("role", "status");
  status.hidden = true;
  controls.append(actions, strip, status);
  const defaultMethod = publish.mergeMethod ?? "squash";
  let method = defaultMethod;
  const armed = publish.autoMergeEnabled;
  const blocked = Boolean(prBlock(publish)) || publish.checks === "failed";
  const ready =
    !blocked && publish.checks === "passed" && publish.mergeable === "clean";
  const pending = !blocked && publish.checks === "pending";
  const noChecks = publish.checks === "none";
  const unknownChecks =
    publish.checks === "unknown" || publish.checks === undefined;
  const canMerge = !publish.failure && !blocked && (ready || noChecks);
  const canAuto = Boolean(
    permissions.autoMerge &&
    publish.enabled &&
    !publish.failure &&
    !blocked &&
    (ready || pending || noChecks || unknownChecks),
  );
  const number = publish.prNumber;
  const procedures = {
    merge: ["マージの確認", "マージを確定"],
    auto: ["自動マージの確認", "自動マージを確定"],
    close: ["PR を閉じる確認", "閉じるを確定"],
    off: ["自動マージ解除の確認", "解除を確定"],
  } as const;

  function ask(kind: keyof typeof procedures, trigger: HTMLElement) {
    const selected = method;
    const confirm =
      kind === "merge"
        ? permissions.merge?.[selected]
        : kind === "close"
          ? permissions.close
          : permissions.autoMerge?.[kind === "off" ? "off" : selected];
    if (!confirm) return;
    const messages = {
      merge: `PR #${number} を ${selected} でマージします。${noChecks ? " チェックがありません。" : " チェックは通過しています。"}`,
      auto: `${noChecks ? "マージ可能になったら" : "チェックが通ったら"}、PR #${number} を ${selected} で自動マージします。`,
      close: `PR #${number} を閉じます。Goal は「止まっている」に移ります。`,
      off: `PR #${number} の自動マージを解除します。`,
    };
    const reset = () => {
      actions.hidden = false;
      strip.hidden = true;
      strip.replaceChildren();
      delete controls.dataset.operatorConfirming;
    };
    const [label, submitText] = procedures[kind];
    const key = `pr-${kind}:${id}`;
    const back = action("戻す", `${key}:cancel`, () => {
      reset();
      trigger.focus();
      refresh();
    });
    const submit = action(
      submitText,
      `${key}:confirm`,
      () => {
        if (submit.disabled) return;
        submit.disabled = back.disabled = true;
        const request =
          kind === "merge"
            ? channel.request("goal.merge", {
                id,
                method: selected,
                confirm,
                ...(noChecks && { noChecks: true as const }),
              })
            : kind === "close"
              ? channel.request("goal.closePr", { id, confirm })
              : channel.request("goal.setAutoMerge", {
                  id,
                  method: kind === "off" ? "off" : selected,
                  confirm,
                });
        void request
          .then((result) => {
            reset();
            const message =
              kind === "off"
                ? "自動マージの解除を受け付けました。"
                : kind === "auto"
                  ? "自動マージの設定を受け付けました。"
                  : "state" in result && result.state === "merged"
                    ? `PR #${number} をマージしました。${"goalCompleted" in result && result.goalCompleted ? "Goal を完了にしました。" : ""}`
                    : "state" in result && result.state === "closed"
                      ? `PR #${number} を閉じました。送り直すか、Goal を取り消せます。`
                      : "prActionOutcome" in result &&
                          result.prActionOutcome === "unknown"
                        ? "結果を確認中"
                        : `PR #${number} の状態を確認しています。`;
            status.textContent = message;
            status.hidden = false;
            refresh(message);
          })
          .catch((error: unknown) => {
            reset();
            const code = error instanceof Error ? error.message : "";
            status.textContent = Object.hasOwn(publishFailures, code)
              ? publishFailures[code as PublishFailure].join("。 ")
              : "操作を完了できませんでした。最新の PR の状態を確認してください。";
            status.hidden = false;
            trigger.focus();
            refresh(status.textContent);
          });
      },
      kind === "close"
        ? "btn danger"
        : kind === "merge" && noChecks
          ? "btn secondary"
          : "btn primary",
    );
    strip.className =
      kind === "close" ? "confirm reject pr-confirm" : "confirm pr-confirm";
    strip.setAttribute("aria-label", label);
    strip.replaceChildren(
      textElement("span", messages[kind], "grow"),
      back,
      submit,
    );
    actions.hidden = status.hidden = true;
    strip.hidden = false;
    controls.dataset.operatorConfirming = "true";
    back.focus();
  }

  function button(
    label: string,
    kind: keyof typeof procedures,
    classes: string,
  ) {
    const node = action(
      label,
      `pr-${kind}:${id}`,
      () => ask(kind, node),
      classes,
    );
    return node;
  }

  if (armed) {
    if (layout === "detail" && !publish.failure && !publish.prActionOutcome) {
      actions.className += " pr-armed";
      actions.append(
        textElement(
          "span",
          `${noChecks ? "マージ可能になったら" : "チェックが通ったら"}、GitHub が ${armed} でマージします。`,
          "grow",
        ),
      );
    }
    if (permissions.autoMerge?.off)
      actions.append(
        button(
          layout === "armed" ? "解除" : "自動マージを解除",
          "off",
          "btn secondary",
        ),
      );
    return controls;
  }

  const merge =
    canMerge && permissions.merge
      ? button("", "merge", noChecks ? "btn secondary" : "btn primary")
      : null;
  const auto = canAuto
    ? button(
        layout === "detail" ? "自動マージ" : "",
        "auto",
        layout === "detail" && ready ? "btn secondary" : "btn primary",
      )
    : null;
  const mainAction = noChecks ? (auto ?? merge) : (merge ?? auto);
  const close = permissions.close
    ? button("PR を閉じる", "close", "btn danger")
    : null;
  const updateMethod = () => {
    if (merge) merge.textContent = `マージ（${method}）`;
    if (auto && layout === "card") auto.textContent = `自動マージ（${method}）`;
  };
  updateMethod();

  if (layout === "detail" && mainAction) {
    const select = document.createElement("select");
    select.className = "publish-method";
    select.setAttribute("aria-label", "マージの方式");
    for (const value of mergeMethods) {
      const option = textElement(
        "option",
        value === defaultMethod ? `${value}（既定）` : value,
      );
      option.value = value;
      select.append(option);
    }
    select.value = method;
    select.addEventListener("change", () => {
      method =
        mergeMethods.find((value) => value === select.value) ?? defaultMethod;
      updateMethod();
    });
    actions.append(
      group(
        "label",
        "publish-setting grow",
        textElement("span", "方式"),
        select,
      ),
    );
  }
  if (pending)
    actions.append(
      textElement(
        "span",
        "チェック中のため、いまはマージできません",
        "meta grow",
      ),
    );
  if (!mainAction) {
    const link = goalPrLink(publish, "PR を見る");
    if (link) actions.append(link);
  }
  if (close && (layout === "detail" || !mainAction)) actions.append(close);
  if (layout === "detail") {
    if (auto) actions.append(auto);
    if (merge) actions.append(merge);
  } else if (mainAction) {
    if (noChecks && merge && mainAction !== merge) actions.append(merge);
    const menu = group("div", "pr-method-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "マージの方式");
    menu.hidden = true;
    const toggle = action(
      "",
      `pr-method:${id}`,
      () => setOpen(Boolean(menu.hidden)),
      noChecks && mainAction === merge ? "btn secondary" : "btn primary",
    );
    toggle.append(icon("chevron"));
    toggle.setAttribute("aria-label", "マージの方式を選ぶ");
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    const items = mergeMethods.map((value) => {
      const entry = action(
        "",
        `pr-method:${id}:${value}`,
        () => {
          method = value;
          updateMethod();
          setOpen(false);
          toggle.focus();
        },
        "pr-method-option",
      );
      entry.setAttribute("role", "menuitemradio");
      entry.tabIndex = -1;
      entry.append(
        textElement("strong", value),
        textElement(
          "span",
          value === "rebase" && publish.base && publish.base !== "main"
            ? `コミットを ${publish.base} に積み直す`
            : methodNotes[value],
          "meta",
        ),
      );
      return entry;
    });
    function setOpen(open: boolean) {
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (!open) return;
      for (const [index, item] of items.entries())
        item.setAttribute(
          "aria-checked",
          String(mergeMethods[index] === method),
        );
      items[mergeMethods.indexOf(method)]?.focus();
    }
    const split = group("div", "pr-split", mainAction, toggle, menu);
    split.addEventListener("focusout", ({ relatedTarget }) => {
      if (relatedTarget instanceof Node && !split.contains(relatedTarget))
        setOpen(false);
    });
    split.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        event.preventDefault();
        setOpen(false);
        toggle.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (menu.hidden) setOpen(true);
        else {
          const index = items.findIndex(
            (item) => item === document.activeElement,
          );
          const next =
            (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) %
            items.length;
          items[next]?.focus();
        }
      }
    });
    menu.append(...items);
    actions.append(split);
  }
  return controls;
}

export function goalPublishPanel(
  channel: OperatorRequest,
  goal: GoalDetail,
  message: string,
  refresh: (message?: string) => void,
) {
  const publish = goal.publish;
  if (!publish.enabled && publish.state === "disabled") return [];

  const isPr = publish.prNumber !== undefined;
  const stateLabel =
    goal.prState === "open"
      ? publish.failure || publish.prActionOutcome
        ? prShortState(publish)
        : publish.autoMergeEnabled
          ? "自動マージ待ち"
          : publish.checks && !prBlock(publish)
            ? checkState[publish.checks][1]
            : prShortState(publish)
      : publish.state === "pending" && goal.turn.reason.kind === "publishing"
        ? "公開待ち"
        : publishStateLabels[publish.state];
  const state = isPr
    ? group(
        "div",
        "rowline pr-detail-header",
        visual("pullRequest", "PR"),
        sectionTitle("PR"),
        prHeaderLink(publish),
        chip(
          stateLabel,
          publish.failure
            ? "warn"
            : publish.autoMergeEnabled && !publish.prActionOutcome
              ? "pr-armed"
              : publish.checks === "none" || publish.prActionOutcome
                ? "neutral"
                : publish.checks === "passed"
                  ? "done"
                  : "info",
        ),
        ...(publish.checks === "none" && stateLabel !== "チェックなし"
          ? [chip("チェックなし", "neutral")]
          : []),
        ...prActionWarning(publish),
        textElement("span", publish.branch, "grow meta"),
        textElement(
          "span",
          `最終確認 ${formatTimestamp(publish.lastCheckedAt ?? null)}`,
          "meta",
        ),
      )
    : group(
        "div",
        "turn-line",
        visual(publishStateIcons[publish.state], stateLabel),
        textElement("span", stateLabel),
      );
  const failure = publish.failure && publishFailures[publish.failure];
  const feedback = textElement("p", message, "meta decision-event");
  feedback.setAttribute("role", "status");
  feedback.hidden = !message;

  const blocked = autoMergeBlock(goal);
  const method = document.createElement("select");
  method.className = "publish-method";
  method.setAttribute("aria-label", "自動マージの方式");
  for (const value of autoMergeMethods) {
    const option = textElement("option", autoMergeLabels[value]);
    option.value = value;
    method.append(option);
  }
  method.value = publish.autoMerge;
  method.disabled = Boolean(blocked);
  const key = goal.id;
  const methodChanged = () => method.value !== publish.autoMerge;
  const setting = confirmedAction(
    "変更を確認",
    `auto-merge:${key}`,
    async () => {
      const selected = method.value as (typeof autoMergeMethods)[number];
      const current = await channel.request("goal.get", { id: key });
      if (autoMergeBlock(current) || current.ref !== goal.ref)
        throw new Error("stale-confirmation");
      const confirm = current.autoMergeConfirmations[selected];
      return {
        lines: [`自動マージを「${autoMergeLabels[selected]}」に変更します。`],
        submitLabel: "変更を確定",
        apply: () =>
          channel.request("goal.setAutoMerge", {
            id: key,
            method: selected,
            confirm,
          }),
      };
    },
    refresh,
    {
      changeSource: method,
      available: methodChanged,
      onConfirming: (confirming) => {
        method.disabled = confirming;
      },
    },
  );
  const source =
    publish.autoMergeSource === "goal"
      ? "この Goal の設定"
      : "プロジェクトの既定値";
  return [
    group(
      "section",
      "card stack goal-publish",
      ...(!isPr ? [sectionTitle("PR 公開")] : []),
      state,
      ...(isPr
        ? [prDetailFacts(publish)]
        : [facts([["ブランチ", publish.branch]])]),
      ...(goal.prState === "open" && goal.status !== "cancelled"
        ? [
            prControls(
              channel,
              key,
              publish,
              goal.prActions ?? {},
              "detail",
              refresh,
            ),
          ]
        : []),
      ...(failure
        ? [
            group(
              "div",
              "stack",
              textElement("p", failure[0]),
              textElement("p", failure[1], "meta"),
            ),
          ]
        : []),
      ...(publish.autoMergeUnavailable
        ? [
            textElement(
              "p",
              "自動マージは使えません（GitHub の設定を確認してください）",
              "meta",
            ),
          ]
        : []),
      ...(goal.status === "active" && goal.prState === "open"
        ? [textElement("p", goalPrOpenGuidance, "meta")]
        : []),
      ...(goal.mergeCompletion
        ? [
            textElement(
              "p",
              (publish.state === "merged-stale"
                ? "マージされた PR のコミットと Goal の先端または公開したコミットが一致しません。"
                : "PR はマージ済みですが、Goal の完了条件を満たしていません。") +
                "GitHub でマージ内容を確認し、作業が完了していれば手で完了にできます。",
              "meta",
            ),
            confirmedAction(
              "手で完了にする",
              `complete-after-merge:${key}`,
              async () => {
                const current = await channel.request("goal.get", { id: key });
                const preview = current.mergeCompletion;
                if (
                  !preview ||
                  preview.confirm !== goal.mergeCompletion?.confirm
                )
                  throw new Error("stale-confirmation");
                const { prNumber, mergedHead, confirm } = preview;
                return {
                  lines: [
                    `PR #${prNumber} のマージ済みコミット ${mergedHead.slice(0, 12)} を確認して、${current.ref} を完了にします。`,
                  ],
                  submitLabel: "完了を確定",
                  apply: () =>
                    channel.request("goal.completeAfterMerge", {
                      id: key,
                      confirm,
                    }),
                };
              },
              refresh,
            ),
          ]
        : []),
      ...(goal.publishPreview
        ? [
            confirmedAction(
              publish.state === "failed" || publish.state === "closed"
                ? "もう一度送る"
                : "PR を作る",
              `publish:${key}`,
              async () => {
                const current = await channel.request("goal.get", { id: key });
                if (!current.publishPreview || current.ref !== goal.ref)
                  throw new Error("stale-confirmation");
                const { expectedHead } = current.publishPreview;
                const { prNumber, branch } = current.publish;
                const expectedPr: GoalPublishConfirmationPr =
                  prNumber && current.prState
                    ? { number: prNumber, state: current.prState }
                    : null;
                return {
                  lines: [
                    `${branch} に ${expectedHead.slice(0, 12)} を送り、PR を公開します。`,
                    ...(current.prState === "closed"
                      ? [`PR #${prNumber} はクローズ済みです。`]
                      : []),
                  ],
                  phrase: goalPublishConfirmation(current.ref, expectedHead),
                  apply: (confirm: string) =>
                    channel.request("goal.publish", {
                      id: key,
                      expectedHead,
                      confirm,
                      expectedPr,
                    }),
                };
              },
              refresh,
            ),
          ]
        : []),
      ...(goal.prState === "closed" && goal.status === "active"
        ? [
            confirmedAction(
              "Goal を取り消す",
              `publish-discard:${key}`,
              async () => {
                const current = await channel.request("goal.get", { id: key });
                const expectedClosedPrNumber = current.publish.prNumber;
                if (
                  current.ref !== goal.ref ||
                  current.prState !== "closed" ||
                  current.status !== "active" ||
                  !expectedClosedPrNumber ||
                  expectedClosedPrNumber !== publish.prNumber
                )
                  throw new Error("stale-confirmation");
                if (!current.headAvailable)
                  throw new Error("goal-head-unavailable");
                return {
                  lines: [
                    `${current.ref} を取り消します。取り消すと戻せません。`,
                  ],
                  submitLabel: "取り消しを確定",
                  danger: true,
                  apply: () =>
                    channel.request("goal.discard", {
                      id: key,
                      confirm: current.ref,
                      expectedHead: current.head,
                      expectedClosedPrNumber,
                    }),
                };
              },
              refresh,
            ),
          ]
        : []),
      ...(!isPr
        ? [
            group(
              "div",
              "stack",
              group(
                "label",
                "publish-setting",
                textElement("span", "自動マージ"),
                method,
              ),
              textElement(
                "p",
                blocked ? `${source}。 ${blocked}` : source,
                "meta",
              ),
              ...(!blocked ? [setting] : []),
            ),
          ]
        : []),
      feedback,
    ),
  ];
}

function projectPublishSettings(
  publish: Methods["status"]["result"]["publish"],
) {
  return [
    sectionTitle("PR 公開"),
    facts([
      ["公開", publish.enabled ? "有効" : "無効"],
      ["リモート", publish.remote],
      ["ベース", publish.base],
      ["既定のマージ方式", publish.mergeMethod],
      ["既定の自動マージ", autoMergeLabels[publish.autoMerge]],
    ]),
    textElement(
      "p",
      "変更するにはプロジェクトの local.json を編集してください。",
      "meta",
    ),
  ];
}

export function goalBaseUpdate(
  channel: OperatorRequest,
  goal: GoalDetail,
  refresh: () => void,
) {
  if (!goal.baseUpdatePreview) return [];
  return [
    group(
      "section",
      "card",
      confirmedAction(
        "ベースを更新する",
        `base:${goal.id}`,
        async () => {
          const updated = await channel.request("goal.get", { id: goal.id });
          const preview = updated.baseUpdatePreview;
          if (!preview) throw new Error("stale-base");
          const { from, to } = preview;
          return {
            lines: [`ベースコミット ${from.slice(0, 12)} → ${to.slice(0, 12)}`],
            phrase: `update-goal-base ${goal.ref} ${to.slice(0, 12)}`,
            apply: (confirm) =>
              channel.request("goal.updateBase", {
                id: goal.id,
                confirm,
                from,
                to,
              }),
          };
        },
        refresh,
      ),
    ),
  ];
}

export function environmentControls(
  channel: OperatorRequest,
  { status, build }: Methods["environment.status"]["result"],
  refresh: () => void,
) {
  if (!status && !build) return [];
  const label = { current: "最新", stale: "古い", missing: "未作成" };
  const buildResult =
    build?.state === "running"
      ? "環境を準備中"
      : build?.state === "succeeded"
        ? `${build.key.slice(0, 12)} · ${build.size} バイト · ${build.cacheHit ? "キャッシュ" : "ビルド"}${build.warning ? ` · ${build.warning}` : ""}`
        : build?.state === "failed"
          ? `${build.key.slice(0, 12)} · ${build.failure}${build.gatewayStopped ? ` · ゲートウェイ停止 ${build.gatewayStopped}` : ""}`
          : "";
  return [
    sectionTitle("環境"),
    ...(status
      ? [
          textElement(
            "p",
            `${label[status.state]} · ${status.key.slice(0, 12)} · ロック ${status.hasLock ? "あり" : "なし"} · ${status.size} バイト`,
            "meta",
          ),
        ]
      : []),
    ...(buildResult ? [textElement("p", buildResult, "meta")] : []),
    ...(status && status.state !== "current" && build?.state !== "running"
      ? [
          confirmedAction(
            "環境を作る",
            "environment:build",
            async () => {
              const preview = await channel.request(
                "environment.buildPreview",
                {},
              );
              return {
                lines: [
                  preview.destinations.length
                    ? `Provisioner VM がネットワークに接続します。接続先は ${preview.destinations.join("、")} です。`
                    : "Provisioner VM に許可されたネットワーク接続先はありません。",
                  ...(preview.responsibilityNotice
                    ? [preview.responsibilityNotice]
                    : []),
                ],
                apply: () =>
                  channel.request("environment.build", {
                    confirmation: preview.confirmation,
                  }),
              };
            },
            refresh,
          ),
        ]
      : []),
  ];
}

export function workplaceStopControls(
  channel: OperatorRequest,
  refresh: () => void,
) {
  return confirmedAction(
    "Workplace を終える",
    "workplace:stop",
    async () => {
      const { runningTasks, revision } = await channel.request(
        "workplace.stopPreview",
        {},
      );
      return {
        lines: [
          "Workplace のセッションを終了します。",
          ...(runningTasks
            ? [
                `実行中の Task が ${runningTasks} 件あります。終了処理に時間がかかる場合があります。`,
              ]
            : []),
        ],
        apply: (confirm) =>
          channel.request("workplace.stop", { confirm, revision }),
      };
    },
    refresh,
  );
}

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

                return tokenBudget(
                  tokens,
                  max,
                  false,
                  `実行 ${executionId?.slice(0, 8)} · `,
                );
              });
              usage.append(...reports);
              if (reports.length === 0) {
                usage.append(
                  sectionTitle("Task 全体のトークン使用量"),
                  ...tokenBudget(
                    task.tokensUsed,
                    task.budgets.maxTokens,
                    task.tokensIncomplete,
                  ),
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
type View = { tab: Tab; goalId?: string; taskId?: string; history?: true };
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
  const publishMessages = new Map<string, string>();
  let prMessage = "";
  let environment: Methods["environment.status"]["result"] | undefined;
  const nowButton = element("now-toggle");
  const nowPopover = element("now-popover");
  const now = disclosure(nowButton, nowPopover, () =>
    inbox?.cancelConfirmation(nowPopover),
  );
  const inlineGoals = new Set<string>();
  const openedGoalGroups = new Set<string>();
  const selectedGoalTabs = new Map<string, GoalTab>();
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
            renderNow(workplaceDecisions(items));
            inbox?.render(
              workplaceDecisions(items),
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
    const { human, ai, armed } = splitDecisions(pending);
    const preparing = environment?.build?.state === "running";
    const working = activity.running.length;
    const workLabel = `AI 作業中 ${working} 件`;
    const queueLabel = `順番待ち ${activity.queuedCount} 件`;
    const turnLabel = `あなたの番 ${human.length} 件`;
    const status = preparing
      ? "。環境を準備中"
      : activity.running.some(
            ({ resolvingDependencies }) => resolvingDependencies,
          )
        ? "。依存を解決中"
        : activity.running.some(
              ({ preparingEnvironment }) => preparingEnvironment,
            )
          ? "。環境を準備中"
          : "";
    const label = `いま。 ${workLabel}、${queueLabel}、${turnLabel}${status}`;
    nowButton.replaceChildren(
      visual("robot", workLabel + status, "now-working", String(working)),
      visual("hourglass", queueLabel, "", String(activity.queuedCount)),
      visual("person", turnLabel, "", String(human.length)),
    );
    nowButton.setAttribute("aria-label", label);
    nowButton.title = label;
    nowButton.dataset.running = String(working > 0);
    if (nowPopover.hidden) return;
    const snapshot = JSON.stringify([
      activity,
      decisionSnapshot(pending),
      trackingData(),
      inbox?.revision,
      pending.map(({ subject }) => goalTitle(subject.goalId)),
      problems,
      environment,
    ]);
    if (
      snapshot === previousNow ||
      nowPopover.querySelector("[data-operator-confirming]")
    )
      return;
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
          ...(human.length && inbox
            ? [
                group(
                  "section",
                  "stack",
                  sectionTitle(`あなたの番（${human.length} 件）`),
                  ...human.map(nowDecision),
                ),
              ]
            : []),
          ...(ai.length && inbox
            ? [aiSection(ai, "popover", inbox.openedSections, nowDecision)]
            : []),
          ...(armed.length && inbox
            ? [
                armedSection(
                  armed,
                  "popover",
                  inbox.openedSections,
                  nowDecision,
                ),
              ]
            : []),
          ...(problems.length
            ? [
                group(
                  "section",
                  "stack",
                  sectionTitle(`問題（${problems.length} 件）`),
                  ...problems.map(nowProblem),
                ),
              ]
            : []),
          ...(channel && environment
            ? environmentControls(
                channel,
                environment,
                () => void refresh(false),
              )
            : []),
          ...(channel
            ? [workplaceStopControls(channel, () => void refresh(false))]
            : []),
        );
      },
      nowPopover,
    );
    function nowProblem(rows: Problem[]) {
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
    }
    function nowDecision(item: PanelInboxItem) {
      return inbox!.card(item, goalLink, {
        flat: true,
        surface: "popover",
        goalTitle: goalTitle(item.subject.goalId) ?? "",
      });
    }
  }

  nowButton.addEventListener("click", () => {
    now.toggle();
    previousNow = "";
    renderNow(workplaceDecisions(items));
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
      (message) => {
        if (message) notice.textContent = prMessage = message;
        void refresh();
      },
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
      "link visual",
    );
    link.append(icon("flag"), ...refNodes(ref));

    link.setAttribute(
      "aria-label",
      ["Goal", ref, title].filter(Boolean).join(" "),
    );
    link.title = title ?? `Goal ${ref}`;
    return [group("div", "meta", link)];
  }

  function updateVisibility() {
    for (const tab of tabs) {
      const selected = tab === view.tab;
      const button = element(`tab-${tab}`);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      element(tab).hidden = Boolean(settings) || !selected;
    }
    element("decision-queue").hidden = Boolean(view.history);
    element("decision-history-view").hidden = !view.history;
    element("decisions").dataset.history = String(Boolean(view.history));
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
    if (next.history) inbox?.cancelConfirmation(element("decisions"));
    const wasHistory = view.history;
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
      element("inbox").scrollTop = 0;
      if (view.history) element("decision-history-back").focus();
      else if (wasHistory && !decisionId)
        element("decision-history-open").focus();
      else if (!focusDecision()) element("tab-decisions").focus();
    }
    void refresh();
  }

  element("decision-history-open").addEventListener("click", () =>
    navigate({ tab: "decisions", history: true }),
  );
  element("decision-history-back").addEventListener("click", () =>
    navigate({ tab: "decisions" }),
  );

  function focusDecision() {
    if (!pendingFocus) return false;
    const target = Array.from(
      element("inbox-items").querySelectorAll<HTMLButtonElement>(
        "[data-focus-key]",
      ),
    ).find((node) => node.dataset.focusKey === `detail:${pendingFocus}`);
    if (!target) return false;
    pendingFocus = undefined;
    const section = target.closest("details.fold") as HTMLDetailsElement | null;
    if (section) {
      section.open = true;
      inbox?.openedSections.add("ai-decisions:decisions");
    }
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
      panel.querySelector("[data-policy-editing], [data-operator-confirming]")
    )
      return;
    previousView = snapshot;
    restoreFocus(
      panel,
      () => {
        const open =
          task && panel.querySelector<HTMLDetailsElement>("details[open]");
        unwatch(panel);
        panel.replaceChildren(...breadcrumb(view, task, goal), ...contents());
        const disclosure = panel.querySelector("details");
        if (disclosure && open) disclosure.open = true;
      },
      element(`tab-${view.tab}`),
    );
  }

  function savedPolicy() {
    inbox?.invalidate();
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
          environmentResult,
          projectStatus,
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
          channel.request("environment.status", {}),
          section === "connection" ? channel.request("status", {}) : undefined,
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
        if (environmentResult.status === "fulfilled")
          environment = environmentResult.value;
        const pending = workplaceDecisions(items);
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
        const { human, ai } = splitDecisions(pending);
        badge("decisions", human.length);
        element("tab-decisions").setAttribute(
          "aria-label",
          `判断待ち。あなたが答える ${human.length} 件、AI が答える予定 ${ai.length} 件`,
        );
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
        else if (!section || section === "delegation")
          notice.textContent = prMessage;

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
        if (section === "connection") {
          const settings =
            projectStatus.status === "fulfilled" &&
            projectStatus.value?.publish;
          element("publish-settings").replaceChildren(
            ...(settings
              ? projectPublishSettings(settings)
              : [empty("PR 公開の設定を取得できませんでした。")]),
          );
          continue;
        }

        if (decisionTab) {
          if (itemResult.status === "fulfilled") {
            // A decision answered meanwhile never gets a card: drop the request.
            if (!focusDecision()) pendingFocus = undefined;
          }
          const rows =
            history.status === "fulfilled" ? history.value : undefined;
          element("decision-history-open").textContent = rows
            ? `AI が判断したもの（${rows.length} 件）›`
            : "AI が判断したもの ›";
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
          const publishMessage = publishMessages.get(detail.id) ?? "";
          const tasks = new Set(detail.tasks.map(({ id }) => id));
          const related = (item: PanelInboxItem) =>
            item.subject.goalId === detail.id ||
            Boolean(item.subject.taskId && tasks.has(item.subject.taskId));
          const decisions = pending.filter(
            (item) =>
              related(item) &&
              item.kind !== "pr-merge" &&
              item.kind !== "pr-auto-merge",
          );
          const goalDecisions = splitDecisions(decisions);
          const decisionCard = (item: PanelInboxItem) =>
            inbox!.card(item, goalLink, {
              goalRef: detail.ref,
              surface: "goal",
            });
          const recent = items.filter(
            (item) =>
              (item.weight === "info" || item.kind === "task-failed") &&
              related(item),
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
              publishMessage,
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
                inbox
                  ? [
                      ...(goalDecisions.human.length
                        ? [
                            group(
                              "section",
                              "stack",
                              sectionTitle("あなたの番"),
                              ...goalDecisions.human.map(decisionCard),
                            ),
                          ]
                        : []),
                      ...(goalDecisions.ai.length
                        ? [
                            aiSection(
                              goalDecisions.ai,
                              `goal:${detail.id}`,
                              inbox.openedSections,
                              decisionCard,
                            ),
                          ]
                        : []),
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
                [
                  ...goalPublishPanel(
                    channel,
                    detail,
                    publishMessage,
                    (message = "") => {
                      publishMessages.set(detail.id, message);
                      previousView = "";
                      void refresh();
                    },
                  ),
                  goalExport(channel, detail, exportMessage, (message) => {
                    exportMessages.set(detail.id, message);
                    previousView = "";
                    void refresh(false);
                  }),
                  ...goalBaseUpdate(channel, detail, () => void refresh(false)),
                ],
                selectedGoalTabs.get(detail.id) ?? "overview",
                (tab) => selectedGoalTabs.set(detail.id, tab),
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
              human.filter(
                (item) =>
                  (item.kind === "pr-merge" ||
                    ("answer" in item &&
                      (item.answer.approve || item.answer.reject))) &&
                  (item.subject.goalId === goal.id ||
                    item.subject.goalRef === goal.ref),
              ),
            ]),
          );
          renderWork([goals, decisionSnapshot(pending), inbox?.revision], () =>
            goals.length
              ? turnGroups.flatMap(({ label, owners }) => {
                  const groupGoals = goals.filter(({ turn }) =>
                    owners.includes(turn.owner),
                  );
                  if (!groupGoals.length) return [];
                  const rows = groupGoals.map((entry) => {
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
                                goalTitle: goalTitle(item.subject.goalId) ?? "",
                              }),
                            )
                          : [],
                      decisions.length > 0,
                      inlineGoals,
                    );
                  });
                  return owners.includes("done")
                    ? [
                        rememberedDetails(
                          `${label}（${rows.length} 件）`,
                          "done-goals",
                          openedGoalGroups,
                          group("div", "stack", ...rows),
                        ),
                      ]
                    : [sectionTitle(label), ...rows];
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
    sessionEnded() {
      now.close(false);
      nowButton.setAttribute("disabled", "");
      nowButton.removeAttribute("aria-label");
      nowButton.removeAttribute("title");
      nowButton.textContent = "Workplace は終了しました";
      notice.textContent = "Workplace は終了しました。";
    },
  };
}
