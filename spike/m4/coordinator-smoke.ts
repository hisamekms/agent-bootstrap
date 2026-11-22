import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { seed } from "../m3/integration-smoke.ts";
import { SqliteAudit } from "../../src/audit.ts";
import {
  CoordinatorTask,
  type CoordinatorControl,
  type CoordinatorDriver,
} from "../../src/coordinator.ts";
import { LocalGitIntegration } from "../../src/git-integration.ts";
import { IntegrationJournal } from "../../src/integration-journal.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { uuidPattern } from "../../src/private-journal.ts";
import { ReviewedIntegration } from "../../src/reviewed-integration.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const hello = "hello.txt";
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const command = (shell: string, args: string[] = []) => ({
  argv: ["/bin/sh", "-ec", shell, "fixture", ...args],
  timeoutMs: 8000,
});

// The deterministic fixture makes its choices inside the guest. Host state
// facts are separate from the task text, which the shell reads as data.
const coordinatorCommand = command(`
  test ! -e /workspace/hello.txt
  test ! -e /review/hello.txt
  if (printf reject >> /review/control.json) 2>/dev/null; then exit 9; fi
  context=/review/control.json
  task=$(grep '^  "task":' "$context")
  if printf '%s' "$task" | grep -qi 'plan first' && grep -q '^  "planned": false' "$context"; then
    printf '%s' '{"tool":"delegate","key":"plan","role":"Planner"}'
  elif printf '%s' "$task" | grep -qi 'ask me' && grep -q '^  "answered": false' "$context"; then
    printf '%s' '{"tool":"askHuman","key":"greeting","question":"Which greeting should the Worker use? Enter friendly or formal."}'
  elif grep -q '^  "worked": false' "$context"; then
    printf '%s' '{"tool":"delegate","key":"change","role":"Worker"}'
  elif grep -q '^  "reviewed": false' "$context"; then
    printf '%s' '{"tool":"delegate","key":"review","role":"Reviewer"}'
  else
    printf '%s' '{"tool":"requestIntegration","key":"integrate"}'
  fi
`);

const verifier = command(`
  grep -Exq '(hello|good day) from Worker' /review/candidate.source
  test "$(wc -l < /review/candidate.source)" = 1
  printf '%s' '{"review":"pass"}'
`);

