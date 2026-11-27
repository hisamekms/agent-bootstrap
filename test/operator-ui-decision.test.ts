import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { disclosure } from "../src/operator-ui/web/dom.ts";
import {
  createHostPanel,
  createInboxPanel,
  environmentControls,
  goalBaseUpdate,
  goalExport,
  problemActions,
  workplaceStopControls,
} from "../src/operator-ui/web/panel.ts";
import type { WorkplaceChannel } from "../src/operator-ui/web/channel.ts";
import type {
  Activity,
  GoalDetail,
  Methods,
  PanelInboxItem,
  Proposal,
  Problem,
} from "../src/operator-ui/web/protocol.ts";

class TestElement extends EventTarget {
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  parent: TestElement | undefined;
  className = "";
  disabled = false;
  hidden = false;
  checked = false;
  value = "";
  attributes = new Map<string, string>();

  get parentElement() {
    return this.parent;
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  get isConnected() {
    return Boolean(this.parent);
  }

  contains(node: TestElement) {
    return Boolean(this.find((candidate) => candidate === node));
  }
  private text = "";

  get textContent(): string {
    return this.text + this.children.map((node) => node.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    for (const child of this.children) child.parent = undefined;
    this.children = [];
  }

  append(...children: Array<TestElement | string>) {
    const adopted = this.adopt(children);
    this.children.push(...adopted);
  }

  prepend(...children: Array<TestElement | string>) {
    const adopted = this.adopt(children);
    this.children.unshift(...adopted);
  }

  private adopt(children: Array<TestElement | string>) {
    return children.map((value) => {
      const child = typeof value === "string" ? new TestElement() : value;
      if (typeof value === "string") child.textContent = value;
      child.remove();
      child.parent = this;
      return child;
    });
  }

  replaceChildren(...children: TestElement[]) {
    this.textContent = "";
    this.append(...children);
  }

  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = undefined;
  }

  find(predicate: (node: TestElement) => boolean): TestElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0];
  }

  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap((child) => [
      ...(selector === "*" ||
      (selector === "[data-focus-key]" && child.dataset.focusKey) ||
      (selector.startsWith(".") &&
        child.className.split(" ").includes(selector.slice(1)))
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  closest(selector: string): TestElement | undefined {
    if (selector === "[hidden]" && this.hidden) return this;
    return this.parent?.closest(selector);
  }

  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  focus() {
    Object.assign(document, { activeElement: this });
  }
}

function decisionDocument(t: TestContext, ids: string[] = []) {
  const elements = new Map(
    [
      "inbox-items",
      "answer-batch",
      "answer-results",
      "empty-inbox",
      "tab-decisions",
      ...ids,
    ].map((id) => [id, new TestElement()]),
  );
  const document = Object.assign(new EventTarget(), {
    activeElement: null,
    getElementById: (id: string) => elements.get(id),
    createElement: () => new TestElement(),
    createTextNode(text: string) {
      const node = new TestElement();
      node.textContent = text;
      return node;
    },
  });
  for (const [key, value] of Object.entries({
    document,
    Node: TestElement,
    HTMLElement: TestElement,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
    },
    window: { setInterval() {} },
    WebSocket: { OPEN: 1 },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const inbox = elements.get("inbox-items")!;
  const batch = elements.get("answer-batch")!;
  const scope = new TestElement();
  const findAction = (key: string, root = scope) =>
    root.find(({ dataset }) => dataset.focusKey === key);
  function click(key: string, root = scope) {
    const node = findAction(key, root);
    assert.ok(node && !node.disabled);
    node.dispatchEvent(new Event("click"));
  }
  scope.append(inbox, batch, elements.get("tab-decisions")!);
  return { inbox, batch, findAction, click, elements };
}

const id = "proposal";
const first = "a".repeat(64);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Goal base controls show both commits and require the fresh preview phrase", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const first = { from: "1".repeat(40), to: "2".repeat(40) };
  const fresh = { from: first.from, to: "3".repeat(40) };
  const goal = {
    id: "goal-id",
    ref: "G1",
    baseUpdatePreview: first,
  } as GoalDetail;
  const requests: unknown[] = [];
  let refreshes = 0;
  const [card] = goalBaseUpdate(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        if (method === "goal.get")
          return { ...goal, baseUpdatePreview: fresh } as Methods[M]["result"];
        requests.push(params);
        throw new Error("stale-base");
      },
    },
    goal,
    () => {
      refreshes++;
    },
  );
  const root = card as unknown as TestElement;
  click("base:goal-id", root);
  await settle();
  assert.match(root.textContent, /111111111111 → 333333333333/);
  assert.ok(findAction("base:goal-id:confirm", root)?.disabled);
  const input = root.find(
    (node) => node.attributes.get("aria-label") === "確認の文言",
  )!;
  input.value = "update-goal-base G1 333333333333";
  input.dispatchEvent(new Event("input"));
  click("base:goal-id:confirm", root);
  await settle();
  assert.deepEqual(requests, [
    { id: "goal-id", confirm: input.value, ...fresh },
  ]);
  assert.match(root.textContent, /状況が変わりました/);
  assert.equal(refreshes, 1);
});

