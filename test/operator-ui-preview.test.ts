import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { createPreviewMethods } from "../spike/operator-ui/preview-fixtures.ts";
import { startWorkplacePreview } from "../spike/operator-ui/preview.ts";
import { operatorBridgeMethods } from "../src/local-orchestrator/dev-bridge.ts";
import type { PanelAnswer } from "../src/local-orchestrator/proposal-answer.ts";
import {
  isProposal,
  pendingDecisions,
  type Push,
} from "../src/operator-ui/web/protocol.ts";

test("preview fixtures cover Workplace panes and keep answers in memory", () => {
  const pushes: Push[] = [];
  const methods = createPreviewMethods(
    (push) => pushes.push(push),
    () => {},
  );
  const previewBridgeMethods = new Set(operatorBridgeMethods);
  assert.deepEqual(new Set(Object.keys(methods)), previewBridgeMethods);

  const pending = pendingDecisions(methods["inbox.list"]({}));
  const approvals: PanelAnswer[] = [];
  const withheldId = "proposal-withheld";
  for (const row of pending.filter(({ kind }) => kind !== "pr-merge")) {
    assert.ok("answer" in row);
    const { id, digest, takeover } = row.answer;
    const evidence = methods["proposal.get"]({ id });
    assert.ok(isProposal(evidence), id);
    if (id === withheldId) {
      assert.equal(evidence.kind, "task");
      assert.deepEqual(evidence.modelText.description, { withheld: true });
      assert.equal(row.answer.approve, true);
      assert.equal(row.answer.reject, true);
      assert.ok(row.next.includes(id));
    }
    if (id === "proposal-masked") {
      assert.equal(evidence.kind, "task");
      assert.deepEqual(evidence.maskedFields, ["description"]);
      assert.equal(
        evidence.modelText.description,
        "接続例にある ［伏せ字］ を環境変数に置き換えます。",
      );
      assert.doesNotMatch(JSON.stringify(evidence), /sk-ant-/);
    }
    if (row.answer.approve && id !== withheldId)
      approvals.push({ id, digest, decision: "approve" });
    if (takeover) assert.equal(evidence.effectivePolicy, "agent");
  }
  assert.equal(
    pending.filter((row) => "answer" in row && row.answer.takeover).length,
    2,
  );
  assert.equal(pending.length, 14);
  assert.equal(pending.filter(({ kind }) => kind === "pr-merge").length, 4);
  assert.equal(
    methods["inbox.list"]({}).filter(({ kind }) => kind === "pr-auto-merge")
      .length,
    1,
  );
  assert.equal(approvals.length, 6);
  assert.ok(
    methods["proposal.get"]({ id: "proposal-out-of-scope" })
      .humanAnswerRequired,
  );
  assert.ok(
    methods["proposal.get"]({ id: "proposal-loosen-policy" })
      .humanApprovalRequired,
  );
  assert.equal(
    new Set(approvals.map(({ id }) => methods["proposal.get"]({ id }).kind))
      .size,
    3,
  );
  assert.ok(methods["decision.history"]({}).length);

  const goals = methods["goal.list"]({});
  assert.deepEqual(
    new Set(goals.map(({ turn }) => turn.owner)),
    new Set(["human", "ai", "idle", "stopped", "done"]),
  );
  assert.ok(goals.filter(({ turn }) => turn.owner === "done").length > 2);
  for (const { id, turn, publish } of goals) {
    const count = pending.filter(
      (row) =>
        row.subject.goalId === id &&
        "answer" in row &&
        (row.answer.approve || row.answer.reject),
    ).length;
    assert.equal(
      turn.owner === "human",
      count > 0 ||
        (turn.reason.kind === "pr-open" && !publish.autoMergeEnabled),
      id,
    );
    if (count) assert.deepEqual(turn.reason, { kind: "approvals", count });
    const detail = methods["goal.get"]({ id });
    assert.deepEqual(detail.turn, turn);
    assert.deepEqual(detail.publish, publish);
  }
  const detailed = methods["goal.get"]({ id: "G1" });
  assert.deepEqual(detailed.turn, {
    owner: "human",
    reason: { kind: "approvals", count: 6 },
  });
  assert.deepEqual(
    new Set(detailed.timeline.map(({ kind }) => kind)),
    new Set(["approved", "rejected", "integrated"]),
  );
  assert.ok(detailed.tasks.some(({ verification }) => verification));
  assert.ok(detailed.tasks.some(({ failureStage }) => failureStage));
  const concern = methods["proposal.get"]({ id: "proposal-review-concern" });
  assert.equal(concern.kind, "integration");
  assert.equal(concern.modelText.verdict, "concern");
  const completedBefore = detailed.progress.done;
  assert.ok(new Set(detailed.tasks.map(({ stage }) => stage)).size >= 5);
  assert.equal(detailed.policyOverrides["task-registration"], "human");
  const activity = methods["activity.get"]({});
  assert.ok(activity.running.length);
  assert.equal(activity.yourTurn, 16);
  const exportable = methods["goal.get"]({ id: "G5" });
  assert.equal(exportable.turn.reason.kind, "exportable");
  assert.ok(exportable.exportPreview);
  assert.ok(exportable.timeline.some(({ kind }) => kind === "exported"));
  assert.ok(new Set(exportable.tasks.map(({ stage }) => stage)).size >= 3);
  assert.ok(
    methods["problem.list"]({}).some(({ goalId }) => goalId === exportable.id),
  );
  assert.ok(
    methods["inbox.list"]({}).some(
      ({ subject, weight }) =>
        subject.goalId === exportable.id && weight === "info",
    ),
  );
  assert.equal(exportable.policyOverrides.integration, "human");

  const takeoverRow = pending.find(
    (row) => "answer" in row && row.answer.takeover,
  );
  assert.ok(takeoverRow && "answer" in takeoverRow);
  const { id, digest } = takeoverRow.answer;
  assert.throws(
    () => methods["proposal.answer"]({ id, digest, decision: "approve" }),
    { message: "approval-forbidden" },
  );
  assert.deepEqual(
    methods["proposal.answer"]({
      id,
      digest,
      decision: "reject",
      takeover: true,
    }),
    { id, ok: true },
  );
  assert.ok(
    !methods["inbox.list"]({}).some((row) => row.id === takeoverRow.id),
  );

  const withheld = methods["proposal.get"]({ id: withheldId });
  assert.throws(
    () =>
      methods["proposal.answer"]({
        id: withheldId,
        digest: withheld.digest,
        decision: "approve",
      }),
    { message: "write-failed" },
  );
  const outcomes = methods["proposal.answerMany"]({ answers: approvals });
  assert.ok(outcomes.every((outcome) => "ok" in outcome));
  assert.equal(methods["goal.list"]({}).length, goals.length + 1);
  assert.equal(
    methods["goal.get"]({ id: detailed.id }).progress.done,
    completedBefore + 1,
  );
  assert.ok(pushes.some((push) => push.method === "inbox.changed"));

  const [problem] = methods["problem.list"]({});
  assert.ok(problem?.taskId && problem.expectedRetries === 0);
  methods["task.retry"]({
    id: problem.taskId,
    expectedRetries: problem.expectedRetries,
  });
  assert.ok(
    methods["problem.list"]({}).every(
      ({ taskId }) => taskId !== problem.taskId,
    ),
  );
  assert.equal(methods["task.get"]({ id: problem.taskId }).stage, "registered");
});

