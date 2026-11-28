import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createPreviewMethods } from "../spike/operator-ui/preview-fixtures.ts";
import { disclosure, restoreFocus } from "../src/operator-ui/web/dom.ts";
import {
  createHostPanel,
  createInboxPanel,
  environmentControls,
  goalBaseUpdate,
  goalExport,
  goalProgress,
  goalPublishPanel,
  problemActions,
  workplaceStopControls,
} from "../src/operator-ui/web/panel.ts";
import type { WorkplaceChannel } from "../src/operator-ui/web/channel.ts";
import type {
  Activity,
  AgentDecision,
  GoalDetail,
  Methods,
  PanelInboxItem,
  Proposal,
  Problem,
} from "../src/operator-ui/web/protocol.ts";

class TestElement extends EventTarget {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  title = "";
  children: TestElement[] = [];
  parent: TestElement | undefined;
  id = "";
  className = "";
  disabled = false;
  hidden = false;
  open = false;
  tabIndex = 0;
  checked = false;
  value = "";
  attributes = new Map<string, string>();

  readonly tag: string;

  constructor(tag = "") {
    super();
    this.tag = tag;
  }

  get childElementCount() {
    return this.children.length;
  }
  get firstElementChild() {
    return this.children[0];
  }
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

  get visibleText(): string {
    if (this.hidden || this.matches(".sr-only, .warning-explanation"))
      return "";
    const children =
      this.tag === "details" && !this.open
        ? this.children.filter(({ tag }) => tag === "summary")
        : this.children;
    return this.text + children.map((node) => node.visibleText).join("");
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
    if (selector === ":scope > summary")
      return this.children.find(({ tag }) => tag === "summary");
    return this.querySelectorAll(selector)[0];
  }

  private matches(selector: string) {
    return selector.split(", ").some((part) => {
      if (part === "*") return true;
      if (part === "[hidden]") return this.hidden;
      if (part === "details[open]") return this.tag === "details" && this.open;
      if (part === "details:not([open])")
        return this.tag === "details" && !this.open;
      if (part.startsWith("[data-")) {
        const key = part
          .slice(6, -1)
          .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        return Object.hasOwn(this.dataset, key);
      }
      if (part.includes(".")) {
        const [tag, name] = part.split(".");
        return (
          (!tag || this.tag === tag) &&
          this.className.split(" ").includes(name!)
        );
      }
      return this.tag === part;
    });
  }

  querySelectorAll(selector: string): TestElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  closest(selector: string): TestElement | undefined {
    return this.matches(selector) ? this : this.parent?.closest(selector);
  }

  removeAttribute(key: string) {
    this.attributes.delete(key);
  }

  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  focus() {
    Object.assign(document, { activeElement: this });
  }
}

