import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runCli } from "../src/local-orchestrator/cli.ts";
import {
  canonicalJson,
  contentDigest,
} from "../src/local-orchestrator/model.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (filename: string) => {
    query(sql: string): { run(...values: string[]): unknown };
    close(): void;
  };
};

const goal = {
  title: "Release goal",
  description: "Document the build.",
  acceptance: ["The build is documented."],
  scope: {
    paths: ["docs/"],
    profiles: ["base"],
    actors: ["Executor"],
    maxTasks: 3,
    budgets: { maxExecutionMs: 1000, maxRetries: 1, maxTokens: 500 },
  },
  policies: { integration: "agent" },
};
const origin = {
  kind: "actor",
  actor: "Planner",
  executionId: "execution-1",
} as const;

let folder: string;
let filename: string;
let store: OrchestratorStore;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "local-orchestrator-cli-"));
  filename = join(folder, "state.db");
  store = OrchestratorStore.open(filename);
});

afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
});

async function cli(
  args: string[],
  {
    isTTY = false,
    answer,
  }: {
    isTTY?: boolean;
    answer?: (question: string, stdout: string) => string | undefined;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const code = await runCli(["--db", filename, ...args], {
    stdin: process.stdin,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    isTTY,
    prompt(question) {
      questions.push(question);
      return answer?.(question, stdout);
    },
  });
  return { code, stdout, stderr, questions };
}

test("status reports counts and pending gates, and show and proposals include content and origin", async () => {
  const { id, digest } = store.proposeGoal(goal, origin);
  const status = await cli(["status"]);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), {
    counts: { goals: 0, tasks: 0, proposals: 1, pending: 1 },
    pending: [
      {
        id,
        kind: "goal",
        title: goal.title,
        gate: "goal-registration",
        effectivePolicy: "human",
        policySource: "default",
        loosening: ["integration"],
      },
    ],
  });

  const shown = await cli(["show", id]);
  assert.equal(shown.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(shown.stdout), {
    id,
    digest,
    gate: "goal-registration",
    effectivePolicy: "human",
    policySource: "default",
    loosening: ["integration"],
    content: goal,
    origin,
  });
  const pending = await cli(["proposals", "--status", "pending"]);
  assert.equal(pending.code, 0);
  assert.deepEqual(JSON.parse(pending.stdout), [JSON.parse(shown.stdout)]);
  const rejected = await cli(["proposals", "--status", "rejected"]);
  assert.equal(rejected.code, 0);
  assert.deepEqual(JSON.parse(rejected.stdout), []);
});

test("proposal display identifies human requirements under an inherited agent policy", async () => {
  store.setProjectDefaults(
    { "goal-registration": "agent", "task-registration": "agent" },
    { kind: "operator" },
  );
  const proposal = store.proposeGoal(goal, origin);
  const shown = await cli(["show", proposal.id]);
  assert.equal(shown.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(shown.stdout), {
    effectivePolicy: "agent",
    policySource: "default",
    loosening: ["integration"],
    humanApprovalRequired: true,
  });

  const { goalId } = store.decide(proposal.id, {
    digest: proposal.digest,
    decision: "approve",
    answerer: { kind: "human" },
  });
  assert.ok(goalId);
  const task = store.proposeTask(
    {
      goalId,
      title: "Out-of-scope task",
      description: "",
      acceptance: ["Pass"],
      actor: "Executor",
      profile: "base",
      paths: ["src/outside.ts"],
      dependsOn: [],
      budgets: goal.scope.budgets,
      policies: { "task-registration": "human" },
    },
    origin,
  );
  const status = await cli(["status"]);
  assert.equal(status.code, 0);
  assert.partialDeepStrictEqual(JSON.parse(status.stdout), {
    counts: { goals: 1, tasks: 0, proposals: 2, pending: 1 },
    pending: [
      {
        id: task.id,
        gate: "task-registration",
        effectivePolicy: "agent",
        policySource: "default",
        humanAnswerRequired: true,
      },
    ],
  });
});

