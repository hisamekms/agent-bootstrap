import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CoordinatorTask,
  type CoordinatorControl,
  type CoordinatorDriver,
} from "../src/coordinator.ts";

const pin = {
  base: "a".repeat(40),
  candidate: "b".repeat(40),
  digest: "c".repeat(64),
};
const ask = {
  tool: "askHuman",
  key: "ask",
  question: "Which greeting should the Worker use?",
};
const worker = { tool: "delegate", key: "worker", role: "Worker" };
const review = { tool: "delegate", key: "review", role: "Reviewer" };
const integration = { tool: "requestIntegration", key: "integration" };

async function fixture(
  t: { after(cleanup: () => Promise<void>): void },
  actions: object[],
  overrides: Partial<CoordinatorDriver> = {},
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "bootstrap-coordination-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = randomUUID();
  const remaining = [...actions];
  const roles: string[] = [];
  const inputs: CoordinatorControl[] = [];
  const driver: CoordinatorDriver = {
    async step(control, id) {
      inputs.push(control);
      return {
        id,
        response: Buffer.from(
          JSON.stringify(remaining.shift() ?? { done: true }),
        ),
      };
    },
    async delegate(role, _control, id) {
      roles.push(role);
      return { id, outcome: "ok" };
    },
    async reviewedCandidate() {
      return pin;
    },
    async decide(_pin, decision) {
      return decision === "approve" ? "completed" : "denied";
    },
    ...overrides,
  };
  const reopen = () => new CoordinatorTask(root, taskId, driver);
  const task = reopen();
  await task.submit("Change the greeting in hello.txt.");
  return { task, reopen, roles, inputs };
}

test("an answered question resumes the same request after reopening and can reach pinned approval", async (t) => {
  const { task, reopen, roles, inputs } = await fixture(t, [
    { tool: "delegate", key: "plan", role: "Planner" },
    ask,
    worker,
    review,
    integration,
  ]);
  assert.equal(await task.run(), "paused");
  const { question } = await task.status();
  assert.ok(question);
  assert.deepEqual(roles, ["Planner"]);
  const fresh = reopen();
  assert.equal(await fresh.run(), "paused");
  assert.equal((await fresh.status()).question?.id, question.id);
  await assert.rejects(fresh.answer(randomUUID(), "formal"));
  await fresh.answer(question.id, "formal");
  await assert.rejects(fresh.answer(question.id, "friendly"));
  assert.equal(await reopen().run(), "paused");
  assert.deepEqual(roles, ["Planner", "Worker", "Reviewer"]);
  assert.equal(inputs[2]?.answer, "formal");
  assert.equal(inputs[2]?.answerRequestId, question.id);
  const { approval } = await fresh.status();
  assert.ok(approval);
  await assert.rejects(
    fresh.decide(approval.id, { ...pin, base: "d".repeat(40) }, "approve"),
  );
  assert.equal(await fresh.decide(approval.id, pin, "approve"), "completed");
  assert.equal(await reopen().run(), "done");
  assert.equal((await fresh.status()).approval?.status, "completed");
  assert.doesNotMatch(
    JSON.stringify(await fresh.trace()),
    /Which greeting|Change the greeting|formal/,
  );
});

test("Coordinator can skip Planner, and replay of a delegation key does not rerun it", async (t) => {
  const { task, roles, reopen } = await fixture(t, [
    worker,
    worker,
    review,
    integration,
  ]);
  assert.equal(await task.run(), "paused");
  assert.deepEqual(roles, ["Worker", "Reviewer"]);
  assert.ok(
    (await task.trace()).some((event) => event.kind === "tool.replayed"),
  );
  const { approval } = await task.status();
  assert.ok(approval);
  assert.equal(await task.decide(approval.id, pin, "reject"), "denied");
  assert.equal(await reopen().run(), "denied");
});

test("forged tool and conflicting idempotency key are rejected", async (t) => {
  for (const actions of [
    [{ tool: "approve", key: "bad" }],
    [worker, { ...review, key: worker.key }],
  ]) {
    const { task, roles } = await fixture(t, actions);
    assert.equal(await task.run(), "denied");
    assert.equal(roles.length, actions.length - 1);
  }
});

test("an interrupted delegation persists its attempt identity and is never replayed", async (t) => {
  let count = 0;
  let attempt: string | undefined;
  const { task, reopen } = await fixture(t, [worker], {
    async delegate(_role, _control, id) {
      count++;
      attempt = id;
      throw new Error("fixture interruption");
    },
  });
  await assert.rejects(task.run(), /fixture interruption/);
  const tail = (await reopen().trace()).at(-1);
  assert.equal(tail?.kind, "tool.authorized");
  assert.equal(tail?.kind === "tool.authorized" && tail.attempt, attempt);
  assert.equal(await reopen().run(), "uncertain");
  assert.equal(count, 1);
});

