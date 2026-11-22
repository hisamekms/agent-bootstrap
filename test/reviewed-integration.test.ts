import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seed } from "../spike/m3/integration-smoke.ts";
import { SqliteAudit } from "../src/audit.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { IntegrationJournal } from "../src/integration-journal.ts";
import { ReviewedIntegration } from "../src/reviewed-integration.ts";
import type { SandboxRuntime } from "../src/sandbox-runtime.ts";
import { TrustedHost } from "../src/trusted-host.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "bootstrap-integration-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo.git");
  const journalDir = join(root, "events");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(journalDir, { mode: 0o700 });
  seed(repository);
  const config = {
    binary: "/usr/bin/git",
    repository,
    stagingRoot: join(root, "worktrees"),
    branch: "main",
  };
  const git = new LocalGitIntegration(config);
  const audit = new SqliteAudit(join(root, "audit.sqlite"));
  t.after(async () => {
    audit.close();
  });
  const calls: string[] = [];
  const changed = Buffer.from("hello from Worker\n");
  const runtime: SandboxRuntime = {
    async create(spec) {
      const id = randomUUID();
      if (spec.readOnlyFiles?.length) {
        assert.equal(spec.files, undefined);
        assert.equal(spec.readOnlyFiles[0]?.path, "candidate.diff");
        assert.deepEqual(spec.readOnlyFiles[1]?.bytes, changed);
      } else {
        assert.equal(spec.files?.[0]?.path, "hello.txt");
      }
      return { id };
    },
    async exec(_handle, command) {
      const entry = command.argv[0];
      assert.ok(entry);
      calls.push(entry);
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.from(
          entry === "worker"
            ? '{"tool":"collect"}'
            : entry === "revise"
              ? '{"review":"revise"}'
              : '{"review":"pass"}',
        ),
        stderr: new Uint8Array(),
      };
    },
    async collect() {
      return { files: [{ path: "hello.txt", bytes: changed }] };
    },
    async destroy() {},
  };
  const journal = new IntegrationJournal(journalDir, randomUUID());
  const plan = {
    path: "hello.txt",
    worker: { argv: ["worker"], timeoutMs: 123 },
    reviewer: { argv: ["reviewer"], timeoutMs: 123 },
    verification: { argv: ["verify"], timeoutMs: 123 },
  };
  const host = new TrustedHost(audit, runtime);
  const flow = new ReviewedIntegration(git, host, journal, plan);
  return { flow, plan, git, config, journal, journalDir, host, audit, calls };
}

test("approval binds one candidate, the target and the verifier, and applies once", async (t) => {
  const { flow, plan, git, config, journal, host, calls, audit } =
    await fixture(t);
  const pin = await flow.prepare();
  assert.equal(pin.review, "pass");
  assert.equal(await git.head(), pin.base);
  await assert.rejects(
    flow.decide({ ...pin, digest: "a".repeat(64) }, "approve"),
  );
  const wrongTarget = new ReviewedIntegration(
    new LocalGitIntegration({ ...config, branch: "other" }),
    host,
    journal,
    plan,
  );
  await assert.rejects(wrongTarget.decide(pin, "approve"), /incomplete/);
  await flow.decide(pin, "approve");
  plan.verification.argv[0] = "changed-verifier";
  const results = await Promise.allSettled([
    flow.integrate(),
    flow.integrate(),
  ]);
  assert.equal(
    results.filter(
      (value) => value.status === "fulfilled" && value.value === "completed",
    ).length,
    1,
  );
  assert.equal(await git.head(), pin.candidate);
  assert.deepEqual(calls, ["worker", "reviewer", "verify"]);
  const events = await journal.read();
  assert.equal(events.at(-1)?.kind, "integration.completed");
  const recordedReview = events.find(
    (event) => event.kind === "review.submitted",
  );
  assert.ok(recordedReview);
  assert.equal(audit.read(recordedReview.run).at(-1)?.role, "Reviewer");
  await assert.rejects(flow.integrate(), /already been attempted/);
});

test("a new base after approval is rejected without another ref update", async (t) => {
  const { flow, git, journal, calls } = await fixture(t);
  const pin = await flow.prepare();
  await flow.decide(pin, "approve");
  const external = await git.createCandidate(
    pin.base,
    "hello.txt",
    Buffer.from("concurrent base\n"),
  );
  await git.advance(pin.base, external);
  assert.equal(await flow.integrate(), "denied");
  assert.equal(await git.head(), external);
  assert.deepEqual(calls, ["worker", "reviewer"]);
  assert.equal((await journal.read()).at(-1)?.kind, "denied");
});

test("a rejected or missing human decision leaves the target at its base", async (t) => {
  for (const reject of [false, true]) {
    const { flow, git, calls } = await fixture(t);
    const pin = await flow.prepare();
    if (reject) await flow.decide(pin, "reject");
    assert.equal(await flow.integrate(), "denied");
    assert.equal(await git.head(), pin.base);
    assert.deepEqual(calls, ["worker", "reviewer"]);
  }
});

test("failed verification records its result without advancing the branch", async (t) => {
  const { plan, git, host, journal } = await fixture(t);
  const flow = new ReviewedIntegration(git, host, journal, {
    ...plan,
    verification: { ...plan.verification, argv: ["revise"] },
  });
  const pin = await flow.prepare();
  await flow.decide(pin, "approve");
  assert.equal(await flow.integrate(), "denied");
  assert.equal(await git.head(), pin.base);
  assert.equal((await journal.read()).at(-2)?.kind, "verification.finished");
});

test("a failed authorization write prevents the integration ref update", async (t) => {
  const { plan, git, host, journal, journalDir } = await fixture(t);
  const flow = new ReviewedIntegration(git, host, journal, plan);
  const pin = await flow.prepare();
  await flow.decide(pin, "approve");
  class FailingJournal extends IntegrationJournal {
    override async append(
      count: number,
      event: Parameters<IntegrationJournal["append"]>[1],
    ) {
      if (event.kind === "integration.authorized")
        throw new Error("Fixture audit write failed");
      return super.append(count, event);
    }
  }
  const failing = new ReviewedIntegration(
    git,
    host,
    new FailingJournal(journalDir, journal.id),
    plan,
  );
  await assert.rejects(failing.integrate(), /Fixture audit write failed/);
  assert.equal(await git.head(), pin.base);
  assert.equal((await journal.read()).at(-1)?.kind, "verification.finished");
});
