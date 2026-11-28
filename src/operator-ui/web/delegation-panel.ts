import type {
  DelegationRule,
  RuleConditions,
  RuleGate,
} from "../../local-orchestrator/delegation.ts";
import type {
  PolicyGate,
  Policy,
  TaskCategory,
} from "../../local-orchestrator/model.ts";
import type { WorkplaceChannel } from "./channel.ts";
import { action, group, sectionTitle, textElement } from "./dom.ts";
import {
  gateLabels,
  invariantLabels,
  moveRule,
  orderedRules,
  ruleChangeCanWiden,
  settingLabel,
  type GoalDetail,
  type PolicySettings,
  type TaskDetail,
} from "./protocol.ts";

const ruleGates = ["task-registration", "integration"] as const;
const categories = [
  "bugfix",
  "docs",
  "test",
  "refactor",
  "feature",
  "chore",
] as const satisfies readonly TaskCategory[];
const defaultChoices = [
  ["human", "人"],
  ["agent", "AI"],
] as const;
const goalChoices = [["inherit", "既定に従う"], ...defaultChoices] as const;
const taskChoices = [
  ["rule", "ルールに従う"],
  ["human", "人"],
  ["agent", "AI"],
] as const;

function policyControls(title: string, saved: () => void) {
  const section = document.createElement("section");
  section.className = "stack";
  section.append(sectionTitle(title));
  const controls = document.createElement("fieldset");
  controls.className = "policy-controls";
  const editor = document.createElement("div");
  const confirmation = document.createElement("div");
  confirmation.className = "policy-confirmation confirm";
  const status = textElement("p", "", "policy-status");
  status.setAttribute("role", "status");
  section.append(group("div", "card", controls, editor, confirmation, status));

  function close() {
    editor.replaceChildren();
    confirmation.replaceChildren();
    status.textContent = "";
    delete section.dataset.policyEditing;
    controls.disabled = false;
  }

  function edit(form: HTMLElement) {
    section.dataset.policyEditing = "";
    controls.disabled = true;
    status.textContent = "";
    editor.replaceChildren(form);
    form.querySelector<HTMLInputElement>("input")?.focus();
  }

  function change(widens: boolean, write: () => Promise<unknown>) {
    if (confirmation.childElementCount) return;
    section.dataset.policyEditing = "";
    controls.disabled = true;
    status.textContent = "";
    const focused = document.activeElement;
    const form = editor.querySelector("fieldset");

    async function save() {
      if (form) form.disabled = true;
      confirmation.replaceChildren();
      status.textContent = "保存中…";
      try {
        await write();
        close();
        if (section.isConnected) saved();
      } catch (error) {
        if (error instanceof Error && error.message === "stale-policy") {
          status.textContent =
            "別の操作で設定が変わりました。最新の設定を確認してください。";
          const reload = action("最新の設定を表示", "policy-reload", () => {
            close();
            saved();
          });
          confirmation.append(reload);
          reload.focus();
          return;
        }
        status.textContent =
          error instanceof Error && error.message === "invalid-params"
            ? "設定を保存できません。ルール名、条件、数値、パスの形式と上限を確認してください。"
            : "設定を保存できませんでした。";
        if (form) form.disabled = false;
        else {
          controls.disabled = false;
          delete section.dataset.policyEditing;
        }
      }
    }

    if (!widens) {
      void save();
      return;
    }
    if (form) form.disabled = true;
    const confirm = action(
      "変更を確定",
      "policy-confirm",
      () => void save(),
      "btn primary",
    );
    confirmation.append(
      textElement(
        "p",
        "この変更で AI が判断できる範囲が広がる場合があります。",
        "q",
      ),
      action("やめる", "policy-cancel", () => {
        confirmation.replaceChildren();
        if (form) form.disabled = false;
        else close();
        if (focused instanceof HTMLElement) focused.focus();
      }),
      confirm,
    );
    confirm.focus();
  }
  return { section, controls, edit, close, change };
}

function segmented<T extends string>(
  label: string,
  key: string,
  value: T,
  choices: readonly (readonly [T, string])[],
  select: (value: T) => void,
  canSetCurrent = false,
) {
  const row = document.createElement("div");
  row.className = "setting";
  const segments = textElement("div", "", "seg");
  segments.setAttribute("role", "group");
  segments.setAttribute("aria-label", label);
  row.append(textElement("span", label, "label"), segments);
  for (const [option, text] of choices) {
    const button = action(text, `${key}:${option}`, () => {
      if (option !== value || canSetCurrent) select(option);
    });
    button.setAttribute("aria-pressed", String(option === value));
    segments.append(button);
  }
  return row;
}

export function goalDelegation(
  goal: GoalDetail,
  channel: WorkplaceChannel,
  saved: () => void,
) {
  const ui = policyControls("この Goal の任せ方", saved);
  for (const gate of ruleGates) {
    const current = goal.policyOverrides[gate];
    ui.controls.append(
      segmented(gateLabels[gate], gate, current, goalChoices, (value) => {
        ui.change(
          value === "agent" || (current === "human" && value === "inherit"),
          () =>
            channel.request("goal.setPolicy", {
              goalId: goal.id,
              gate,
              value,
              expected: current,
            }),
        );
      }),
    );
  }
  return ui.section;
}