function byName(root: TestElement, name: string | RegExp) {
  return root.find((node) => {
    const label = node.attributes.get("aria-label");
    return (
      label !== undefined &&
      (typeof name === "string" ? label === name : name.test(label))
    );
  });
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
    createElement: (tag: string) => new TestElement(tag),
    createElementNS: (_ns: string, tag: string) => new TestElement(tag),
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

test("decision cards show each subject and parent ref at most once", (t) => {
  decisionDocument(t);
  const panel = createInboxPanel(
    {
      async request() {
        throw new Error("Unexpected request");
      },
    },
    () => {},
    () => {},
    () => {},
  );
  const base = row(first);
  const subject = {
    ...base.subject,
    goalId: "goal-1",
    goalRef: "G1",
    ref: "G1",
  };
  const goalLink = (_id?: string | null, ref?: string | null) => {
    const link = document.createElement("button");
    link.className = "ref";
    link.textContent = `Goal ${ref}`;
    return [link];
  };
  const refs = (item: PanelInboxItem, goalRef?: string) =>
    Array.from(
      panel
        .card(item, goalLink, goalRef ? { goalRef } : {})
        .querySelectorAll(".ref"),
      ({ textContent }) => textContent,
    );
  const goal = { ...base, subject };
  const task = {
    ...base,
    kind: "task-registration",
    subject,
  } satisfies PanelInboxItem;
  const integration = {
    ...base,
    kind: "integration",
    subject: { ...subject, ref: "G1-4", taskRef: "G1-4" },
  } satisfies PanelInboxItem;
  assert.deepEqual(refs(goal), ["G1"]);
  assert.deepEqual(refs(task), ["Goal G1"]);
  assert.deepEqual(refs(task, "G1"), []);
  assert.deepEqual(refs(integration), ["G1-4", "Goal G1"]);
  assert.deepEqual(refs(integration, "G1"), ["#4"]);
});

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
  await settle();
  assert.deepEqual(requests, ["proposal.get"]);
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

test("masked proposal fields show their names and allow single approval", async (t) => {
  const { inbox, click, findAction } = decisionDocument(t);
  const submitted: Methods["proposal.answer"]["params"][] = [];
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        if (method === "proposal.get")
          return {
            ...details(first),
            maskedFields: ["description", "acceptance"],
            modelText: {
              description: "説明の例 ［伏せ字］",
              acceptance: ["条件 ［伏せ字］"],
            },
          } as Methods[M]["result"];
        assert.equal(method, "proposal.answer");
        submitted.push(params as Methods["proposal.answer"]["params"]);
        return { id, ok: true } as Methods[M]["result"];
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
  await settle();
  const chip = inbox.find((node) => node.className.includes("warning-summary"));
  assert.match(chip!.visibleText, /伏せ字あり/);
  assert.ok(chip!.querySelector("svg"));
  assert.equal(
    findAction("approve:goal-registration:proposal")!.disabled,
    false,
  );
  click("detail:goal-registration:proposal");
  const detail = inbox.querySelector(".decision-detail")!;
  assert.match(
    detail.visibleText,
    /説明・受け入れ条件に資格情報らしい文字列があり、伏せています。/,
  );
  assert.match(detail.visibleText, /説明の例 ［伏せ字］/);
  click("detail:goal-registration:proposal");
  click("approve:goal-registration:proposal");
  await settle();
  assert.match(
    inbox.querySelector(".confirm")!.visibleText,
    /伏せ字を含む提案があります。/,
  );
  click("submit-answer");
  await settle();
  assert.deepEqual(submitted, [{ id, digest: first, decision: "approve" }]);
});

test("withheld proposal fields hide approval and batch selection before opening details", async (t) => {
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
  const approve = findAction("approve:goal-registration:proposal")!;
  const checkbox = findAction("choose:goal-registration:proposal")!;
  assert.equal(approve.disabled, true);
  assert.equal(approve.hidden, false);
  assert.equal(checkbox.disabled, true);
  assert.equal(
    findAction("reject:goal-registration:proposal")!.disabled,
    false,
  );
  await settle();
  assert.equal(approve.hidden, true);
  assert.equal(checkbox.hidden, true);
  assert.equal(inbox.querySelector(".decision-detail")!.hidden, true);
  assert.match(
    inbox.visibleText,
    /隠した項目があるため、画面からは承認できません。CLI で内容を確認してください。/,
  );
  assert.match(inbox.visibleText, /非表示の項目は受け入れ条件です/);
  assert.match(inbox.visibleText, /approve proposal/);
  assert.deepEqual(submitted, []);

  click("detail:goal-registration:proposal");
  assert.equal(approve.hidden, true);
  assert.doesNotMatch(inbox.visibleText, /読んだ内容で確定します/);
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
          const { id } = params as Methods["proposal.get"]["params"];
          const proposal = {
            ...details(first),
            id,
            effectivePolicy: "agent",
            ...(submitted.some(
              (answer) => answer.id === id && answer.decision === "approve",
            ) && {
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
  assert.equal(findAction("submit-takeover:approve")?.hidden, true);
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
  await settle();
  click("approve:goal-registration:proposal");
  await settle();
  assert.equal(
    inbox.querySelector(".confirm")?.textContent,
    "「Title」を承認します。戻す承認を確定",
  );
  assert.doesNotMatch(inbox.visibleText, /AI の記述/);
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

test("batch confirmation warns about masked proposals and excludes withheld ones", async (t) => {
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
            ...details(id === "proposal" ? first : second),
            id,
            ...(id === "another" && {
              maskedFields: ["acceptance"],
              modelText: {
                ...details(second).modelText,
                acceptance: ["Pass ［伏せ字］"],
              },
            }),
            ...(id === "withheld" && {
              modelText: {
                ...details(second).modelText,
                acceptance: { withheld: true },
              },
            }),
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
    [row(second, "withheld"), row(first), row(second, "another")],
    () => [],
    () => undefined,
  );
  await settle();
  assert.ok(findAction("choose:goal-registration:withheld")!.hidden);
  for (const id of ["proposal", "another"]) {
    const check = findAction(`choose:goal-registration:${id}`)!;
    assert.equal(check.disabled, false);
    check.checked = true;
    check.dispatchEvent(new Event("change"));
  }
  assert.equal(batch.hidden, false);
  click("approve-batch");
  await settle();
  assert.equal(
    batch.querySelector(".confirm")?.textContent,
    "2 件を承認します。 伏せ字を含む提案があります。戻す承認を確定",
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

function hostDocument(t: TestContext) {
  return decisionDocument(t, [
    "inbox",
    "inbox-notice",
    "now-toggle",
    "now-popover",
    "settings-toggle",
    "settings",
    "host-tabs",
    "connection",
    "settings-back",
    "settings-delegation",
    "settings-display",
    "settings-connection",
    "delegation",
    "display-settings",
    "connection-settings",
    "publish-settings",
    "tab-problems",
    "tab-goals",
    "badge-decisions",
    "badge-problems",
    "badge-goals",
    "connection-update",
    "decisions",
    "problems",
    "goals",
    "goal-content",
    "decision-queue",
    "decision-history-view",
    "decision-history-open",
    "decision-history-back",
    "decision-history",
  ]);
}

test("the popover groups problems and resets confirmations while tracking approved Goal planning", async (t) => {
  const { inbox, click, elements, findAction } = hostDocument(t);
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
  assert.ok(
    byName(pill, "いま。 AI 作業中 1 件、順番待ち 0 件、あなたの番 1 件"),
  );
  assert.equal(elements.get("badge-decisions")!.textContent, "1");
  assert.equal(elements.get("badge-problems")!.textContent, "1");
  pill.dispatchEvent(new Event("click"));
  assert.match(popover.visibleText, /G2-1Running TaskExecutor/);
  assert.match(popover.textContent, /あなたの番（1 件）.*問題（1 件）/);
  assert.deepEqual(
    popover.querySelectorAll(".now-problem").map((node) => node.visibleText),
    ["G10-1README の例を直す予算超過問題を見る ›"],
  );
  click("reject:goal-registration:proposal", popover);
  assert.ok(popover.querySelector(".confirm"));
  assert.equal(host.closeNow(), true);
  assert.equal(document.activeElement, pill);
  pill.dispatchEvent(new Event("click"));
  assert.equal(popover.querySelector(".confirm"), undefined);
  await settle();
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
    assert.equal(area.querySelector(".decision-key-fact"), undefined);
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
    const kind = byName(area, "Task の提案")!;
    assert.equal(kind.title, "Task の提案");
    assert.equal(
      kind.querySelector("svg")?.attributes.get("aria-hidden"),
      "true",
    );
    const goal = byName(area, "Goal G12 Title")!;
    assert.equal(goal.title, "Title");
    assert.equal(goal.visibleText, "G12");
  }
});

test("decision cards load key facts for each kind and show only present exceptions", async (t) => {
  const { inbox, click } = decisionDocument(t);
  const goal = details(first);
  const task: Extract<Proposal, { kind: "task" }> = {
    ...goal,
    kind: "task",
    gate: "task-registration",
    actor: "Executor",
    profile: "base",
    paths: ["guide/start.md", "guide/end.md", "extra/example.md"],
    pathViolations: ["extra/example.md"],
    loosening: ["integration"],
    humanAnswerRequired: true,
  };
  const integration: Extract<Proposal, { kind: "integration" }> = {
    ...goal,
    kind: "integration",
    gate: "integration",
    changedPaths: ["guide/start.md"],
    changedFiles: 1,
    changedLines: 9,
    diffStat:
      "guide/start.md | 9 +++++++--\n1 file changed, 7 insertions(+), 2 deletions(-)",
    reviewExecutionId: "review-example",
    modelText: { verdict: "pass", findings: "目次を確認しました。" },
  };
  const previews = new Map<string, Proposal>([
    ["goal", goal],
    ["task", task],
    ["integration", integration],
    [
      "neutral",
      {
        ...integration,
        diffStat: "guide/start.md | 9 +++++++++",
        modelText: { verdict: "concern", findings: null },
      },
    ],
    [
      "withheld",
      {
        ...goal,
        modelText: {
          description: "説明",
          acceptance: { withheld: true },
        },
      },
    ],
  ]);
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>(
        method: M,
        params: Methods[M]["params"],
      ) {
        assert.equal(method, "proposal.get");
        const key = (params as Methods["proposal.get"]["params"]).id;
        const proposal = previews.get(key);
        if (!proposal) throw new Error("not-found");
        return { ...proposal, id: key } as Methods[M]["result"];
      },
    },
    () => {},
    () => {},
    () => {},
  );
  panel.render(
    ["goal", "task", "integration", "neutral", "withheld", "unavailable"].map(
      (key) => row(first, key),
    ),
    () => [],
    () => undefined,
  );
  const card = (key: string) =>
    inbox
      .find(
        (node) => node.dataset.focusKey === `detail:goal-registration:${key}`,
      )!
      .closest("li")!;
  const keyFact = (key: string) =>
    card(key).querySelector(".decision-key-fact")!;
  assert.ok(keyFact("goal").hidden);
  await settle();
  assert.equal(byName(card("goal"), "Goal の提案")?.title, "Goal の提案");
  assert.ok(byName(keyFact("goal"), "受け入れ条件 1 件"));
  assert.ok(byName(keyFact("goal"), "Task 上限 1"));
  const paths = byName(
    keyFact("task"),
    "対象パス guide/start.md、guide/end.md、extra/example.md",
  )!;
  assert.equal(paths.visibleText, "guide/start.md+2");
  assert.ok(byName(keyFact("integration"), "AI レビュー合格"));
  assert.ok(byName(keyFact("integration"), "1 ファイル"));
  const split = byName(keyFact("integration"), "追加 7 行、削除 2 行")!;
  assert.equal(split.querySelectorAll(".diff-block").length, 5);
  assert.equal(split.querySelectorAll(".removed").length, 2);
  assert.ok(byName(keyFact("neutral"), "AI レビューに懸念あり"));
  assert.equal(
    byName(keyFact("neutral"), "変更 9 行")!.querySelectorAll(".neutral")
      .length,
    5,
  );
  assert.match(
    keyFact("withheld").visibleText,
    /資格情報のような文字列を含むため隠しました/,
  );
  assert.equal(keyFact("unavailable").visibleText, "");
  assert.doesNotMatch(card("unavailable").visibleText, /取得できませんでした/);

  assert.equal(
    card("goal").querySelector(".decision-warnings")!.childElementCount,
    0,
  );
  assert.equal(
    card("integration").querySelector(".decision-warnings")!.childElementCount,
    0,
  );
  assert.match(card("task").visibleText, /範囲外 1/);
  const summaries = card("task").querySelectorAll(".warning-summary");
  assert.equal(summaries[0]?.title, "範囲外のパス\nextra/example.md");
  assert.match(card("task").visibleText, /委任を拡大/);
  assert.match(
    summaries[1]!.title,
    /承認すると、この先の判断を AI に任せる設定が入ります（統合）。/,
  );
  assert.doesNotMatch(
    card("task").visibleText,
    /人の判断が必要|あなたが答える/,
  );
  click("detail:goal-registration:task");
  assert.match(
    card("task").visibleText,
    /範囲外のパスextra\/example\.md.*承認すると/,
  );
  assert.doesNotMatch(card("task").visibleText, /人の判断が必要/);
  const taskConditions = card("task").querySelector(".execution-conditions")!;
  taskConditions.open = true;
  assert.match(taskConditions.visibleText, /人の判断が必要/);
  assert.match(
    card("withheld").visibleText,
    /隠した項目があるため.*approve proposal/,
  );
  assert.ok(card("withheld").querySelector(".decision-menu")!.hidden);
  assert.doesNotMatch(inbox.visibleText, /範囲外のパスなし/);

  click("detail:goal-registration:integration");
  const evidence = card("integration").querySelector(".decision-detail")!;
  assert.match(
    evidence.visibleText,
    /変更パスguide\/start\.md.*目次を確認しました。/s,
  );
  const conditions = evidence.querySelector(".execution-conditions")!;
  assert.equal(conditions.tag, "details");
  assert.equal(conditions.open, false);
  assert.equal(conditions.visibleText, "実行の条件");
  conditions.open = true;
  assert.match(conditions.visibleText, /提案元.*適用ポリシー.*予算/);
  assert.doesNotMatch(conditions.textContent, /変更ファイル数|変更行数/);

  click("detail:goal-registration:goal");
  const goalConditions = card("goal").querySelector(".execution-conditions")!;
  assert.equal(goalConditions.visibleText, "実行の条件");
  goalConditions.open = true;
  assert.match(
    goalConditions.visibleText,
    /実行ロールExecutor.*プロファイルbase.*Task 上限1/,
  );
});

test("focus returns to the disclosure when a refreshed card moves into a closed fold", (t) => {
  const { inbox } = decisionDocument(t);
  const button = new TestElement("button");
  button.dataset.focusKey = "detail:proposal";
  inbox.append(button);
  button.focus();

  const folded = new TestElement("details");
  const summary = new TestElement("summary");
  const moved = new TestElement("button");
  moved.dataset.focusKey = button.dataset.focusKey;
  folded.append(summary, moved);
  restoreFocus(inbox as unknown as HTMLElement, () => {
    inbox.replaceChildren(folded);
    Object.assign(document, { activeElement: null });
  });

  assert.equal(document.activeElement, summary);
});

test("the CLI copy command is in a disclosure and restores focus to its summary", async (t) => {
  const { inbox, click, findAction } = decisionDocument(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        async writeText(command: string) {
          copied.push(command);
        },
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  const panel = createInboxPanel(
    {
      async request<M extends keyof Methods>() {
        return details(first) as Methods[M]["result"];
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
  await settle();
  const menu = inbox.querySelector(".decision-menu")!;
  const summary = findAction("more:goal-registration:proposal")!;
  assert.equal(summary.tag, "summary");
  assert.ok(summary.attributes.get("aria-label"));
  assert.equal(menu.open, false);
  assert.doesNotMatch(inbox.visibleText, /CLI コマンドをコピー/);
  menu.open = true;
  assert.match(menu.visibleText, /CLI コマンドをコピー/);
  click("copy:goal-registration:proposal");
  await settle();
  assert.deepEqual(copied, ["approve proposal"]);
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, summary);
  assert.match(inbox.visibleText, /コピーしました。/);
  assert.doesNotMatch(inbox.visibleText, /approve proposal/);
});

test("decision counts agree across the tab, pill, popover, and Goal list", async (t) => {
  const { inbox, elements, click, findAction } = hostDocument(t);
  const goal = fixtureGoal("goal-1", "G1");
  const waiting = (key: string) => {
    const base = row(first, key);
    assert.ok("answer" in base);
    return {
      ...base,
      answer: {
        ...base.answer,
        title: key,
        approve: false,
        reject: false,
        takeover: true,
      },
    } satisfies PanelInboxItem;
  };
  let rows = [row(first), waiting("AI 例 1"), waiting("AI 例 2")].map(
    (item) => ({
      ...item,
      subject: { ...item.subject, goalId: goal.id, goalRef: goal.ref },
    }),
  );
  const host = createHostPanel({
    socket: { readyState: 1 },
    async request<M extends keyof Methods>(method: M) {
      const result = {
        "inbox.list": rows,
        "goal.list": [goal],
        "activity.get": {
          running: [],
          queued: [],
          queuedCount: 0,
          yourTurn: 3,
        },
        "proposal.get": details(first),
        "environment.status": { state: "disabled" },
      } as Partial<Record<keyof Methods, unknown>>;
      return (result[method] ?? []) as Methods[M]["result"];
    },
  } as unknown as WorkplaceChannel);
  const pill = elements.get("now-toggle")!;
  const popover = elements.get("now-popover")!;
  popover.hidden = true;
  host.connect();
  await settle();
  assert.equal(elements.get("badge-decisions")!.textContent, "1");
  assert.match(
    elements.get("tab-decisions")!.attributes.get("aria-label")!,
    /あなたが答える 1 件、AI が答える予定 2 件/,
  );
  assert.ok(
    byName(pill, "いま。 AI 作業中 0 件、順番待ち 0 件、あなたの番 1 件"),
  );
  assert.match(
    inbox.visibleText,
    /あなたが答える（1 件）.*AI が答える予定（2 件）/,
  );
  assert.equal(inbox.visibleText.match(/あなたが答える/g)?.length, 1);
  assert.doesNotMatch(inbox.visibleText, /AI 例/);
  const ai = inbox.querySelector("details.fold")!;
  assert.equal(ai.open, false);
  assert.equal(ai.querySelectorAll(".ai-pending-card").length, 2);
  assert.match(ai.textContent, /AI が回答予定.*自分で答える/);
  assert.equal(
    ai
      .querySelectorAll("[data-focus-key]")
      .some(({ dataset }) =>
        /^(?:choose|approve|reject):/.test(dataset.focusKey ?? ""),
      ),
    false,
  );

  pill.dispatchEvent(new Event("click"));
  await settle();
  assert.match(
    popover.visibleText,
    /あなたの番（1 件）.*AI が答える予定（2 件）/,
  );
  assert.doesNotMatch(popover.visibleText, /あなたが答える|AI 例/);
  host.closeNow();
  elements.get("tab-goals")!.dispatchEvent(new Event("click"));
  await settle();
  const goals = elements.get("goal-content")!;
  assert.equal(byName(goals, /あなたの番。 判断 1 件/)?.title, "判断 1 件");
  assert.ok(byName(goals, "Task 0 / 0 完了、実行中 0、待機 0、失敗 0"));
  click(`inline:${goal.id}`, goals);
  const inlineCard = findAction(
    "detail:goal-registration:proposal",
    goals,
  )!.closest("article")!;
  assert.match(inlineCard.visibleText, /あなたが答える/);
  assert.doesNotMatch(goals.visibleText, /AI 例/);
  elements.get("tab-decisions")!.dispatchEvent(new Event("click"));
  await settle();

  ai.open = true;
  ai.dispatchEvent(new Event("toggle"));
  rows = rows.slice(1).reverse();
  await host.refresh();
  assert.equal(inbox.querySelector("details.fold")!.open, true);
  assert.equal(elements.get("badge-decisions")!.textContent, "");
  assert.ok(
    byName(pill, "いま。 AI 作業中 0 件、順番待ち 0 件、あなたの番 0 件"),
  );
  pill.dispatchEvent(new Event("click"));
  await settle();
  assert.doesNotMatch(popover.visibleText, /あなたの番|AI 例/);
  assert.match(popover.visibleText, /AI が答える予定（2 件）/);
  assert.equal(popover.querySelector("details.fold")!.open, false);
});

test("AI decision history opens in the decision tab and back restores the link", async (t) => {
  const { elements } = hostDocument(t);
  const history: AgentDecision = {
    id: "history-entry",
    proposalId: "answered-proposal",
    ref: null,
    gate: "task-registration",
    result: "approve",
    at: "2026-11-26T00:00:00Z",
    goalId: null,
    taskId: null,
    goalRef: null,
    taskRef: null,
    setting: { policy: "agent", source: "default" },
    reasons: ["受け入れ条件を確認しました。"],
  };
  const host = createHostPanel({
    socket: { readyState: 1 },
    async request<M extends keyof Methods>(method: M) {
      const result = {
        "inbox.list": [row(first)],
        "decision.history": [history],
        "proposal.get": details(first),
        "activity.get": {
          running: [],
          queued: [],
          queuedCount: 0,
          yourTurn: 1,
        },
        "environment.status": { state: "disabled" },
      } as Partial<Record<keyof Methods, unknown>>;
      return (result[method] ?? []) as Methods[M]["result"];
    },
  } as unknown as WorkplaceChannel);
  const open = elements.get("decision-history-open")!;
  const back = elements.get("decision-history-back")!;
  const queue = elements.get("decision-queue")!;
  const view = elements.get("decision-history-view")!;
  view.hidden = true;
  host.connect();
  await settle();
  assert.equal(open.textContent, "AI が判断したもの（1 件）›");
  assert.equal(queue.hidden, false);
  assert.ok(view.hidden);
  open.dispatchEvent(new Event("click"));
  assert.equal(elements.get("decisions")!.hidden, false);
  assert.ok(queue.hidden);
  assert.equal(view.hidden, false);
  assert.equal(document.activeElement, back);
  assert.ok(byName(elements.get("decision-history")!, "AI が承認"));
  back.dispatchEvent(new Event("click"));
  assert.equal(queue.hidden, false);
  assert.ok(view.hidden);
  assert.equal(document.activeElement, open);
});

test("Goal list folds done Goals and offers inline answers only for human decisions", async (t) => {
  const { click, findAction, elements } = hostDocument(t);
  const active = fixtureGoal("goal-1", "G1");
  const aiOnly = {
    ...fixtureGoal("goal-2", "G2"),
    turn: { owner: "ai", reason: { kind: "queued" } },
  } satisfies GoalDetail;
  const completed = ["3", "4"].map((number): GoalDetail => ({
    ...fixtureGoal(`goal-${number}`, `G${number}`),
    status: "done",
    turn: { owner: "done", reason: { kind: "completed" } },
  }));
  const host = createHostPanel(goalChannel([active, aiOnly, ...completed]));
  host.connect();
  elements.get("tab-goals")!.dispatchEvent(new Event("click"));
  await settle();
  const goals = elements.get("goal-content")!;
  const done = goals.querySelector("details.fold")!;
  assert.equal(done.open, false);
  assert.equal(done.visibleText, "終わった（2 件）");
  done.open = true;
  assert.match(done.visibleText, /G3.*G4/);
  assert.equal(findAction("inline:goal-2", goals), undefined);
  assert.ok(
    findAction("inline:goal-1", goals)?.parent?.querySelector(".human"),
  );
  click("inline:goal-1", goals);
  assert.ok(findAction("detail:goal-registration:human-goal-1", goals));
  assert.equal(
    findAction("takeover:goal-registration:ai-goal-1", goals),
    undefined,
  );
});

test("Workplace preview fixtures render refs, turns, and all Goal tabs", async (t) => {
  const { inbox, elements, click, findAction } = hostDocument(t);
  const methods = createPreviewMethods(
    () => {},
    () => {},
  );
  const host = createHostPanel({
    socket: { readyState: 1 },
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      return methods[method](params);
    },
  } as unknown as WorkplaceChannel);
  const popover = elements.get("now-popover")!;
  popover.hidden = true;
  host.connect();
  await settle();
  const taskCardRefs = (root: TestElement) => {
    const card = findAction("detail:inbox-proposal-filter-task", root)!.closest(
      "li, article",
    )!;
    return card.querySelectorAll(".ref").map(({ textContent }) => textContent);
  };
  assert.deepEqual(taskCardRefs(inbox), ["G1"]);
  elements.get("now-toggle")!.dispatchEvent(new Event("click"));
  await settle();
  assert.deepEqual(taskCardRefs(popover), ["G1"]);
  host.closeNow();

  elements.get("tab-goals")!.dispatchEvent(new Event("click"));
  await settle();
  const goals = elements.get("goal-content")!;
  assert.ok(byName(goals, "PR のマージ"));
  assert.match(goals.visibleText, /PR #12マージできます/);
  const prLink = goals.find(
    (node) => node.tag === "a" && node.textContent === "PR #12",
  )!;
  assert.equal(
    prLink.attributes.get("href"),
    "https://github.com/example/example/pull/12",
  );
  assert.equal(prLink.attributes.get("target"), "_blank");
  assert.equal(prLink.attributes.get("rel"), "noopener noreferrer");
  assert.ok(byName(goals, "チェック中"));
  assert.ok(byName(goals, "チェック失敗"));
  assert.ok(
    findAction("inline:goal-G2", goals)?.parent?.querySelector(".human"),
  );
  assert.equal(findAction("inline:goal-G9", goals), undefined);
  click("goal-G1", goals);
  await settle();
  assert.match(goals.querySelector(".goal-now")!.visibleText, /判断 6 件/);
  assert.deepEqual(taskCardRefs(goals), []);
  for (const [tab, text] of [
    ["delegation", /この Goal の任せ方/],
    ["history", /最近の動き.*統合/],
    ["details", /対象パス.*受け入れ条件/],
  ] as const) {
    click(`goal-tab:${tab}`, goals);
    assert.match(goals.visibleText, text);
  }
  for (const [id, reason] of [
    ["goal-G4", /G4-1 検証の失敗/],
    ["goal-G9", /作業中/],
    ["goal-G6", /手元に書き出し済み/],
    ["goal-G7", /PR #1 · マージ済み/],
  ] as const) {
    click("back-list", goals);
    await settle();
    click(id, goals);
    await settle();
    assert.match(goals.querySelector(".goal-now")!.visibleText, reason);
  }
  elements.get("settings-toggle")!.dispatchEvent(new Event("click"));
  elements.get("settings-connection")!.dispatchEvent(new Event("click"));
  await settle();
  assert.match(
    elements.get("publish-settings")!.visibleText,
    /PR 公開.*有効.*origin.*main.*オフ.*local.json/,
  );
});

test("Goal publishing binds the fresh head and refreshes conflicts before accepting another phrase", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const methods = createPreviewMethods(
    () => {},
    () => {},
  );
  let goal = methods["goal.get"]({ id: "G13" });
  const key = `publish:${goal.id}`;
  const id = goal.id;
  const first = "7".repeat(40);
  const second = "8".repeat(40);
  const requests: Methods["goal.publish"]["params"][] = [];
  const channel = {
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      if (method === "goal.get") return goal as Methods[M]["result"];
      assert.equal(method, "goal.publish");
      const attempt = params as Methods["goal.publish"]["params"];
      requests.push(attempt);
      if (attempt.expectedHead !== goal.publishPreview?.expectedHead)
        throw new Error("publish-stale-head");
      return goal.publish as Methods[M]["result"];
    },
  };
  const root = new TestElement();
  function render(message = "") {
    root.replaceChildren(
      ...(goalPublishPanel(
        channel,
        goal,
        message,
        render,
      ) as unknown as TestElement[]),
    );
  }
  function enter(phrase: string) {
    const input = byName(root, "確認の文言")!;
    input.value = phrase;
    input.dispatchEvent(new Event("input"));
  }
  render();
  assert.equal(findAction(key, root)?.textContent, "もう一度送る");
  assert.ok(findAction(`publish-discard:${id}`, root));
  assert.equal(byName(root, "マージの方式"), undefined);
  assert.match(root.textContent, /クローズ済み/);
  click(key, root);
  await settle();
  assert.equal(findAction(`${key}:confirm`, root)?.disabled, true);
  enter("publish-goal G13 777777777777");
  goal = { ...goal, publishPreview: { expectedHead: second } };
  click(`${key}:confirm`, root);
  await settle();
  assert.match(root.visibleText, /Goal の先端が変更された/);
  assert.equal(findAction(`${key}:confirm`, root), undefined);
  click(key, root);
  await settle();
  enter("publish-goal G13 777777777777");
  assert.equal(findAction(`${key}:confirm`, root)?.disabled, true);
  enter("publish-goal G13 888888888888");
  click(`${key}:confirm`, root);
  await settle();
  assert.deepEqual(requests, [
    {
      id,
      expectedHead: first,
      confirm: "publish-goal G13 777777777777",
      expectedPr: { number: 14, state: "closed" },
    },
    {
      id,
      expectedHead: second,
      confirm: "publish-goal G13 888888888888",
      expectedPr: { number: 14, state: "closed" },
    },
  ]);
});

test("Goal overview shows PR facts, confirms its project method, and limits links", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const methods = createPreviewMethods(
    () => {},
    () => {},
  );
  const channel = {
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      return methods[method](params);
    },
  };
  const root = new TestElement();
  const ready = methods["goal.get"]({ id: "G11" });
  ready.publish.mergeMethod = "merge";
  const render = (detail: GoalDetail) =>
    root.replaceChildren(
      ...(goalPublishPanel(
        channel,
        detail,
        "",
        () => {},
      ) as unknown as TestElement[]),
    );
  render(ready);
  const link = root.find(({ tag }) => tag === "a")!;
  assert.equal(link.attributes.get("href"), ready.publish.prUrl);
  assert.equal(link.attributes.get("target"), "_blank");
  assert.equal(link.attributes.get("rel"), "noopener noreferrer");
  assert.match(
    root.visibleText,
    /最終確認.*チェック.*build.*test.*レビュー承認.*変更3 ファイル\+57−4.*ぶつかりなし/,
  );
  assert.match(root.visibleText, /merge（既定）/);
  assert.equal(
    findAction(`pr-merge:${ready.id}`, root)?.visibleText,
    "マージ（merge）",
  );
  assert.equal(
    findAction(`pr-auto:${ready.id}`, root)?.visibleText,
    "自動マージ",
  );
  assert.equal(
    findAction(`pr-close:${ready.id}`, root)?.visibleText,
    "PR を閉じる",
  );
  const noChecks = {
    ...ready,
    publish: {
      ...ready.publish,
      checks: "none" as const,
      checkRuns: [],
      checkCounts: { pass: 0, pending: 0, fail: 0 },
    },
  };
  render(noChecks);
  assert.ok(
    root.find(
      (node) =>
        node.className === "chip neutral" &&
        node.visibleText === "チェックなし",
    ),
  );
  assert.equal(
    findAction(`pr-merge:${ready.id}`, root)?.className,
    "btn secondary",
  );
  assert.ok(findAction(`pr-auto:${ready.id}`, root));
  click(`pr-merge:${ready.id}`, root);
  assert.match(root.visibleText, /チェックがありません/);
  click(`pr-merge:${ready.id}:cancel`, root);
  render({
    ...ready,
    publish: { ...ready.publish, checks: "unknown", checkRuns: [] },
  });
  assert.match(root.visibleText, /チェックの状態は不明/);
  assert.equal(findAction(`pr-merge:${ready.id}`, root), undefined);
  assert.ok(findAction(`pr-auto:${ready.id}`, root));
  render({
    ...ready,
    publish: { ...ready.publish, prActionOutcome: "unknown" },
    prActions: {},
  });
  assert.match(root.visibleText, /結果を確認中/);
  assert.equal(findAction(`pr-merge:${ready.id}`, root), undefined);
  render(ready);
  const select = byName(root, "マージの方式")!;
  select.value = "rebase";
  select.dispatchEvent(new Event("change"));
  click(`pr-merge:${ready.id}`, root);
  assert.match(
    root.visibleText,
    /PR #12 を rebase でマージします。 チェックは通過しています。/,
  );
  click(`pr-merge:${ready.id}:cancel`, root);
  assert.equal(ready.prState, "open");
  click(`pr-merge:${ready.id}`, root);
  click(`pr-merge:${ready.id}:confirm`, root);
  await settle();
  assert.equal(ready.status, "done");
  render(ready);
  assert.match(root.visibleText, /マージ済み/);
  assert.equal(findAction(`pr-merge:${ready.id}`, root), undefined);

  const failed = methods["goal.get"]({ id: "G12" });
  for (const prUrl of [
    "https://github.com/example/example/issues/13",
    "https://github.com/example/example/pull/14",
    "https://github.com/example/example/pull/13/files",
    "https://github.com/example/example/pull/13?x=1",
    "https://github.com/../example/pull/13",
    "https://github.com.example.org/pull/13",
  ]) {
    render({ ...failed, publish: { ...failed.publish, prUrl } });
    assert.equal(
      root.find(({ tag }) => tag === "a"),
      undefined,
      prUrl,
    );
  }
  render(failed);
  assert.match(root.visibleText, /チェック失敗.*PR を見るPR を閉じる/);
  assert.equal(byName(root, "マージの方式"), undefined);
  click(`pr-close:${failed.id}`, root);
  assert.match(
    root.visibleText,
    /PR #13 を閉じます。Goal は「止まっている」に移ります。/,
  );
  click(`pr-close:${failed.id}:confirm`, root);
  await settle();
  render(failed);
  assert.ok(findAction(`publish-discard:${failed.id}`, root));

  const pending = methods["goal.get"]({ id: "G16" });
  render(pending);
  assert.match(
    root.visibleText,
    /自動マージは使えません（GitHub の設定を確認してください）/,
  );
  assert.equal(findAction(`pr-merge:${pending.id}`, root), undefined);
  assert.equal(
    findAction(`pr-auto:${pending.id}`, root)?.visibleText,
    "自動マージ",
  );

  const armed = methods["goal.get"]({ id: "G18" });
  render(armed);
  assert.match(
    root.visibleText,
    /チェックが通ったら、GitHub が squash でマージします。/,
  );
  assert.equal(
    findAction(`pr-off:${armed.id}`, root)?.visibleText,
    "自動マージを解除",
  );
  assert.equal(findAction(`pr-merge:${armed.id}`, root), undefined);

  render(methods["goal.get"]({ id: "G14" }));
  assert.match(
    root.visibleText,
    /自動マージを解除できない.*GitHub で PR の自動マージを解除/,
  );
});

test("Workplace PR cards use a split menu, confirm the choice, and move armed PRs out of the counts", async (t) => {
  const { inbox, elements, click, findAction } = hostDocument(t);
  const methods = createPreviewMethods(
    () => {},
    () => {},
  );
  methods["goal.get"]({ id: "G11" }).publish.prActionFailure = {
    code: "publish-merge-failed",
    at: "2026-11-28T00:00:00.000Z",
  };
  const host = createHostPanel({
    socket: { readyState: 1 },
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      return methods[method](params);
    },
  } as unknown as WorkplaceChannel);
  const ready = "goal-G11";
  const failed = "goal-G12";
  const pending = "goal-G16";
  const conflict = "goal-G17";
  const armed = "goal-G18";
  const badge = elements.get("badge-decisions")!;
  const pill = elements.get("now-toggle")!;
  elements.get("now-popover")!.hidden = true;
  host.connect();
  await settle();
  assert.equal(badge.textContent, "12");
  assert.match(pill.title, /あなたの番 12 件/);
  assert.ok(byName(inbox, "PR のマージ"));
  assert.ok(byName(inbox, "通過 5"));
  assert.ok(byName(inbox, "GitHub のレビュー 承認"));
  assert.match(inbox.visibleText, /3 ファイル\+57−4/);
  assert.match(inbox.visibleText, /PR をマージできませんでした/);
  assert.equal(
    findAction(`pr-merge:${ready}`, inbox)?.visibleText,
    "マージ（squash）",
  );
  assert.equal(findAction(`pr-close:${ready}`, inbox), undefined);
  click(`pr-method:${ready}`, inbox);
  const menu = byName(inbox, "マージの方式")!;
  assert.equal(menu.attributes.get("role"), "menu");
  const rebase = findAction(`pr-method:${ready}:rebase`, inbox)!;
  assert.equal(rebase.attributes.get("role"), "menuitemradio");
  assert.match(rebase.visibleText, /コミットを main に積み直す/);
  assert.equal(
    findAction(`pr-method:${ready}:squash`, inbox)?.attributes.get(
      "aria-checked",
    ),
    "true",
  );
  click(`pr-method:${ready}:rebase`, inbox);
  assert.equal(menu.hidden, true);
  click(`pr-merge:${ready}`, inbox);
  assert.match(inbox.visibleText, /PR #12 を rebase でマージします。/);
  assert.equal(
    findAction(`pr-merge:${ready}:confirm`, inbox)?.visibleText,
    "マージを確定",
  );
  click(`pr-merge:${ready}:cancel`, inbox);

  assert.match(inbox.visibleText, /チェック失敗 1（test）/);
  assert.match(inbox.visibleText, /main とぶつかっています/);
  assert.equal(findAction(`pr-auto:${failed}`, inbox), undefined);
  assert.equal(findAction(`pr-merge:${conflict}`, inbox), undefined);
  assert.equal(
    findAction(`pr-close:${failed}`, inbox)?.visibleText,
    "PR を閉じる",
  );
  assert.equal(
    findAction(`pr-close:${conflict}`, inbox)?.visibleText,
    "PR を閉じる",
  );

  const waiting = inbox
    .querySelectorAll("details.fold")
    .find((fold) => fold.visibleText.includes("自動マージ待ち"))!;
  assert.equal(waiting.open, false);
  assert.equal(waiting.visibleText, "自動マージ待ち（1 件）");
  waiting.open = true;
  waiting.dispatchEvent(new Event("toggle"));
  assert.match(waiting.visibleText, /G18.*チェック中 1squash解除/);

  assert.match(inbox.visibleText, /チェック中のため、いまはマージできません/);
  click(`pr-method:${pending}`, inbox);
  click(`pr-method:${pending}:merge`, inbox);
  click(`pr-auto:${pending}`, inbox);
  assert.match(
    inbox.visibleText,
    /チェックが通ったら、PR #17 を merge で自動マージします。/,
  );
  click(`pr-auto:${pending}:confirm`, inbox);
  await settle();
  assert.equal(badge.textContent, "11");
  assert.match(pill.title, /あなたの番 11 件/);
  assert.match(inbox.visibleText, /自動マージ待ち（2 件）/);

  click(`pr-off:${armed}`, inbox);
  assert.match(inbox.visibleText, /PR #19 の自動マージを解除します。/);
  click(`pr-off:${armed}:confirm`, inbox);
  await settle();
  assert.equal(badge.textContent, "12");
  assert.match(pill.title, /あなたの番 12 件/);

  elements.get("tab-goals")!.dispatchEvent(new Event("click"));
  await settle();
  const goals = elements.get("goal-content")!;
  assert.equal(findAction(`inline:${pending}`, goals), undefined);
  click(`inline:${ready}`, goals);
  assert.ok(findAction(`pr-merge:${ready}`, goals));
  click(ready, goals);
  await settle();
  click("task-G11-1", goals);
  await settle();
  assert.match(goals.visibleText, /この Task は PR #12 に含まれます/);
  assert.equal(
    goals
      .find((node) => node.tag === "a" && node.textContent === "PR #12")
      ?.attributes.get("rel"),
    "noopener noreferrer",
  );
});

test("Goal overview confirms the PR and commits a manual completion", async (t) => {
  const { click, findAction } = decisionDocument(t);
  const methods = createPreviewMethods(
    () => {},
    () => {},
  );
  const goal = methods["goal.get"]({ id: "G15" });
  const root = new TestElement();
  const key = `complete-after-merge:${goal.id}`;
  const channel = {
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      return methods[method](params);
    },
  };
  const render = () =>
    root.replaceChildren(
      ...(goalPublishPanel(
        channel,
        goal,
        "",
        render,
      ) as unknown as TestElement[]),
    );
  render();
  assert.equal(findAction(key, root)?.textContent, "手で完了にする");
  click(key, root);
  await settle();
  assert.match(root.visibleText, /PR #16 のマージ済みコミット 333333333333/);
  assert.equal(goal.status, "active");
  assert.equal(findAction(`${key}:confirm`, root)?.textContent, "完了を確定");
  click(`${key}:confirm`, root);
  await settle();
  assert.equal(goal.status, "done");
  assert.equal(findAction(key, root), undefined);
});

function fixtureGoal(id: string, ref: string): GoalDetail {
  const proposal = details(first);
  return {
    id,
    ref,
    title: `${ref} の案内を整える`,
    status: "active",
    createdAt: "2026-11-26T00:00:00Z",
    turn: { owner: "human", reason: { kind: "approvals", count: 1 } },
    progress: {
      total: 0,
      done: 0,
      failed: 0,
      running: 0,
      awaitingIntegration: 0,
    },
    estimate: { remainingMs: null, basis: "current-plan" },
    description: "案内の文章を整理します。",
    acceptance: ["作業手順を確認できる。"],
    scope: {
      paths: ["guide/"],
      profiles: ["base"],
      actors: ["Executor"],
      maxTasks: 3,
      budgets: proposal.budgets,
    },
    budgets: proposal.budgets,
    baseCommit: null,
    branch: "lo/goal-preview",
    policyOverrides: { "task-registration": "inherit", integration: "human" },
    publish: {
      enabled: false,
      state: "disabled",
      branch: "ab/goal-preview",
      autoMerge: "off",
      autoMergeSource: "project",
    },
    autoMergeConfirmations: { off: "", squash: "", merge: "", rebase: "" },
    tasks: [],
    timeline: [],
    head: null,
    headAvailable: true,
    exportPreview: null,
    exportBlockReason: null,
  };
}

function goalChannel(goals: GoalDetail[]): WorkplaceChannel {
  const rows = goals.flatMap((goal): PanelInboxItem[] => {
    if (goal.turn.owner === "done") return [];
    const base = row(first, `ai-${goal.id}`);
    assert.ok("answer" in base);
    const subject = { ...base.subject, goalId: goal.id, goalRef: goal.ref };
    return [
      ...(goal.turn.owner === "human"
        ? [
            {
              ...row(first, `human-${goal.id}`),
              subject: { ...subject, proposalId: `human-${goal.id}` },
            },
          ]
        : []),
      {
        ...base,
        subject,
        answer: {
          ...base.answer,
          title: "AI の提案例",
          approve: false,
          reject: false,
          takeover: true,
        },
      },
      {
        id: `recent:${goal.id}`,
        kind: "task-running",
        weight: "info",
        state: "seen",
        subject,
        at: "2026-11-26T00:00:00Z",
        title: "案内を確認",
        next: "",
      },
    ];
  });
  return {
    socket: { readyState: 1 },
    async request<M extends keyof Methods>(
      method: M,
      params: Methods[M]["params"],
    ) {
      const result = {
        "inbox.list": rows,
        "goal.list": goals,
        "goal.get": goals.find(
          (goal) => goal.id === (params as { id?: string }).id,
        ),
        "proposal.get": details(first),
        "activity.get": {
          running: [],
          queued: [],
          queuedCount: 0,
          yourTurn: 1,
        },
        "environment.status": { state: "disabled" },
      } as Partial<Record<keyof Methods, unknown>>;
      return (result[method] ?? []) as Methods[M]["result"];
    },
  } as unknown as WorkplaceChannel;
}

test("Goal details expose accessible tabs and remember the selection for each Goal", async (t) => {
  const { click, findAction, elements } = hostDocument(t);
  const firstGoal = fixtureGoal("goal-1", "G1");
  firstGoal.tasks.push({
    id: "failed-task",
    ref: "G1-1",
    title: "取り込みを検証する",
    status: "failed",
    stage: "failed",
    failureStage: "review",
    verification: true,
    retries: 0,
    attempt: { current: 1, max: 1 },
    elapsedMs: 100,
    estimate: { remainingMs: null, basis: "current-plan" },
  });
  firstGoal.progress = { ...firstGoal.progress, total: 1, failed: 1 };
  firstGoal.timeline.push({
    kind: "integrated",
    ref: "G1-1",
    at: firstGoal.createdAt,
    proposalKind: null,
  });
  const host = createHostPanel(
    goalChannel([firstGoal, fixtureGoal("goal-2", "G2")]),
  );
  const goals = elements.get("goal-content")!;
  host.connect();
  elements.get("tab-goals")!.dispatchEvent(new Event("click"));
  await settle();
  click("goal-1", goals);
  await settle();
  const tab = (key: string) => findAction(`goal-tab:${key}`, goals)!;
  const panel = (key: string) =>
    goals.find(
      (node) => node.attributes.get("aria-labelledby") === tab(key).id,
    )!;
  assert.equal(tab("overview").parent?.attributes.get("role"), "tablist");
  assert.equal(tab("overview").attributes.get("aria-selected"), "true");
  assert.equal(
    tab("overview").attributes.get("aria-controls"),
    panel("overview").id,
  );
  assert.equal(panel("overview").attributes.get("role"), "tabpanel");
  const stepper = byName(panel("overview"), /現在: 失敗（検証）/)!;
  assert.equal(stepper.querySelectorAll(".step").length, 5);
  assert.ok(stepper.querySelector(".failed")?.querySelector("svg"));
  assert.match(stepper.title, /作業 → 検証 → レビュー → 統合 → 完了/);
  assert.match(
    panel("overview").visibleText,
    /いま判断 1 件.*AI が答える予定（1 件）.*Task/,
  );
  assert.doesNotMatch(
    panel("overview").visibleText,
    /AI の提案例|書き出す|ベースを更新する/,
  );

  const right = new Event("keydown", { cancelable: true });
  Object.assign(right, { key: "ArrowRight" });
  tab("overview").dispatchEvent(right);
  assert.ok(right.defaultPrevented);
  assert.equal(document.activeElement, tab("delegation"));
  assert.equal(tab("overview").tabIndex, -1);
  assert.ok(panel("overview").hidden);
  assert.match(panel("delegation").visibleText, /この Goal の任せ方/);

  click("goal-tab:history", goals);
  assert.ok(byName(panel("history"), "開始"));
  assert.ok(byName(panel("history"), "統合"));
  click("goal-tab:details", goals);
  assert.match(
    panel("details").visibleText,
    /対象パスguide\/.*アクターExecutor.*ベースコミット.*説明.*受け入れ条件/,
  );
  assert.ok(panel("history").hidden);

  click("back-list", goals);
  await settle();
  click("goal-2", goals);
  await settle();
  assert.equal(tab("overview").attributes.get("aria-selected"), "true");
  click("back-list", goals);
  await settle();
  click("goal-1", goals);
  await settle();
  assert.equal(tab("details").attributes.get("aria-selected"), "true");
  assert.equal(panel("details").hidden, false);
});

test("each Goal progress segment names its stage and count on hover", (t) => {
  decisionDocument(t);
  const goal = fixtureGoal("goal-progress", "G7");
  const metrics = goalProgress({
    ...goal,
    progress: { ...goal.progress, total: 7, done: 1, running: 3, failed: 1 },
  });
  const titles = Array.from(
    metrics.querySelectorAll<HTMLElement>(".goal-progress-segment"),
    ({ title }) => title,
  );
  assert.deepEqual(titles, [
    "完了 1 件",
    "実行中 3 件",
    "待機 2 件",
    "失敗 1 件",
  ]);
});