async function operator(prompt: string) {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

async function main() {
  const [mode, binary, argument, expectedId] = process.argv.slice(2);
  const home = process.env.MSB_HOME;
  assert.ok(
    mode === "submit" ||
      mode === "resume" ||
      mode === "status" ||
      mode === "trace" ||
      mode === "answer" ||
      mode === "approve",
  );
  assert.ok(binary && isAbsolute(binary) && home && isAbsolute(home));
  // The optional command-line value is for public smoke fixtures. Interactive
  // task text never enters the shell history or process arguments.
  const submitted =
    mode === "submit" ? (argument ?? (await operator("Task: "))) : undefined;
  const taskId = mode === "submit" ? randomUUID() : argument;
  assert.ok(taskId && uuidPattern.test(taskId));
  const root = join(local, `m4-${taskId}`);
  const repo = join(root, "repository.git");
  const stateDir = join(root, "state");
  const reviewDir = join(root, "review");
  if (mode === "submit") {
    assert.ok(submitted);
    await mkdir(local, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    for (const directory of [repo, stateDir, reviewDir])
      await mkdir(directory, { mode: 0o700 });
    seed(repo);
    console.log(JSON.stringify({ taskId }));
  }
  assert.equal(
    await realpath(root),
    join(await realpath(local), `m4-${taskId}`),
  );
  const git = new LocalGitIntegration({
    binary: "/usr/bin/git",
    repository: repo,
    branch: "main",
    stagingRoot: join(root, "worktrees"),
  });
  const audit = new SqliteAudit(join(root, "audit.sqlite"), {
    readonly: mode === "trace" || mode === "status",
  });
  try {
    const runtime = new MicrosandboxRuntime({
      binary,
      home,
      image,
      stagingRoot: join(root, "sandboxes"),
    });
    const host = new TrustedHost(audit, runtime);
    const reviewJournal = new IntegrationJournal(reviewDir, taskId);
    const flow = (control?: CoordinatorControl) =>
      new ReviewedIntegration(git, host, reviewJournal, {
        path: hello,
        worker: command(
          `
        test "$(cat /workspace/hello.txt)" = "hello from base"
        printf '%s\\n' "$1 from Worker" > /workspace/hello.txt
        printf '%s' '{"tool":"collect"}'
      `,
          [control?.answer === "formal" ? "good day" : "hello"],
        ),
        reviewer: command(`
        if (printf reject >> /review/candidate.source) 2>/dev/null; then exit 9; fi
        grep -Exq '\\+(hello|good day) from Worker' /review/candidate.diff
        grep -Exq '(hello|good day) from Worker' /review/candidate.source
        printf '%s' '{"review":"pass"}'
      `),
        verification: verifier,
      });
    const driver: CoordinatorDriver = {
      step(control, id) {
        const succeeded = (role: string) =>
          control.invocations.some(
            (invocation) =>
              invocation.role === role && invocation.outcome === "ok",
          );
        const bytes = Buffer.from(
          JSON.stringify(
            {
              ...control,
              planned: succeeded("Planner"),
              answered: control.answer !== undefined,
              worked: succeeded("Worker"),
              reviewed: succeeded("Reviewer"),
            },
            null,
            2,
          ),
        );
        return host.runCoordinator(
          {
            sandbox: {
              readOnlyFiles: [{ path: "control.json", bytes }],
              maxLifetimeMs: 30_000,
            },
            command: coordinatorCommand,
          },
          id,
        );
      },
      async delegate(role, control, id) {
        if (role === "Planner") {
          const bytes = await git.snapshot(await git.head(), hello);
          const planned = await host.runPlanner(
            {
              sandbox: {
                readOnlyFiles: [{ path: hello, bytes }],
                maxLifetimeMs: 30_000,
              },
              command: command(`
              test "$(cat /review/hello.txt)" = "hello from base"
              if (printf reject >> /review/hello.txt) 2>/dev/null; then exit 9; fi
              printf '%s' 'Keep one line and preserve the file mode.'
            `),
            },
            id,
          );
          return {
            id: planned.id,
            outcome: planned.outcome === "ok" ? "ok" : "failed",
          };
        }
        if (role === "Worker") {
          // A later Worker delegation revises the reviewed candidate.
          const revising = (await reviewJournal.read()).some(
            (row) => row.kind === "candidate.created",
          );
          if (revising) await flow(control).revise(id);
          else await flow(control).prepareCandidate(id);
          const event = (await reviewJournal.read()).findLast(
            (row) => row.kind === "candidate.authorized",
          );
          assert.ok(event);
          return { id: event.run, outcome: "ok" };
        }
        const result = await flow().reviewCandidate(id);
        const event = (await reviewJournal.read()).at(-1);
        assert.ok(event?.kind === "review.submitted");
        return {
          id: event.run,
          outcome: result.review === "pass" ? "ok" : "failed",
        };
      },
      async reviewedCandidate() {
        return flow().reviewedPin();
      },
      async decide(pin, decision, attempt) {
        const integration = flow();
        await integration.decide(pin, decision);
        return integration.integrate(attempt);
      },
    };
    const task = new CoordinatorTask(stateDir, taskId, driver);
    if (mode === "trace") {
      const coordinator = await task.trace();
      const integration = await reviewJournal.read();
      const ids = new Set(
        [...coordinator, ...integration].flatMap((row) => [
          ...("run" in row ? [row.run] : []),
          ...("invocation" in row ? [row.invocation] : []),
          ...("attempt" in row ? [row.attempt] : []),
        ]),
      );
      console.log(
        JSON.stringify(
          {
            taskId,
            coordinator,
            integration,
            invocations: [...ids]
              .map((id) => audit.read(id))
              .filter((events) => events.length),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (mode === "submit") {
      assert.ok(submitted);
      await task.submit(submitted);
    }
    if (mode === "answer") {
      const { question } = await task.status();
      assert.ok(question && question.id === expectedId);
      console.log(JSON.stringify(question));
      const answer = await operator("Answer (friendly or formal): ");
      assert.ok(answer === "friendly" || answer === "formal");
      await task.answer(question.id, answer);
    }
    if (mode === "approve") {
      const { approval } = await task.status();
      assert.ok(approval?.status === "pending" && approval.id === expectedId);
      const bytes = await git.diff(approval.base, approval.candidate);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        approval.digest,
      );
      console.log(JSON.stringify(approval));
      console.log(
        new TextDecoder().decode(bytes).replace(/[^\x20-\x7e\n]/gu, "?"),
      );
      const answer = await operator(
        `Type approve ${approval.candidate} or reject: `,
      );
      if (answer !== "reject" && answer !== `approve ${approval.candidate}`)
        return;
      console.log(
        JSON.stringify({
          outcome: await task.decide(
            approval.id,
            approval,
            answer === "reject" ? "reject" : "approve",
          ),
        }),
      );
    } else if (mode === "submit" || mode === "resume" || mode === "answer") {
      console.log(JSON.stringify({ outcome: await task.run() }));
    }
    console.log(JSON.stringify({ taskId, ...(await task.status()) }));
  } finally {
    audit.close();
  }
}

try {
  await main();
} catch {
  console.error("M4 smoke stopped. Check the task status or trace.");
  process.exitCode = 1;
}
