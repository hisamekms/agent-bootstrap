import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import {
  ContractError,
  contentDigest,
  fitsScope,
  loosens,
  requestedLoosening,
  resolvePolicy,
  validateGoalContent,
  validateTaskContent,
} from "../src/local-orchestrator/model.ts";

const budgets = { maxExecutionMs: 1000, maxRetries: 0, maxTokens: 500 };
const scope = {
  paths: ["src/x/", "README.md"],
  profiles: ["base"],
  actors: ["Executor"],
  maxTasks: 2,
  budgets,
};
const goal = { title: "Goal", description: "", acceptance: ["Pass"], scope };
const task = {
  title: "Task",
  description: "Implement",
  acceptance: ["Pass"],
  goalId: "goal-1",
  actor: "Executor",
  profile: "base",
  paths: ["src/x/a.ts"],
  dependsOn: [],
  budgets,
};

describe("orchestrator contracts", () => {
  test("Bun Executor tasks fit a goal that grants the bun profile", () => {
    const bunGoal = validateGoalContent({
      ...goal,
      scope: { ...scope, profiles: ["bun"] },
    });
    const bunTask = validateTaskContent({ ...task, profile: "bun" });
    assert.deepEqual(bunGoal.scope.profiles, ["bun"]);
    assert.equal(bunTask.profile, "bun");
    assert.deepEqual(fitsScope(bunGoal, bunTask, 0), { ok: true });
  });

  test("rejects malformed goal", () => {
    for (const invalid of [
      undefined,
      null,
      true,
      1,
      [],
      new Date(),
      { ...goal, extra: "secret" },
      { ...goal, title: "" },
      { ...goal, title: "bad\ntext" },
      { ...goal, title: "a".repeat(201) },
      { ...goal, description: "a".repeat(20_001) },
      { ...goal, acceptance: [] },
      { ...goal, acceptance: ["twice", "twice"] },
      { ...goal, acceptance: [false] },
      { ...goal, policies: { "unknown-gate": "agent" } },
      { ...goal, policies: { integration: "automatic" } },
      { ...goal, scope: { ...scope, extra: true } },
      { ...goal, scope: { ...scope, paths: [] } },
      {
        ...goal,
        scope: {
          ...scope,
          paths: Array.from({ length: 65 }, (_, i) => `file-${i}`),
        },
      },
      { ...goal, scope: { ...scope, profiles: ["concierge"] } },
      { ...goal, scope: { ...scope, profiles: ["base", "base"] } },
      { ...goal, scope: { ...scope, actors: ["Concierge"] } },
      { ...goal, scope: { ...scope, actors: ["Planner", "Planner"] } },
      { ...goal, scope: { ...scope, maxTasks: 0 } },
      { ...goal, scope: { ...scope, maxTasks: 1.5 } },
      { ...goal, scope: { ...scope, maxTasks: 1001 } },
    ]) {
      assert.throws(() => validateGoalContent(invalid), new ContractError());
    }
  });

  test("rejects unsafe repository path", () => {
    for (const path of [
      "",
      "/",
      "/src/x",
      "C:/src/x",
      "src\\x",
      "src//x",
      "src/x//",
      "src/./x",
      "src/../x",
      "src/x/..",
      "src/\0x",
    ]) {
      assert.throws(
        () =>
          validateGoalContent({ ...goal, scope: { ...scope, paths: [path] } }),
        ContractError,
      );
      assert.throws(
        () => validateTaskContent({ ...task, paths: [path] }),
        ContractError,
      );
    }
  });

  test("rejects malformed task", () => {
    const sparse = ["first", "second"];
    Reflect.deleteProperty(sparse, "0");
    for (const invalid of [
      { ...task, actor: "Planner" },
      { ...task, profile: "concierge" },
      { ...task, goalId: 1 },
      { ...task, paths: ["a", "a"] },
      { ...task, dependsOn: ["a", "a"] },
      { ...task, dependsOn: sparse },
      { ...task, budgets: { ...budgets, extra: 1 } },
      { ...task, budgets: { ...budgets, maxRetries: -1 } },
      { ...task, budgets: { ...budgets, maxRetries: 11 } },
      { ...task, budgets: { ...budgets, maxExecutionMs: 0 } },
      { ...task, budgets: { ...budgets, maxExecutionMs: 3_600_001 } },
      { ...task, budgets: { ...budgets, maxTokens: 0 } },
      { ...task, budgets: { ...budgets, maxTokens: 10_000_001 } },
      { ...task, budgets: { ...budgets, maxTokens: Infinity } },
      { ...task, budgets: { ...budgets, maxTokens: "1" } },
    ]) {
      assert.throws(() => validateTaskContent(invalid), new ContractError());
    }
  });

  test("requires Executor paths and an empty path list for Researcher", () => {
    assert.throws(
      () => validateTaskContent({ ...task, paths: [] }),
      ContractError,
    );
    assert.throws(
      () => validateTaskContent({ ...task, actor: "Researcher" }),
      ContractError,
    );
    assert.deepEqual(
      validateTaskContent({ ...task, actor: "Researcher", paths: [] }).paths,
      [],
    );
  });

  test("rejects accessors without evaluating them and freezes detached copies", () => {
    let accessed = false;
    const input = {
      ...goal,
      get title() {
        accessed = true;
        return "goal";
      },
    };
    assert.throws(() => validateGoalContent(input), ContractError);
    assert.equal(accessed, false);
    const copy = validateGoalContent({
      ...goal,
      policies: { integration: "human" },
    });
    assert.notEqual(copy.scope.paths, scope.paths);
    for (const value of [
      copy,
      copy.scope,
      copy.scope.paths,
      copy.scope.budgets,
      copy.acceptance,
      copy.policies,
    ]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.equal(Object.isFrozen(validateTaskContent(task).dependsOn), true);
  });

  test("hashes canonical JSON with lexicographically sorted keys and ordered arrays", () => {
    const digest = contentDigest({
      z: [1, { b: true, a: null }],
      "2": 2,
      "10": 10,
    });
    assert.equal(
      digest,
      createHash("sha256")
        .update('{"10":10,"2":2,"z":[1,{"a":null,"b":true}]}')
        .digest("hex"),
    );
    assert.equal(
      digest,
      contentDigest({ "10": 10, z: [1, { a: null, b: true }], "2": 2 }),
    );
    assert.notEqual(
      digest,
      contentDigest({ "10": 10, z: [{ a: null, b: true }, 1], "2": 2 }),
    );
  });

  test("matches whole path segments, distinguishes exact files, and reports each exceeded constraint", () => {
    const approved = validateGoalContent(goal);
    assert.deepEqual(
      fitsScope(
        approved,
        validateTaskContent({
          ...task,
          paths: ["src/x/", "README.md", "src/x/sub/file"],
        }),
        1,
      ),
      { ok: true },
    );
    for (const path of ["src/xy/a.ts", "src/x", "README.md/child"]) {
      assert.deepEqual(
        fitsScope(approved, validateTaskContent({ ...task, paths: [path] }), 0),
        { ok: false, reasons: ["paths"] },
      );
    }
    const outside = validateTaskContent({
      ...task,
      paths: [],
      actor: "Researcher",
      profile: "db",
      budgets: { maxExecutionMs: 1001, maxRetries: 1, maxTokens: 501 },
    });
    assert.deepEqual(fitsScope(approved, outside, 2), {
      ok: false,
      reasons: ["profile", "actor", "maxExecutionMs", "maxRetries", "maxTasks"],
    });
  });

  test("resolves populated policy layers in precedence order and identifies only human-to-agent changes", () => {
    const gate = "integration";
    assert.deepEqual(resolvePolicy(gate, { defaults: {} }), {
      policy: "human",
      source: "default",
    });
    const defaults = { integration: "agent" } as const;
    const request = { integration: "human" } as const;
    const goal = { integration: "agent" } as const;
    const task = { integration: "human" } as const;
    assert.deepEqual(resolvePolicy(gate, { defaults }), {
      policy: "agent",
      source: "default",
    });
    assert.deepEqual(resolvePolicy(gate, { defaults, request }), {
      policy: "human",
      source: "request",
    });
    assert.deepEqual(resolvePolicy(gate, { defaults, request, goal }), {
      policy: "agent",
      source: "goal",
    });
    assert.deepEqual(resolvePolicy(gate, { defaults, request, goal, task }), {
      policy: "human",
      source: "task",
    });
    assert.deepEqual(
      requestedLoosening(
        { defaults, request, goal, task },
        {
          integration: "agent",
          "goal-registration": "agent",
          "task-registration": "human",
        },
      ),
      ["goal-registration", "integration"],
    );
    assert.equal(loosens("agent", "human"), false);
    assert.equal(loosens("agent", "agent"), false);
    assert.equal(loosens("human", "human"), false);
  });
});