test("Workplace environment and shutdown confirm before dispatching", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const key = "a".repeat(64);
  const confirmation = "b".repeat(64);
  const revision = "c".repeat(64);
  const calls: Array<[string, unknown]> = [];
  let destinations = ["registry.npmjs.org:443", "registry.example.org:8443"];
  let failStop = false;
  const request = {
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      calls.push([method, params]);
      if (method === "workplace.stop" && failStop)
        throw new Error("write-failed");
      if (method === "environment.build" && destinations.length === 0)
        throw new Error("environment-build-running");
      const replies = {
        "environment.buildPreview": {
          key,
          confirmation,
          destinations,
          responsibilityNotice: "You are responsible for install scripts.",
        },
        "environment.build": { state: "running", key },
        "workplace.stopPreview": { runningTasks: 2, revision },
        "workplace.stop": { stopping: true },
      };
      return replies[method as keyof typeof replies] as Methods[M]["result"];
    },
  };
  const root = new TestElement();
  root.append(
    ...(environmentControls(
      request,
      {
        status: { key, state: "missing", hasLock: true, size: 0 },
        build: null,
      },
      () => {},
    ) as unknown as TestElement[]),
  );
  root.append(
    workplaceStopControls(request, () => {}) as unknown as TestElement,
  );
  click("environment:build", root);
  await settle();
  assert.match(root.textContent, /Provisioner VM がネットワークに接続します/);
  assert.match(
    root.textContent,
    /registry.npmjs.org:443、registry.example.org:8443/,
  );
  assert.match(root.textContent, /You are responsible for install scripts/);
  assert.deepEqual(calls, [["environment.buildPreview", {}]]);
  click("environment:build:confirm", root);
  await settle();
  assert.deepEqual(calls.at(-1), ["environment.build", { confirmation }]);
  destinations = [];
  click("environment:build", root);
  await settle();
  assert.match(root.textContent, /許可されたネットワーク接続先はありません/);
  click("environment:build:confirm", root);
  await settle();
  assert.match(root.textContent, /別の環境の準備が進行中です/);
  root.replaceChildren(
    ...(environmentControls(
      request,
      {
        status: { key, state: "missing", hasLock: true, size: 0 },
        build: { state: "running", key },
      },
      () => {},
    ) as unknown as TestElement[]),
  );
  assert.match(root.textContent, /環境を準備中/);
  assert.equal(findAction("environment:build", root), undefined);
  root.append(
    workplaceStopControls(request, () => {}) as unknown as TestElement,
  );
  click("workplace:stop", root);
  await settle();
  assert.match(root.textContent, /実行中の Task が 2 件あります/);
  assert.deepEqual(calls.at(-1), ["workplace.stopPreview", {}]);
  click("workplace:stop:confirm", root);
  await settle();
  assert.deepEqual(calls.at(-1), [
    "workplace.stop",
    { confirm: "Workplace を終える", revision },
  ]);
  failStop = true;
  click("workplace:stop", root);
  await settle();
  click("workplace:stop:confirm", root);
  await settle();
  assert.match(root.textContent, /終了を記録できませんでした。.*Ctrl-C/);
});