test("a TTY approval shows the proposal first and records a human answer bound to its digest", async () => {
  const { id, digest } = store.proposeGoal(goal, origin);
  const phrase = `approve ${digest.slice(0, 12)}`;
  const result = await cli(["approve", id], {
    isTTY: true,
    answer(question, stdout) {
      assert.equal(question, `Type "${phrase}" to confirm: `);
      assert.equal(JSON.parse(stdout).digest, digest);
      assert.equal(JSON.parse(stdout).content.description, goal.description);
      return phrase;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(store.getProposal(id)?.status, "approved");
  assert.partialDeepStrictEqual(
    store.listEvents({ subjectId: id, limit: 1 })[0],
    {
      kind: "proposal.decided",
      data: { decision: "approve", digest, answererKind: "human" },
    },
  );
});

test("only an exact confirmation can record a decision, including rejection", async () => {
  const { id, digest } = store.proposeGoal(goal, origin);
  const before = store.listEvents({ limit: 10 });
  const phrase = `reject ${digest.slice(0, 12)}`;
  for (const answer of [` ${phrase}`, `${phrase} `, "yes", undefined]) {
    const result = await cli(["reject", id], {
      isTTY: true,
      answer: () => answer,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Confirmation did not match/);
    assert.equal(store.getProposal(id)?.status, "pending");
    assert.deepEqual(store.listEvents({ limit: 10 }), before);
  }

  const result = await cli(["reject", id], {
    isTTY: true,
    answer: () => phrase,
  });
  assert.equal(result.code, 0);
  assert.equal(store.getProposal(id)?.status, "rejected");
});

test("mutating commands refuse non-TTY input without prompting or writing", async () => {
  const { id, digest } = store.proposeGoal(goal, origin);
  const before = store.listEvents({ limit: 10 });
  for (const args of [
    ["approve", id],
    ["reject", id],
    ["policy", "set", "integration", "agent"],
  ]) {
    const result = await cli(args, {
      answer: () => `approve ${digest.slice(0, 12)}`,
    });
    assert.deepEqual(result, {
      code: 1,
      stdout: "",
      stderr: "This command requires a terminal on stdin and stdout.\n",
      questions: [],
    });
  }
  assert.equal(store.getProposal(id)?.status, "pending");
  assert.deepEqual(store.listEvents({ limit: 10 }), before);
});

test("a change during confirmation fails with the stale digest message", async () => {
  const { id, digest } = store.proposeGoal(goal, origin);
  const before = store.listEvents({ limit: 10 });
  const result = await cli(["approve", id], {
    isTTY: true,
    answer() {
      const changed = { ...goal, title: "Changed while the operator reviewed" };
      const db = new Database(filename);
      try {
        db.query(
          "UPDATE proposals SET content_json = ?, digest = ? WHERE id = ?",
        ).run(canonicalJson(changed), contentDigest(changed), id);
      } finally {
        db.close();
      }
      return `approve ${digest.slice(0, 12)}`;
    },
  });
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "Proposal content changed. Review the proposal again.\n",
  );
  assert.equal(store.getProposal(id)?.status, "pending");
  assert.deepEqual(store.listEvents({ limit: 10 }), before);
});

test("policy set warns about agent approval and requires a confirmed operator update", async () => {
  const args = ["policy", "set", "integration", "agent"];
  const cancelled = await cli(args, { isTTY: true, answer: () => "yes" });
  assert.equal(cancelled.code, 1);
  assert.equal(store.effectivePolicy("integration").policy, "human");
  assert.deepEqual(store.listEvents({ limit: 10 }), []);

  const confirmed = await cli(args, {
    isTTY: true,
    answer(question, stdout) {
      assert.match(stdout, /^Warning: /);
      assert.equal(question, 'Type "set integration agent" to confirm: ');
      return "set integration agent";
    },
  });
  assert.equal(confirmed.code, 0);
  assert.partialDeepStrictEqual(store.listEvents({ limit: 1 })[0], {
    kind: "project.defaults-set",
    subjectId: "project",
  });
  const shown = await cli(["policy", "show"]);
  assert.equal(shown.code, 0);
  assert.deepEqual(JSON.parse(shown.stdout), {
    "goal-registration": "human",
    "task-registration": "human",
    integration: "agent",
  });
});

test("proposal rendering escapes terminal controls and bounds each displayed field", async () => {
  const { id } = store.proposeGoal(
    {
      ...goal,
      // The store rejects control characters in titles but accepts bidi
      // formatting there. Descriptions accept ANSI and other controls.
      title: "Release\u202e\u2066 goal",
      description:
        "\x1b]0;fake title\x07\x1b[31m\u009b\n\r" + "\x1b".repeat(8000),
    },
    origin,
  );
  const shown = await cli(["show", id]);
  assert.equal(shown.code, 0);
  for (const control of ["\x1b", "\x07", "\x9b", "\r", "\u202e", "\u2066"])
    assert.equal(shown.stdout.includes(control), false);
  assert.match(shown.stdout, /Release\\u202e\\u2066 goal/);
  assert.match(
    shown.stdout,
    /\\u001b\]0;fake title\\u0007\\u001b\[31m\\u009b\\n\\r/u,
  );
  assert.match(JSON.parse(shown.stdout).content.description, /…$/u);
  const descriptionLine = shown.stdout
    .split("\n")
    .find((line) => line.includes('"description": '));
  assert.ok(descriptionLine);
  assert.ok(
    descriptionLine.trim().slice('"description": '.length, -1).length <= 4000,
  );

  const status = await cli(["status"]);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /Release\\u202e\\u2066 goal/);
  assert.doesNotMatch(status.stdout, /[\u202e\u2066]/u);
});

test("events filters by subject and limits the newest results", async () => {
  const first = store.proposeGoal(goal, origin);
  store.proposeGoal(goal, origin);
  store.decide(first.id, {
    digest: first.digest,
    decision: "reject",
    answerer: { kind: "human" },
  });
  const result = await cli(["events", "--limit", "1", "--subject", first.id]);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).length, 1);
  assert.partialDeepStrictEqual(JSON.parse(result.stdout)[0], {
    kind: "proposal.decided",
    subjectId: first.id,
  });
  const invalid = await cli(["events", "--limit", "1001"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /^Usage:/);
});