export function taskDelegation(
  task: TaskDetail,
  channel: WorkplaceChannel,
  saved: () => void,
) {
  const ui = policyControls("この Task の統合", saved);
  const current = task.integrationPolicy;
  ui.controls.append(
    segmented("統合", "task-policy", current, taskChoices, (value) => {
      ui.change(
        value === "agent" || (current === "human" && value === "rule"),
        () =>
          channel.request("task.setIntegrationPolicy", {
            taskId: task.id,
            value,
            expected: current,
          }),
      );
    }),
  );
  const effective = task.effectiveIntegrationPolicy;
  ui.controls.append(
    textElement(
      "p",
      `適用中の判断者: ${effective.policy === "human" ? "人" : "AI"} · ${settingLabel(effective)}`,
    ),
  );
  if (["registered", "running", "review"].includes(task.stage))
    ui.controls.append(
      textElement(
        "p",
        "統合候補ができると、実際の変更と検証結果で判断者を確定します。",
      ),
    );
  return ui.section;
}

const pathFields = [
  ["pathsWithin", "許可するパス（1 行に 1 パターン）"],
  ["pathsExclude", "除外するパス（1 行に 1 パターン）"],
] as const;
const numberFields = [
  [
    "maxTokens",
    "予算の最大トークン数（Planner の計画値）",
    "task-registration",
  ],
  ["maxChangedLines", "最大変更行数", "integration"],
  ["maxChangedFiles", "最大変更ファイル数", "integration"],
] as const;

function describeConditions(conditions: RuleConditions) {
  const entries = [
    ...pathFields.map(([key, label]) => [key, label.split("（")[0]] as const),
    ...numberFields,
    ["categories", "Planner の申告カテゴリー"] as const,
  ];
  return entries.flatMap(([key, label]) => {
    const value = conditions[key];
    if (value === undefined) return [];
    return [
      textElement(
        "li",
        `${label}: ${Array.isArray(value) ? value.join(", ") : value}`,
      ),
    ];
  });
}

function labeled(label: string, input: HTMLElement) {
  const row = textElement("label", label);
  row.append(input);
  return row;
}

function selectFrom<T extends string>(
  choices: readonly (readonly [T, string])[],
  current: T,
) {
  const select = document.createElement("select");
  for (const [value, label] of choices) {
    const option = textElement("option", label);
    option.value = value;
    select.append(option);
  }
  select.value = current;
  return select;
}

function ruleForm(
  rule: DelegationRule,
  save: (rule: DelegationRule) => void,
  cancel: () => void,
) {
  const form = document.createElement("form");
  form.className = "rule-form";
  const fields = document.createElement("fieldset");
  const name = document.createElement("input");
  name.value = rule.name;
  name.maxLength = 80;
  name.required = true;
  const gate = selectFrom(
    ruleGates.map((gate) => [gate, gateLabels[gate]] as const),
    rule.gate,
  );
  const answerer = selectFrom(defaultChoices, rule.action);
  fields.append(
    labeled("ルール名", name),
    labeled("判断の種類", gate),
    labeled("判断者", answerer),
  );
  const paths = pathFields.map(([key, label]) => {
    const input = document.createElement("textarea");
    input.rows = 2;
    input.maxLength = 2576;
    input.value = rule.conditions[key]?.join("\n") ?? "";
    fields.append(labeled(label, input));
    return { key, input };
  });
  fields.append(
    textElement(
      "small",
      "パスはリポジトリからの相対パスで指定します。* はパスの一部分、** は階層をまたぐ一致に使えます。",
    ),
  );
  const numbers = numberFields.map(([key, label, gate]) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(Number.MAX_SAFE_INTEGER);
    input.step = "1";
    input.value = String(rule.conditions[key] ?? "");
    const row = labeled(label, input);
    fields.append(row);
    return { key, gate, input, row };
  });
  function updateNumbers() {
    for (const field of numbers) {
      field.input.disabled = field.gate !== gate.value;
      field.row.hidden = field.input.disabled;
    }
  }
  gate.addEventListener("change", updateNumbers);
  updateNumbers();

  const categoryFields = categories.map((category) => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = rule.conditions.categories?.includes(category) ?? false;
    return { category, input };
  });
  const categoryRow = document.createElement("fieldset");
  categoryRow.className = "policy-categories";
  categoryRow.append(
    textElement("legend", "Planner の申告カテゴリー（絞り込み）"),
  );
  for (const { category, input } of categoryFields)
    categoryRow.append(labeled(category, input));

  const submit = textElement("button", "ルールを保存");
  submit.type = "submit";
  submit.className = "btn primary";
  fields.append(
    categoryRow,
    submit,
    action("キャンセル", "cancel-rule", cancel),
  );
  form.append(fields);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const conditions: RuleConditions = {};
    for (const { key, input } of paths) {
      const lines = input.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length) conditions[key] = lines;
    }
    for (const { key, input } of numbers) {
      if (!input.disabled && input.value !== "")
        conditions[key] = Number(input.value);
    }
    const selected = categoryFields
      .filter(({ input }) => input.checked)
      .map(({ category }) => category);
    if (selected.length) conditions.categories = selected;
    save({
      ...rule,
      name: name.value.trim(),
      gate: gate.value as RuleGate,
      action: answerer.value as Policy,
      conditions,
    });
  });
  return form;
}