function details(digest: string): Extract<Proposal, { kind: "goal" }> {
  return {
    id,
    ref: null,
    goalRef: null,
    taskRef: null,
    digest,
    kind: "goal",
    status: "pending",
    gate: "goal-registration",
    effectivePolicy: "human",
    policySource: "default",
    loosening: [],
    origin: { kind: "operator" },
    diffStat: null,
    paths: ["src/"],
    actors: ["Executor"],
    profiles: ["base"],
    maxTasks: 1,
    budgets: { maxExecutionMs: 1000, maxRetries: 0, maxTokens: 100 },
    pathViolations: [],
    modelText: {
      description:
        digest === first ? "Before" : "<em>Updated</em>\nSecond line",
      acceptance: ["Pass\nAlso pass"],
    },
  };
}

function row(digest: string, id = "proposal"): PanelInboxItem {
  return {
    id: `goal-registration:${id}`,
    kind: "goal-registration",
    weight: "action",
    state: "open",
    title: "Goal",
    at: "2026-11-26T00:00:00Z",
    subject: { proposalId: id },
    next: "approve proposal",
    answer: {
      id,
      digest,
      kind: "goal",
      title: "Title",
      agentGates: [],
      approve: true,
      reject: true,
    },
  };
}

test("a stale approval reopens the card and previews the new digest before resubmitting", async (t) => {
  const { inbox, click } = decisionDocument(t);
  const updated = "b".repeat(64);
  let digest = first;
  const requests: string[] = [];
  const submitted: string[] = [];
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        requests.push(method);
        if (method === "proposal.get")
          return details(digest) as Methods[M]["result"];
        assert.equal(method, "proposal.answer");
        submitted.push((params as Methods["proposal.answer"]["params"]).digest);
        if (digest === first) {
          digest = updated;
          throw new Error("stale-digest");
        }
        return { id, ok: true, decision: "approve" } as Methods[M]["result"];
      },
    },
    refresh,
    () => {},
    () => {},
  );
  function refresh() {
    panel.render(
      [row(digest)],
      () => [],
      () => undefined,
    );
  }
  refresh();
  assert.deepEqual(requests, []);
  click("approve:goal-registration:proposal");
  await settle();
  click("submit-answer");
  await settle();
  assert.deepEqual(requests, [
    "proposal.get",
    "proposal.answer",
    "proposal.get",
  ]);
  const card = inbox.textContent;
  assert.match(card, /内容が変わりました。もう一度確認してください/);
  assert.match(card, /AI の記述説明<em>Updated<\/em>\nSecond line/);
  assert.ok(
    inbox.find(
      (node) =>
        node.className.includes("proposal-text") &&
        node.textContent === "Pass\nAlso pass",
    ),
  );
  assert.doesNotMatch(card, /a{12}|b{12}/);
  click("approve:goal-registration:proposal");
  await settle();
  assert.deepEqual(submitted, [first, updated]);
});

test("withheld proposal fields block confirmation while rejection remains available", async (t) => {
  const { inbox, click, findAction } = decisionDocument(t);
  const submitted: Methods["proposal.answer"]["params"][] = [];
  const proposal = details(first);
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        if (method === "proposal.get")
          return {
            ...proposal,
            modelText: {
              ...proposal.modelText,
              acceptance: { withheld: true },
            },
          } as Methods[M]["result"];
        assert.equal(method, "proposal.answer");
        submitted.push(params as Methods["proposal.answer"]["params"]);
        return { id, ok: true, decision: "reject" } as Methods[M]["result"];
      },
    },
    () => {},
    () => {},
    () => {},
  );
  panel.render(
    [row(first)],
    () => [],
    () => undefined,
  );
  click("approve:goal-registration:proposal");
  await settle();
  const submit = findAction("submit-answer");
  assert.ok(submit?.disabled);
  assert.match(
    inbox.textContent,
    /隠した項目があるため、画面からは承認できません。CLI で内容を確認してください。/,
  );
  submit.dispatchEvent(new Event("click"));
  await settle();
  assert.deepEqual(submitted, []);

  click("cancel-answer");
  click("detail:goal-registration:proposal");
  await settle();
  assert.ok(findAction("approve:goal-registration:proposal")?.disabled);
  click("reject:goal-registration:proposal");
  click("submit-answer");
  await settle();
  assert.deepEqual(submitted, [{ id, digest: first, decision: "reject" }]);
});