async function loopbackBlocked() {
  const server = createServer();
  return new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM" || error.code === "EACCES") resolve(true);
      else reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve(false)));
    });
  });
}

test(
  "preview serves the Workplace and answers an authenticated inbox request",
  { timeout: 5000 },
  async (t) => {
    if (await loopbackBlocked()) {
      t.skip("The runtime denies loopback listening");
      return;
    }

    const preview = await startWorkplacePreview(0);
    try {
      const url = new URL(preview.url);
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.search, "");
      assert.match(url.hash, /^#[\da-f]{64}$/);

      const index = await fetch(new URL("/", url), {
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(index.status, 200);
      assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(
        index.headers.get("content-security-policy"),
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      assert.match(
        await index.text(),
        /<script type="module" src="\/app\.js"><\/script>/,
      );
      const script = await fetch(new URL("/app.js", url), {
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(script.status, 200);
      assert.match(
        script.headers.get("content-type") ?? "",
        /^text\/javascript/,
      );
      assert.match(await script.text(), /inbox\.list/);

      const Client = WebSocket as unknown as new (
        url: string,
        options: { headers: { origin: string } },
      ) => WebSocket;
      const socket = new Client(`ws://${url.host}/ws`, {
        headers: { origin: url.origin },
      });
      try {
        const response = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No inbox reply")),
            2000,
          );
          socket.addEventListener(
            "open",
            () => {
              socket.send(JSON.stringify({ token: url.hash.slice(1) }));
              socket.send(
                JSON.stringify({ id: 1, method: "inbox.list", params: {} }),
              );
            },
            { once: true },
          );
          socket.addEventListener(
            "message",
            ({ data }) => {
              clearTimeout(timer);
              try {
                resolve(JSON.parse(data as string));
              } catch (error) {
                reject(error);
              }
            },
            { once: true },
          );
          socket.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(new Error("WebSocket connection failed"));
            },
            { once: true },
          );
        });
        assert.ok(
          response && typeof response === "object" && "result" in response,
        );
        assert.ok(Array.isArray(response.result) && response.result.length);
      } finally {
        socket.close();
      }
    } finally {
      await preview.close();
    }
  },
);
