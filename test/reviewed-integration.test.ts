import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seed } from "../spike/m3/integration-smoke.ts";
import { SqliteAudit } from "../src/audit.ts";
import type { EgressPolicy } from "../src/egress-policy.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { IntegrationJournal } from "../src/integration-journal.ts";
import { ReviewedIntegration } from "../src/reviewed-integration.ts";
import type { SandboxRuntime } from "../src/sandbox-runtime.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import { TrustedHost } from "../src/trusted-host.ts";
import { fakeGateway } from "./fake-gateway.ts";

const profiles = new ProfileCatalog({
  base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
});

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  audited = false,
) {
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
  const policies: EgressPolicy[] = [];
  const changed = Buffer.from("hello from Worker\n");
  const digest = "a".repeat(64);
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
    async createBound(spec, id) {
      await runtime.create(spec);
      return { id, netRuleDigest: digest };
    },
    netRuleDigest: () => digest,
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
    verification: { command: { argv: ["verify"], timeoutMs: 123 } },
  };
  const host = new TrustedHost(
    audit,
    runtime,
    profiles,
    audited
      ? {
          config: {
            audit: { mode: "required" },
            telemetry: {
              enabled: false,
              resourceSamplingIntervalMs: 1000,
              traceSamplingRatio: 1,
            },
          },
          gatewayHosts: ["review.invalid"],
          async gatewayFactory(options) {
            policies.push(options.policy);
            return fakeGateway([]).open(options);
          },
        }
      : undefined,
  );
  const flow = new ReviewedIntegration(git, host, journal, plan);
  return {
    flow,
    plan,
    git,
    config,
    journal,
    journalDir,
    host,
    audit,
    calls,
    policies,
  };
}

test("single-file integration scopes gateway services and provider to their roles", async (t) => {
  const { git, host, journal, plan, policies, audit } = await fixture(t, true);
  const workerService = { ip: "192.0.2.20", port: 8080, loopbackPort: 8081 };
  const reviewerService = { ip: "192.0.2.21", port: 8080, loopbackPort: 8082 };
  const flow = new ReviewedIntegration(git, host, journal, {
    ...plan,
    workerHostServices: [workerService],
    reviewerHostServices: [reviewerService],
    reviewerSandbox: {
      provider: { host: "review.invalid", secretEnv: "REVIEW_KEY" },
    },
  });
  const originalWorkerService = { ...workerService };
  workerService.loopbackPort = 9999;
  const pin = await flow.prepare();
  await flow.decide(pin, "approve");
  assert.equal(await flow.integrate(), "completed");
  assert.deepEqual(
    policies.map((policy) => policy.hostServices),
    [[originalWorkerService], [reviewerService]],
  );
  assert.equal(policies[0]?.providerBinding, undefined);
  assert.deepEqual(policies[1]?.providerBinding, {
    hostname: "review.invalid",
    port: 443,
  });
  const verification = (await journal.read()).find(
    (event) => event.kind === "verification.finished",
  );
  assert.ok(verification);
  const binding = audit.readExecution(verification.run).sandboxBindings[0];
  assert.equal(binding?.egressMode, "none");
});

test("approval binds one candidate, the target and the verifier, and applies once", async (t) => {
  const { flow, plan, git, config, journal, host, calls, audit } =
    await fixture(t);
  const pin = await flow.prepare();
  assert.equal(pin.review, "pass");
  assert.deepEqual(await flow.protectedPaths(pin), []);
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
  plan.verification.command.argv[0] = "changed-verifier";
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
  assert.partialDeepStrictEqual(
    events.find(({ kind }) => kind === "human.decided"),
    {
      answererKind: "human",
      delegated: false,
    },
  );
  const recordedReview = events.find(
    (event) => event.kind === "review.submitted",
  );
  assert.ok(recordedReview);
  assert.equal(audit.read(recordedReview.run).at(-1)?.role, "Reviewer");
  await assert.rejects(flow.integrate(), /already been attempted/);
});

test("integration reads legacy decisions without answerer metadata", async (t) => {
  const { flow, journal, git } = await fixture(t);
  const { base, candidate, digest } = await flow.prepare();
  const events = await journal.read();
  await journal.append(events.length, {
    kind: "human.decided",
    base,
    candidate,
    digest,
    decision: "approve",
  });
  assert.equal(await flow.integrate(), "completed");
  assert.equal(await git.head(), candidate);
});

test("single-file review refuses a multi-file candidate from the Git adapter", async (t) => {
  const { config, host, journal, plan, git, calls } = await fixture(t);
  class MultiFileGit extends LocalGitIntegration {
    override createCandidate(base: string, path: string, bytes: Uint8Array) {
      return this.createCandidateTree(
        base,
        [
          { path, mode: "100644", bytes },
          {
            path: "unexpected.txt",
            mode: "100644",
            bytes: Buffer.from("extra\n"),
          },
        ],
        "unexpected multi-file candidate",
      );
    }
  }
  const base = await git.head();
  const flow = new ReviewedIntegration(
    new MultiFileGit(config),
    host,
    journal,
    plan,
  );
  await assert.rejects(flow.prepare(), /Could not create a review candidate/);
  assert.deepEqual(calls, ["worker"]);
  assert.equal(await git.head(), base);
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
    verification: {
      command: { ...plan.verification.command, argv: ["revise"] },
    },
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
  const before = await journal.read();
  await assert.rejects(
    flow.reviewCandidate(),
    /review has already been attempted/,
  );
  await assert.rejects(
    flow.integrate(),
    /Integration has already been attempted/,
  );
  assert.deepEqual(await journal.read(), before);
});

test("verification must be configured unless the caller explicitly opts out", async (t) => {
  const { git, host, journal, plan } = await fixture(t);
  const { verification: _verification, ...unverified } = plan;
  assert.throws(
    () => new ReviewedIntegration(git, host, journal, unverified),
    /Verification is required/,
  );
  const flow = new ReviewedIntegration(git, host, journal, {
    ...unverified,
    allowUnverified: true,
  });
  const pin = await flow.prepare();
  await flow.decide(pin, "approve");
  await assert.rejects(flow.integrate(), /Verification is not configured/);
  assert.equal(await git.head(), pin.base);
});
