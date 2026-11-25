import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveDelegation,
  ruleMatches,
  validateDelegationRules,
  type DelegationRule,
  type RuleFacts,
} from "../src/local-orchestrator/delegation.ts";
import { ContractError } from "../src/local-orchestrator/model.ts";
import {
  moveRule,
  orderedRules,
  ruleChangeCanWiden,
  settingLabel,
} from "../src/operator-ui/web/protocol.ts";

const small: DelegationRule = {
  id: "small",
  name: "Small changes",
  gate: "integration",
  action: "agent",
  enabled: true,
  order: 0,
  conditions: { maxChangedLines: 10, maxChangedFiles: 2 },
};

test("delegation resolves invariant, Task, Goal, first enabled matching rule, then default", () => {
  const facts = {
    paths: ["docs/a.md"],
    diffSize: { changedLines: 2, changedFiles: 1 },
  };
  const options = {
    task: "agent",
    goal: "human",
    rules: [
      { ...small, id: "disabled", enabled: false, action: "human" },
      small,
      { ...small, id: "last", action: "human" },
    ] as DelegationRule[],
    facts,
    fallback: { policy: "human", source: "default" },
  } as const;
  assert.deepEqual(
    resolveDelegation("integration", {
      ...options,
      invariant: "integration-symlinks",
    }),
    {
      policy: "human",
      source: "invariant",
      invariant: "integration-symlinks",
    },
  );
  assert.deepEqual(resolveDelegation("integration", options), {
    policy: "agent",
    source: "operator-task",
  });
  assert.deepEqual(
    resolveDelegation("integration", { ...options, task: "rule" }),
    {
      policy: "human",
      source: "operator-goal",
    },
  );
  assert.deepEqual(
    resolveDelegation("integration", {
      ...options,
      task: "rule",
      goal: "inherit",
    }),
    {
      policy: "agent",
      source: "rule",
      ruleId: small.id,
      ruleName: small.name,
    },
  );
  assert.deepEqual(
    resolveDelegation("integration", {
      ...options,
      task: "rule",
      goal: "inherit",
      facts: { paths: facts.paths },
    }),
    options.fallback,
  );
  assert.deepEqual(
    resolveDelegation("goal-registration", options),
    options.fallback,
  );
});

test("Task registration rules check paths, exclusions, budget and the optional category", () => {
  const [rule] = validateDelegationRules([
    {
      ...small,
      gate: "task-registration",
      conditions: {
        pathsWithin: ["docs/**", "README.*"],
        pathsExclude: ["docs/**/private.*"],
        maxTokens: 200,
        categories: ["docs"],
      },
    },
  ]);
  const facts: RuleFacts = {
    paths: ["README.md", "docs/notes/a.md"],
    maxTokens: 200,
    category: "docs",
  };
  assert.equal(ruleMatches(rule!, facts), true);
  for (const wrong of [
    { ...facts, paths: ["src/a.ts"] },
    { ...facts, paths: ["docs/private.md"] },
    { ...facts, paths: ["docs/deep/private.md"] },
    { ...facts, paths: ["docs/"] },
    { ...facts, paths: ["README/a.md"] },
    { ...facts, paths: [] },
    { ...facts, maxTokens: 201 },
    { ...facts, category: undefined },
    { ...facts, category: "feature" as const },
  ])
    assert.equal(ruleMatches(rule!, wrong), false);

  assert.equal(
    ruleMatches(
      { ...rule!, conditions: { pathsWithin: ["docs/*"] } },
      { paths: ["docs/guides/"] },
    ),
    false,
  );
  assert.equal(
    ruleMatches(
      { ...rule!, conditions: { pathsWithin: ["docs/**"] } },
      { paths: ["docs/guides/"] },
    ),
    true,
  );
  assert.equal(
    ruleMatches(
      { ...rule!, conditions: { pathsExclude: ["private/**"] } },
      { paths: ["docs/guides/"] },
    ),
    true,
  );
});