test("concurrent approval is applied once and an ambiguous outcome survives reopening", async (t) => {
  let count = 0;
  const { task, reopen } = await fixture(t, [worker, review, integration], {
    async decide() {
      count++;
      return "uncertain";
    },
  });
  await task.run();
  const { approval } = await task.status();
  assert.ok(approval);
  const raced = await Promise.allSettled([
    task.decide(approval.id, pin, "approve"),
    reopen().decide(approval.id, pin, "approve"),
  ]);
  assert.equal(
    raced.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(count, 1);
  assert.equal(await reopen().run(), "uncertain");
});

test("the task stops at its event limit before starting another sandbox", async (t) => {
  let calls = 0;
  const { task, reopen } = await fixture(t, [], {
    async step(_control, id) {
      const key = `status-${calls++}`;
      return {
        id,
        response: Buffer.from(JSON.stringify({ tool: "getStatus", key })),
      };
    },
  });
  for (let batch = 0; batch < 4; batch++)
    assert.equal(await reopen().run(), "limit");
  assert.equal(calls, 31);
  assert.equal(await reopen().run(), "limit");
  assert.equal(calls, 31);
  assert.equal((await task.trace()).at(-1)?.kind, "query.finished");
});

test("a Worker can revise only after a failed review, and integration needs a passing review of the latest candidate", async (t) => {
  const reviews = ["failed", "ok"] as const;
  const revise = { tool: "delegate", key: "revise-1", role: "Worker" };
  const reviewAgain = { tool: "delegate", key: "review-2", role: "Reviewer" };
  const { task, roles } = await fixture(
    t,
    [worker, review, revise, reviewAgain, integration],
    {
      async delegate(role, _control, id) {
        roles.push(role);
        return {
          id,
          outcome:
            role === "Reviewer"
              ? (reviews[roles.filter((r) => r === "Reviewer").length - 1] ??
                "ok")
              : "ok",
        };
      },
    },
  );
  assert.equal(await task.run(), "paused");
  assert.deepEqual(roles, ["Worker", "Reviewer", "Worker", "Reviewer"]);
  assert.ok((await task.status()).approval);
});

test("revision rules deny out-of-order delegations", async (t) => {
  const failing = {
    async delegate(role: string, _control: unknown, id: string) {
      return {
        id,
        outcome: role === "Reviewer" ? ("failed" as const) : ("ok" as const),
      };
    },
  };
  for (const [actions, overrides, ran] of [
    // A second Worker after a passing review.
    [[worker, review, { ...worker, key: "again" }], {}, 2],
    // A second review of the same candidate.
    [[worker, review, { ...review, key: "again" }], {}, 2],
    // Integration after a failed review.
    [[worker, review, integration], failing, 2],
    // Integration when the latest candidate has not been reviewed.
    [[worker, review, { ...worker, key: "revise" }, integration], failing, 3],
  ] as const) {
    let count = 0;
    const { task } = await fixture(t, [...actions], {
      ...overrides,
      async delegate(role, control, id) {
        count++;
        return "delegate" in overrides
          ? (overrides as typeof failing).delegate(role, control, id)
          : { id, outcome: "ok" };
      },
    });
    assert.equal(await task.run(), "denied");
    assert.equal((await task.trace()).at(-1)?.kind, "tool.denied");
    assert.equal(count, ran);
  }
  // Revisions stop at the cap: 1 + MAX_REVISIONS Worker candidates.
  const { MAX_REVISIONS } = await import("../src/integration-journal.ts");
  const loop = [worker, review];
  for (let round = 1; round <= MAX_REVISIONS + 1; round++)
    loop.push(
      { tool: "delegate", key: `revise-${round}`, role: "Worker" },
      { tool: "delegate", key: `review-${round}`, role: "Reviewer" },
    );
  let workers = 0;
  const { task } = await fixture(t, loop, {
    async delegate(role, _control, id) {
      if (role === "Worker") workers++;
      return { id, outcome: role === "Reviewer" ? "failed" : "ok" };
    },
  });
  let outcome = await task.run();
  while (outcome === "limit") outcome = await task.run();
  assert.equal(outcome, "denied");
  assert.equal(workers, 1 + MAX_REVISIONS);
});

test("failed Worker runs also count toward the revision cap", async (t) => {
  const { MAX_REVISIONS } = await import("../src/integration-journal.ts");
  const attempts = Array.from({ length: MAX_REVISIONS + 3 }, (_, index) => ({
    tool: "delegate",
    key: `worker-${index}`,
    role: "Worker",
  }));
  let started = 0;
  const { task } = await fixture(t, attempts, {
    async delegate(_role, _control, id) {
      started++;
      return { id, outcome: "failed" };
    },
  });
  assert.equal(await task.run(), "denied");
  assert.equal(started, 1 + MAX_REVISIONS);
});