test("answering instead of the AI requires confirmation and preserves credential withholding", async (t) => {
  const { inbox, click, findAction } = decisionDocument(t);
  const submitted: Methods["proposal.answer"]["params"][] = [];
  let blocked = false;
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        if (method === "proposal.get") {
          const proposal = {
            ...details(first),
            effectivePolicy: "agent",
            ...(submitted[0]?.decision === "approve" && {
              status: "approved",
              goalRef: "G1",
            }),
          };
          if (!blocked) return proposal as Methods[M]["result"];
          return {
            ...proposal,
            modelText: {
              ...proposal.modelText,
              acceptance: { withheld: true },
            },
          } as Methods[M]["result"];
        }
        assert.equal(method, "proposal.answer");
        const answer = params as Methods["proposal.answer"]["params"];
        submitted.push(answer);
        return { id: answer.id, ok: true } as Methods[M]["result"];
      },
    },
    () => {},
    () => {},
    () => {},
  );
  function render() {
    const item = row(first, blocked ? "blocked" : id);
    assert.ok("answer" in item);
    panel.render(
      [
        {
          ...item,
          answer: {
            ...item.answer,
            approve: false,
            reject: false,
            takeover: true,
          },
        },
      ],
      () => [],
      () => undefined,
    );
  }

  render();
  assert.equal(findAction("choose:goal-registration:proposal"), undefined);
  assert.equal(findAction("approve:goal-registration:proposal"), undefined);
  assert.equal(
    findAction("takeover:goal-registration:proposal")?.textContent,
    "自分で答える",
  );
  click("takeover:goal-registration:proposal");
  assert.match(inbox.textContent, /AI の代わりに回答します/);
  assert.ok(findAction("submit-takeover:approve")?.disabled);
  await settle();
  assert.match(inbox.textContent, /Before/);
  assert.deepEqual(submitted, []);
  click("cancel-answer");
  assert.equal(findAction("submit-takeover:approve"), undefined);
  click("takeover:goal-registration:proposal");
  await settle();
  click("submit-takeover:approve");
  await settle();
  assert.deepEqual(submitted, [
    { id, digest: first, decision: "approve", takeover: true },
  ]);

  blocked = true;
  render();
  click("takeover:goal-registration:blocked");
  await settle();
  assert.ok(findAction("submit-takeover:approve")?.disabled);
  assert.match(inbox.textContent, /隠した項目があるため/);
  click("submit-takeover:reject");
  await settle();
  assert.deepEqual(submitted[1], {
    id: "blocked",
    digest: first,
    decision: "reject",
    takeover: true,
  });
});

test("the closed card confirms on one line; opening detail approves the viewed digest directly", async (t) => {
  const { click, inbox, findAction } = decisionDocument(t);
  const approved: Array<[string, string]> = [];
  const calls: Array<[string, unknown]> = [];
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        calls.push([method, params]);
        if (method === "proposal.get") {
          const decided = calls.some(([name]) => name === "proposal.answer");
          return (
            decided
              ? { ...details(first), status: "approved", goalRef: "G12" }
              : details(first)
          ) as Methods[M]["result"];
        }
        return { id, ok: true } as Methods[M]["result"];
      },
    },
    () => {},
    () => {},
    () => {},
    (item, ref) => approved.push([item.id, ref]),
  );
  panel.render(
    [row(first)],
    () => [],
    () => undefined,
  );
  click("approve:goal-registration:proposal");
  await settle();
  assert.equal(
    inbox.querySelector(".confirm")?.textContent,
    "「Title」を承認します。戻す承認を確定",
  );
  assert.doesNotMatch(inbox.textContent, /AI の記述/);
  click("cancel-answer");
  click("detail:goal-registration:proposal");
  await settle();
  assert.equal(calls.length, 1);
  const detail = inbox.querySelector(".decision-detail")!;
  assert.match(detail.textContent, /読んだ内容で確定します/);
  assert.ok(findAction("approve:goal-registration:proposal", detail));
  click("approve:goal-registration:proposal", detail);
  await settle();
  assert.equal(findAction("submit-answer"), undefined);
  assert.deepEqual(calls[1], [
    "proposal.answer",
    { id, digest: first, decision: "approve" },
  ]);
  assert.deepEqual(approved, [["goal-registration:proposal", "G12"]]);
  const otherSurface = panel.card(row(first), () => [], {
    surface: "popover",
  }) as unknown as TestElement;
  await settle();
  assert.deepEqual(
    calls.map(([method]) => method),
    ["proposal.get", "proposal.answer", "proposal.get", "proposal.get"],
  );
  assert.ok(
    findAction("approve:goal-registration:proposal", otherSurface)?.disabled,
  );
});