export function delegationPanel(
  settings: PolicySettings,
  channel: WorkplaceChannel,
  saved: () => void,
) {
  const panel = group(
    "div",
    "stack",
    textElement("h2", "任せ方", "title large"),
    textElement(
      "p",
      "プロジェクト全体の設定です。Goal ごと・Task ごとの設定は、それぞれの詳細画面で変えられます。",
      "meta",
    ),
  );
  const defaults = policyControls("既定", saved);
  for (const gate of Object.keys(gateLabels).filter(
    (gate): gate is PolicyGate => gate !== "host-check",
  )) {
    const untouched = !settings.explicitDefaults.includes(gate);
    defaults.controls.append(
      segmented(
        untouched ? `${gateLabels[gate]}（初期値）` : gateLabels[gate],
        gate,
        settings.defaults[gate] ?? "human",
        defaultChoices,
        (policy) => {
          defaults.change(policy === "agent", () =>
            channel.request("policy.setDefault", { gate, policy }),
          );
        },
        untouched,
      ),
    );
  }
  panel.append(defaults.section);

  const rules = policyControls("ルール", saved);
  const rows = document.createElement("ol");
  rows.className = "policy-rules";
  const original = settings.rules;
  function update(next: readonly DelegationRule[]) {
    const rulesToSave = orderedRules(next);
    rules.change(ruleChangeCanWiden(original, rulesToSave), () =>
      channel.request("policy.setRules", {
        rules: rulesToSave,
        expectedRevision: settings.rulesRevision,
      }),
    );
  }
  function edit(rule: DelegationRule, index: number) {
    rules.edit(
      ruleForm(
        rule,
        (next) => {
          const updated: DelegationRule[] = [...original];
          updated[index] = next;
          update(updated);
        },
        () => {
          rules.close();
          rules.controls
            .querySelector<HTMLButtonElement>(
              index === original.length
                ? '[data-focus-key="add-rule"]'
                : `[data-focus-key="edit:${rule.id}"]`,
            )
            ?.focus();
        },
      ),
    );
  }
  for (const [index, rule] of original.entries()) {
    const row = textElement("li", "", "setting");
    const summary = group(
      "div",
      "label",
      textElement("strong", rule.name),
      textElement(
        "p",
        `${gateLabels[rule.gate]} · ${rule.action === "agent" ? "AI" : "人"} · 過去 7 日に ${rule.hitsLast7Days} 件`,
        "meta",
      ),
    );
    const conditions = document.createElement("ul");
    conditions.append(...describeConditions(rule.conditions));
    const buttons = document.createElement("div");
    buttons.className = "actions";
    const toggle = action(
      "",
      `toggle:${rule.id}`,
      () => {
        update(
          original.map((entry) =>
            entry.id === rule.id
              ? { ...entry, enabled: !entry.enabled }
              : entry,
          ),
        );
      },
      "switch",
    );
    toggle.append(textElement("span", ""));
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", `ルール「${rule.name}」を有効にする`);
    toggle.setAttribute("aria-checked", String(rule.enabled));
    const up = action("上へ", `up:${rule.id}`, () =>
      update(moveRule(original, index, -1)),
    );
    up.disabled = index === 0;
    const down = action("下へ", `down:${rule.id}`, () =>
      update(moveRule(original, index, 1)),
    );
    down.disabled = index === original.length - 1;
    buttons.append(
      action("編集", `edit:${rule.id}`, () => edit(rule, index)),
      up,
      down,
      action("削除", `remove:${rule.id}`, () =>
        update(original.filter((entry) => entry.id !== rule.id)),
      ),
    );
    summary.append(conditions);
    row.append(toggle, summary, buttons);
    rows.append(row);
  }
  const add = action("ルールを追加", "add-rule", () =>
    edit(
      {
        id: crypto.randomUUID(),
        name: "",
        gate: "task-registration",
        action: "human",
        enabled: true,
        order: original.length,
        conditions: {},
      },
      original.length,
    ),
  );
  add.disabled = original.length >= 50;
  rules.controls.append(
    textElement(
      "p",
      "上から順に確認し、最初に一致したルールを適用します。",
      "meta",
    ),
    ...(original.length ? [rows] : [textElement("p", "ルールはありません。")]),
    add,
  );
  panel.append(rules.section);
  const invariants = textElement("ul", "", "card");
  invariants.append(
    ...settings.invariants.map((key) =>
      textElement("li", invariantLabels[key], "fixed"),
    ),
  );
  panel.append(sectionTitle("設定では変わらないこと"), invariants);
  return panel;
}