test("path exclusions ignore case and Unicode composition while allowed globs match exactly", () => {
  const composed = "src/café";
  const decomposed = composed.normalize("NFD");
  for (const pattern of [
    "src/secret/**",
    `${composed}/**`,
    `${decomposed}/**`,
  ]) {
    const [rule] = validateDelegationRules([
      { ...small, conditions: { pathsExclude: [pattern] } },
    ]);
    const path = pattern.startsWith("src/secret")
      ? "src/Secret/a"
      : `${composed.toUpperCase()}/a`;
    for (const variant of [path, path.normalize("NFD")])
      assert.equal(ruleMatches(rule!, { paths: [variant] }), false);
    assert.equal(ruleMatches(rule!, { paths: ["src/public/a"] }), true);
  }
  const [within] = validateDelegationRules([
    { ...small, conditions: { pathsWithin: [`${composed}/**`] } },
  ]);
  assert.equal(ruleMatches(within!, { paths: [`${composed}/a`] }), true);
  for (const path of [decomposed, composed.toUpperCase()])
    assert.equal(ruleMatches(within!, { paths: [`${path}/a`] }), false);

  const [unicode] = validateDelegationRules([
    { ...small, conditions: { pathsExclude: ["src/οσ*middle*.txt"] } },
  ]);
  for (const path of ["src/ος-MIDDLE-end.TXT", "src/ΟΣmiddle.txt"])
    assert.equal(ruleMatches(unicode!, { paths: [path] }), false);
  for (const path of ["src/ος-middleXtxt", "src/ος-mid.txt"])
    assert.equal(ruleMatches(unicode!, { paths: [path] }), true);
});

test("integration rule size limits use actual facts and fail closed for unknown counts", () => {
  const facts = {
    paths: ["docs/a.md"],
    diffSize: { changedLines: 10, changedFiles: 2 },
  };
  assert.equal(ruleMatches(small, facts), true);
  assert.equal(ruleMatches(small, { paths: facts.paths }), false);
  assert.equal(
    ruleMatches(small, {
      ...facts,
      diffSize: { changedLines: null, changedFiles: 2 },
    }),
    false,
  );
  assert.equal(
    ruleMatches(small, {
      ...facts,
      diffSize: { changedLines: 11, changedFiles: 2 },
    }),
    false,
  );
  assert.equal(
    ruleMatches(small, {
      ...facts,
      diffSize: { changedLines: 9, changedFiles: 3 },
    }),
    false,
  );
  assert.equal(
    ruleMatches(
      { ...small, conditions: { maxChangedFiles: 2 } },
      { ...facts, diffSize: { changedLines: null, changedFiles: 2 } },
    ),
    true,
  );
});

test("rule validation rejects category-only, gate mismatches, unsafe patterns and invalid list shapes", () => {
  for (const conditions of [
    {},
    { categories: ["docs"] },
    { maxTokens: 1 },
    { maxChangedLines: -1 },
    { maxChangedFiles: 1.5 },
    { maxChangedLines: 1, categories: ["unknown"] },
    { pathsExclude: [] },
    { pathsWithin: ["docs/*", "docs/*"] },
    ...[
      "/docs",
      "C:/docs",
      "docs/../src",
      "docs/**x",
      "docs/[abc]",
      "docs/{a,b}",
      "docs//a",
      "docs/",
    ].map((pattern) => ({ pathsWithin: [pattern] })),
  ])
    assert.throws(
      () => validateDelegationRules([{ ...small, conditions }]),
      ContractError,
    );
  for (const rules of [
    [{ ...small, gate: "goal-registration" }],
    [{ ...small, order: 1 }],
    [small, { ...small, order: 1 }],
    [small, { ...small, id: "other" }],
    Array.from({ length: 51 }, (_, order) => ({
      ...small,
      id: String(order),
      order,
    })),
  ])
    assert.throws(() => validateDelegationRules(rules), ContractError);
});

test("panel rule helpers keep order, strip hit counts and flag widening edits", () => {
  const human = { ...small, id: "human", action: "human", order: 0 } as const;
  const agent = { ...small, order: 1 };
  const before = [human, agent];
  const swapped = moveRule(before, 1, -1);
  assert.deepEqual(
    swapped.map(({ id, order }) => [id, order]),
    [
      [small.id, 0],
      [human.id, 1],
    ],
  );
  assert.equal(ruleChangeCanWiden(before, swapped), true);
  assert.equal(ruleChangeCanWiden(swapped, before), false);
  assert.equal(
    ruleChangeCanWiden(before, [human, { ...agent, enabled: false }]),
    false,
  );
  assert.equal(ruleChangeCanWiden([human], before), true);
  assert.equal(ruleChangeCanWiden([human], []), true);
  assert.equal(ruleChangeCanWiden([], [human]), false);
  assert.equal(
    ruleChangeCanWiden(before, [
      human,
      { ...agent, conditions: { maxChangedFiles: 2, maxChangedLines: 10 } },
    ]),
    false,
  );
  const settingsRow = { ...small, hitsLast7Days: 12 };
  assert.deepEqual(orderedRules([settingsRow]), [small]);
  assert.equal(
    settingLabel({ policy: "agent", source: "rule", ruleName: small.name }),
    "ルール「Small changes」",
  );
});