test("batch confirmation is one line and preserves both selected digests", async (t) => {
  const { batch, click, findAction } = decisionDocument(t);
  const second = "b".repeat(64);
  const calls: unknown[] = [];
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        if (method === "proposal.get") {
          const { id } = params as Methods["proposal.get"]["params"];
          return {
            ...details(id === "another" ? second : first),
            id,
          } as Methods[M]["result"];
        }
        assert.equal(method, "proposal.answerMany");
        calls.push(params);
        return [] as Methods[M]["result"];
      },
    },
    () => {},
    () => {},
    () => {},
  );
  panel.render(
    [row(first), row(second, "another")],
    () => [],
    () => undefined,
  );
  for (const id of ["proposal", "another"]) {
    const check = findAction(`choose:goal-registration:${id}`)!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
  }
  assert.equal(batch.hidden, false);
  click("approve-batch");
  await settle();
  assert.equal(
    batch.querySelector(".confirm")?.textContent,
    "2 件を承認します。戻す承認を確定",
  );
  click("submit-answer");
  await settle();
  assert.deepEqual(calls, [
    {
      answers: [
        { id, digest: first, decision: "approve" },
        { id: "another", digest: second, decision: "approve" },
      ],
    },
  ]);
});

test("the activity popover restores focus only from inside and closes on outside focus or pointer input", (t) => {
  decisionDocument(t);
  const button = new TestElement();
  const popover = new TestElement();
  popover.hidden = true;
  const dialog = disclosure(
    button as unknown as HTMLElement,
    popover as unknown as HTMLElement,
  );
  dialog.toggle();
  assert.equal(button.attributes.get("aria-expanded"), "true");
  assert.equal(popover.hidden, false);
  assert.equal(document.activeElement, popover);
  assert.equal(dialog.close(), true);
  assert.equal(dialog.close(), false);
  assert.equal(document.activeElement, button);
  dialog.toggle();
  const terminal = new TestElement();
  terminal.focus();
  assert.equal(dialog.close(), true);
  assert.equal(document.activeElement, terminal);
  dialog.toggle();
  const focusout = new Event("focusout");
  Object.defineProperty(focusout, "relatedTarget", { value: terminal });
  terminal.focus();
  popover.dispatchEvent(focusout);
  assert.equal(popover.hidden, true);
  assert.equal(document.activeElement, terminal);
  dialog.toggle();
  const outside = new Event("pointerdown");
  Object.defineProperty(outside, "target", { value: new TestElement() });
  document.dispatchEvent(outside);
  assert.equal(button.attributes.get("aria-expanded"), "false");
  assert.equal(popover.hidden, true);
});

const failure: Problem = {
  title: "README の例を直す",
  at: "2026-11-26T00:00:00Z",
  goalId: "goal-id",
  taskId: "task-id",
  ref: "G10-1",
  goalRef: "G10",
  taskRef: "G10-1",
  expectedRetries: 2,
  kind: "task-failed",
  canRetry: true,
  code: "budget-exceeded",
  detail: "",
};

test("Problems drafts do not submit input and retry uses the displayed retry count", async (t) => {
  const { click } = decisionDocument(t);
  const calls: Array<[string, unknown]> = [];
  const receipts: string[] = [];
  let focused = false;
  const root = problemActions(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        calls.push([method, params]);
        return {} as Methods[M]["result"];
      },
    },
    failure,
    "文書",
    (_id, ref) => {
      const link = document.createElement("button");
      link.textContent = ref ?? null;
      return [link];
    },
    () => {
      focused = true;
    },
    (receipt) => receipts.push(receipt),
  ) as unknown as TestElement;
  click("consult:task-id", root);
  await settle();
  assert.equal(focused, true);
  assert.match(
    root.textContent,
    /左の Concierge に下書きを入れました。送るまで何も起きません。/,
  );
  click("retry:task-id", root);
  assert.match(
    root.querySelector(".confirm")!.textContent,
    /「README の例を直す」を同じ内容でやり直します（予算はリセット）。/,
  );
  click("confirm:task-id", root);
  await settle();
  assert.match(root.textContent, /受け付けました· 順番待ちG10/);
  assert.deepEqual(receipts, ["retried"]);
  assert.deepEqual(calls, [
    [
      "concierge.draft",
      {
        text: "G10-1「README の例を直す」が予算超過で失敗しました。原因を調べて、次にどうするか提案してください。",
      },
    ],
    ["task.retry", { id: "task-id", expectedRetries: 2 }],
  ]);
});

