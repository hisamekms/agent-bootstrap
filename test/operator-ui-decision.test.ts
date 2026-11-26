import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createInboxPanel } from "../src/operator-ui/web/panel.ts";
import type {
  Methods,
  PanelInboxItem,
  Proposal,
} from "../src/operator-ui/web/protocol.ts";

class TestElement extends EventTarget {
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  parent: TestElement | undefined;
  className = "";
  disabled = false;
  private text = "";

  get textContent(): string {
    return this.text + this.children.map((node) => node.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  append(...children: TestElement[]) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }

  prepend(...children: TestElement[]) {
    for (const child of children) child.parent = this;
    this.children.unshift(...children);
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
  }

  find(predicate: (node: TestElement) => boolean): TestElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
  }

  querySelector(selector: string) {
    return this.find((node) =>
      node.className.split(" ").includes(selector.slice(1)),
    );
  }

  setAttribute() {}
  focus() {}
}

function decisionDocument(t: TestContext) {
  const elements = new Map(
    [
      "inbox-items",
      "answer-batch",
      "answer-results",
      "empty-inbox",
      "tab-decisions",
    ].map((id) => [id, new TestElement()]),
  );
  const document = {
    activeElement: null,
    getElementById: (id: string) => elements.get(id),
    createElement: () => new TestElement(),
    createTextNode(text: string) {
      const node = new TestElement();
      node.textContent = text;
      return node;
    },
  };
  for (const [key, value] of Object.entries({
    document,
    HTMLElement: TestElement,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const inbox = elements.get("inbox-items")!;
  const findAction = (key: string) =>
    inbox.find(({ dataset }) => dataset.focusKey === key);
  function click(key: string) {
    const node = findAction(key);
    assert.ok(node && !node.disabled);
    node.dispatchEvent(new Event("click"));
  }
  return { inbox, findAction, click };
}

const id = "proposal";
const first = "a".repeat(64);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function details(digest: string): Extract<Proposal, { kind: "goal" }> {
  return {
    id,
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

function row(digest: string): PanelInboxItem {
  return {
    id: "goal-registration:proposal",
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
  click("submit-answer");
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
  click("reject:goal-registration:proposal");
  click("submit-answer");
  await settle();
  assert.deepEqual(submitted, [{ id, digest: first, decision: "reject" }]);
});
