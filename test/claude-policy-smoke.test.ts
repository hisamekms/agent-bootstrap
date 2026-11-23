import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAnswer,
  MAX_ANSWER_BYTES,
  parseAnswer,
  probesFor,
} from "../spike/local-orchestrator/claude-policy-smoke.ts";
const reviewer = probesFor("Reviewer", ["/mnt/review"]);
const worker = probesFor("Worker", ["/mnt/worker"]);
const reviewResults = reviewer.map(({ tool, target, outcome }) => ({
  tool,
  target,
  outcome,
}));
const writeResults = worker.map(({ tool, target, outcome }) => ({
  tool,
  target,
  outcome,
}));
const answer = (results: unknown) => JSON.stringify({ results });

test("the policy smoke accepts each fixed target exactly once", () => {
  assert.deepEqual(
    parseAnswer(answer(reviewResults.toReversed()), reviewer),
    new Map(
      reviewResults.map(({ tool, target, outcome }) => [
        JSON.stringify([tool, target]),
        outcome,
      ]),
    ),
  );
  assert.equal(evaluateAnswer(answer(reviewResults), reviewer).status, "pass");
  assert.equal(evaluateAnswer(answer(writeResults), worker).status, "pass");
});

test("the policy smoke rejects malformed, incomplete or duplicate results", () => {
  for (const raw of [
    "not JSON",
    "```json\n" + answer(reviewResults) + "\n```",
    answer(reviewResults.slice(1)),
    answer([...reviewResults.slice(1), reviewResults[1]]),
    answer([
      { ...reviewResults[0], outcome: "unknown" },
      ...reviewResults.slice(1),
    ]),
    JSON.stringify({ results: reviewResults, extra: "unexpected" }),
  ]) {
    assert.equal(parseAnswer(raw, reviewer), null);
  }
});

test("the policy smoke reports mismatches without configuration values", () => {
  assert.deepEqual(
    evaluateAnswer(
      answer(writeResults.map((item) => ({ ...item, outcome: "allowed" }))),
      worker,
    ),
    {
      status: "fail",
      evidence: "7 tool outcomes differ from the expected policy",
    },
  );
});

test("the policy smoke bounds evidence and discards unexpected data", () => {
  const valid = answer(reviewResults);
  const padding = " ".repeat(MAX_ANSWER_BYTES - Buffer.byteLength(valid));
  assert.notEqual(parseAnswer(valid + padding, reviewer), null);
  assert.equal(parseAnswer(valid + padding + " ", reviewer), null);
  for (const raw of [
    answer([
      { ...reviewResults[0], target: "untrusted content" },
      ...reviewResults.slice(1),
    ]),
    answer([
      { ...reviewResults[0], text: "untrusted content" },
      ...reviewResults.slice(1),
    ]),
    answer([
      { ...reviewResults[0], outcome: "秘密".repeat(MAX_ANSWER_BYTES) },
      ...reviewResults.slice(1),
    ]),
  ]) {
    assert.deepEqual(evaluateAnswer(raw, reviewer), {
      status: "fail",
      evidence: "invalid-answer",
    });
  }
  const reversed = reviewResults.map((item) => ({
    ...item,
    outcome: item.outcome === "allowed" ? "denied" : "allowed",
  }));
  assert.ok(evaluateAnswer(answer(reversed), reviewer).evidence.length < 256);
});

test("mount probes distinguish tools that share a path and cover Executor links", () => {
  for (const probes of [reviewer, worker]) {
    for (const tool of ["Grep", "Edit"])
      assert.ok(
        probes.some(
          (probe) =>
            probe.tool === tool &&
            probe.target.startsWith("/mnt/") &&
            probe.outcome === "denied",
        ),
      );
  }
  for (const tool of ["Read", "Write"])
    assert.ok(
      worker.some(
        (probe) =>
          probe.tool === tool &&
          probe.target.startsWith("/workspace/policy-smoke-link-0/") &&
          probe.outcome === "denied",
      ),
    );
  const grep = reviewResults.findIndex(({ tool }) => tool === "Grep");
  const mismatched = reviewResults.map((result, index) =>
    index === grep && result.target === "/mnt/review"
      ? { ...result, tool: "Glob" }
      : result,
  );
  assert.equal(parseAnswer(answer(mismatched), reviewer), null);
});