test("discard binds the confirmed branch head, requires reconfirmation, and refuses unreadable heads", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const calls: Array<[string, unknown]> = [];
  let head = "1".repeat(40);
  let headAvailable = true;
  const root = problemActions(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        calls.push([method, params]);
        if (method === "goal.get")
          return {
            id: "goal-id",
            title: "文書",
            ref: "G10",
            head,
            headAvailable,
          } as Methods[M]["result"];
        throw new Error("stale-base");
      },
    },
    failure,
    undefined,
    () => [],
    () => {},
    () => assert.fail("stale discard"),
  ) as unknown as TestElement;
  click("discard:task-id", root);
  await settle();
  assert.match(
    root.querySelector(".confirm")!.textContent,
    /G10「文書」を取り消します。取り消すと戻せません。/,
  );
  head = "2".repeat(40);
  click("confirm:task-id", root);
  await settle();
  assert.deepEqual(calls, [
    ["goal.get", { id: "goal-id" }],
    [
      "goal.discard",
      { id: "goal-id", confirm: "G10", expectedHead: "1".repeat(40) },
    ],
  ]);
  assert.match(
    root.textContent,
    /Goal が変わりました。もう一度確認してください。/,
  );
  click("discard:task-id", root);
  await settle();
  click("confirm:task-id", root);
  await settle();
  assert.deepEqual(calls.at(-1), [
    "goal.discard",
    { id: "goal-id", confirm: "G10", expectedHead: "2".repeat(40) },
  ]);
  headAvailable = false;
  click("discard:task-id", root);
  await settle();
  assert.equal(findAction("confirm:task-id", root), undefined);
  assert.match(
    root.textContent,
    /Goal のブランチを確認できないため、取り消せません。/,
  );
});

test("Goal export confirms the local branch and refreshes a conflict before reconfirming", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const branch = "lo/goal-12345678";
  const preview = (to: string, from: string | null = null) => ({
    branch,
    target: "demo",
    from,
    to,
  });
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  let goal = {
    id: "goal-id",
    ref: "G10",
    turn: { owner: "done", reason: { kind: "exportable" } },
    exportPreview: preview(first),
    exportBlockReason: null,
  } as GoalDetail;
  const calls: Array<[string, unknown]> = [];
  const root = new TestElement();
  let refreshes = 0;
  let failureCode = "";
  const channel = {
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      calls.push([method, params]);
      if (method === "goal.get") return goal as Methods[M]["result"];
      assert.equal(method, "goal.export");
      if (failureCode) throw new Error(failureCode);
      const result = {
        id: goal.id,
        ref: goal.ref,
        ...goal.exportPreview,
      } as Methods[M]["result"];
      const head = goal.exportPreview!.to;
      goal = { ...goal, exportPreview: preview(head, head) };
      return result;
    },
  };
  const render = (detail: GoalDetail, message = "") =>
    root.replaceChildren(
      goalExport(channel, detail, message, async (notice) => {
        refreshes++;
        const current = await channel.request("goal.get", { id: detail.id });
        render(current, notice);
      }) as unknown as TestElement,
    );
  render({ ...goal, turn: { owner: "idle", reason: { kind: "idle" } } });
  assert.equal(findAction("export:goal-id", root), undefined);
  render({ ...goal, exportPreview: null });
  assert.equal(findAction("export:goal-id", root), undefined);
  assert.match(root.textContent, /agent-bootstrap export-goal-branch G10/);

  render(goal);
  assert.equal(
    findAction("export:goal-id", root)?.textContent,
    "ブランチを書き出す",
  );
  click("export:goal-id", root);
  await settle();
  assert.match(
    root.querySelector(".confirm")!.textContent,
    /lo\/goal-12345678.*demo.*なし → 111111111111.*ローカルブランチ.*プッシュは行いません/,
  );
  click("back-export:goal-id", root);
  assert.deepEqual(calls, [["goal.get", { id: "goal-id" }]]);
  click("export:goal-id", root);
  await settle();
  goal = { ...goal, exportPreview: preview(second, first) };
  failureCode = "stale-base";
  click("confirm-export:goal-id", root);
  assert.equal(findAction("confirm-export:goal-id", root)?.disabled, true);
  await settle();
  assert.equal(refreshes, 1);
  assert.equal(root.querySelector(".confirm"), undefined);
  assert.match(root.textContent, /更新した内容を確認してください/);

  failureCode = "";
  click("export:goal-id", root);
  await settle();
  assert.match(
    root.querySelector(".confirm")!.textContent,
    /111111111111 → 222222222222/,
  );
  click("confirm-export:goal-id", root);
  await settle();
  assert.deepEqual(
    calls.filter(([method]) => method === "goal.export"),
    [first, second].map((head) => [
      "goal.export",
      {
        id: "goal-id",
        confirm: `export-goal-branch G10 ${head.slice(0, 12)}`,
        expectedHead: head,
      },
    ]),
  );
  assert.match(
    root.textContent,
    /demo で lo\/goal-12345678 をレビュー.*プッシュし、main へのプルリクエストを作成/,
  );
  assert.equal(findAction("export:goal-id", root), undefined);
  assert.match(root.textContent, /すでに Goal の先端（222222222222）/);

  for (const [reason, message] of [
    [
      "branch-checked-out",
      /ワークツリーでチェックアウトされています。先に別のブランチに切り替えてください。/,
    ],
    [
      "non-fast-forward",
      /Goal に含まれないコミットがあるため、ブランチを移動できません。/,
    ],
  ] as const) {
    const blocked = { ...goal, exportPreview: null, exportBlockReason: reason };
    render(blocked);
    assert.match(root.textContent, message);
    assert.match(root.textContent, /agent-bootstrap export-goal-branch G10/);
    assert.equal(findAction("export:goal-id", root), undefined);

    goal = {
      ...goal,
      exportPreview: preview(second, first),
      exportBlockReason: null,
    };
    render(goal);
    click("export:goal-id", root);
    await settle();
    goal = blocked;
    failureCode = reason;
    click("confirm-export:goal-id", root);
    await settle();
    assert.match(root.textContent, message);
    assert.doesNotMatch(root.textContent, /更新した内容を確認してください/);
    assert.match(root.textContent, /agent-bootstrap export-goal-branch G10/);
    assert.equal(findAction("export:goal-id", root), undefined);
    assert.equal(root.querySelector(".confirm"), undefined);

    // Once the blocker is gone, its earlier message no longer shows.
    const blockerText = [
      "書き出し先のブランチはワークツリーでチェックアウトされています。先に別のブランチに切り替えてください。",
      "書き出し先のブランチに Goal に含まれないコミットがあるため、ブランチを移動できません。",
    ].find((text) => message.test(text))!;
    failureCode = "";
    render(
      {
        ...goal,
        exportPreview: preview(second, first),
        exportBlockReason: null,
      },
      blockerText,
    );
    assert.doesNotMatch(root.textContent, message);
    assert.ok(findAction("export:goal-id", root));
  }

  goal = {
    ...goal,
    exportPreview: preview(second, first),
    exportBlockReason: null,
  };
  render(goal);
  click("export:goal-id", root);
  await settle();
  goal = { ...goal, exportPreview: preview(second, second) };
  failureCode = "goal-export-record-failed";
  click("confirm-export:goal-id", root);
  await settle();
  assert.match(
    root.textContent,
    /demo の lo\/goal-12345678 は更新されましたが、書き出しの完了を記録できませんでした。ブランチはすでに Goal の先端にあるので、書き出し直す必要はありません。監査記録を確認してください。/,
  );
  assert.match(root.textContent, /すでに Goal の先端（222222222222）/);
  assert.equal(findAction("export:goal-id", root), undefined);
});

test("the popover groups problems and resets confirmations while tracking approved Goal planning", async (t) => {
  const { inbox, click, elements, findAction } = decisionDocument(t, [
    "inbox-notice",
    "now-toggle",
    "now-popover",
    "settings-toggle",
    "connection",
    "settings-back",
    "settings-delegation",
    "settings-display",
    "settings-connection",
    "tab-problems",
    "tab-goals",
    "badge-decisions",
    "badge-problems",
    "badge-goals",
    "connection-update",
    "decision-history",
  ]);
  const pill = elements.get("now-toggle")!;
  const popover = elements.get("now-popover")!;
  popover.hidden = true;
  let rows = [row(first)];
  let approved = false;
  let focuses = 0;
  const calls: Array<[string, unknown]> = [];
  const activity: Activity = {
    running: [
      {
        id: "execution",
        status: "running",
        actor: "Executor",
        mode: "task",
        goalId: "another-goal",
        taskId: "task",
        goalRef: "G2",
        taskRef: "G2-1",
        goalTitle: "Other Goal",
        taskTitle: "Running Task",
        startedAt: new Date().toISOString(),
      },
    ],
    queued: [],
    queuedCount: 0,
    yourTurn: 2,
  };
  const host = createHostPanel(
    {
      socket: { readyState: 1 },
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        calls.push([method, params]);
        let result: unknown;
        switch (method) {
          case "inbox.list":
            result = rows;
            break;
          case "activity.get":
            result = activity;
            break;
          case "problem.list":
            result = [
              failure,
              {
                ...failure,
                kind: "execution-over-budget",
                executionId: "budget-run",
              },
            ];
            break;
          case "goal.list":
            result = approved
              ? [
                  {
                    id: "goal-id",
                    ref: "G12",
                    title: "Title",
                    status: "active",
                    progress: { total: 0 },
                    turn: { reason: { kind: "not-planned" } },
                  },
                ]
              : [];
            break;
          case "proposal.get":
            result = approved
              ? { ...details(first), status: "approved", goalRef: "G12" }
              : details(first);
            break;
          case "proposal.answer":
            approved = true;
            rows = [];
            activity.yourTurn = 1;
            result = { id, ok: true };
            break;
          case "concierge.draft":
            result = { characters: 50 };
            break;
          default:
            result = [];
        }
        return result as Methods[M]["result"];
      },
    } as unknown as WorkplaceChannel,
    () => {
      focuses++;
    },
  );

  host.connect();
  await settle();
  assert.equal(pill.textContent, "AI 作業中 1 · 待ち 0 · あなたの番 2");
  assert.equal(elements.get("badge-decisions")!.textContent, "1");
  assert.equal(elements.get("badge-problems")!.textContent, "1");
  pill.dispatchEvent(new Event("click"));
  assert.match(popover.textContent, /G2-1AIRunning TaskExecutor/);
  assert.match(popover.textContent, /あなたの番/);
  assert.deepEqual(
    popover.querySelectorAll(".now-problem").map((node) => node.textContent),
    ["G10-1AIREADME の例を直す予算超過問題を見る ›"],
  );
  click("reject:goal-registration:proposal", popover);
  assert.ok(popover.querySelector(".confirm"));
  assert.equal(host.closeNow(), true);
  assert.equal(document.activeElement, pill);
  pill.dispatchEvent(new Event("click"));
  assert.equal(popover.querySelector(".confirm"), undefined);
  click("approve:goal-registration:proposal", popover);
  await settle();
  const originalConfirm = popover.querySelector(".confirm");
  assert.ok(originalConfirm);
  activity.running = [];
  await host.refresh();
  assert.equal(popover.querySelector(".confirm"), originalConfirm);
  click("submit-answer", popover);
  await settle();
  for (const area of [popover, inbox]) {
    assert.match(area.textContent, /受け付けましたG12/);
    assert.doesNotMatch(area.textContent, /確認が必要です。/);
    assert.ok(findAction("goal:goal-id", area));
  }

  click("plan:G12", popover);
  await settle();
  assert.equal(focuses, 1);
  assert.match(popover.textContent, /下書きを入れました（Enter で送ります）/);
  assert.deepEqual(
    calls.filter(([method]) => method === "concierge.draft"),
    [
      [
        "concierge.draft",
        { text: "G12「Title」が承認されました。Task に分けてください。" },
      ],
    ],
  );
  rows = [
    {
      ...row(first, "next"),
      kind: "task-registration",
      subject: {
        proposalId: "next",
        goalId: "goal-id",
        goalRef: "G12",
        ref: "G12",
      },
    },
  ];
  activity.yourTurn = 2;
  await host.refresh();
  for (const area of [popover, inbox]) {
    assert.doesNotMatch(area.textContent, /受け付けました/);
    assert.match(area.textContent, /Task の提案G12/);
  }
});
