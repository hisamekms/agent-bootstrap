import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { seed } from "../spike/m3/integration-smoke.ts";
import { SqliteAudit } from "../src/audit.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import {
  IntegrationJournal,
  MAX_REVISIONS,
} from "../src/integration-journal.ts";
import { ReviewedIntegration } from "../src/reviewed-integration.ts";
import type { SandboxRuntime, SandboxSpec } from "../src/sandbox-runtime.ts";
import { TrustedHost } from "../src/trusted-host.ts";

const notes = "Use a formal greeting. fixture-private-note";
const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Reviewer answers come from `reviews` in order; each Worker round writes
 * `round N from Worker`. */
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  reviews: string[],
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "bootstrap-revision-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo.git");
  const journalDir = join(root, "events");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(journalDir, { mode: 0o700 });
  seed(repository);
  const git = new LocalGitIntegration({
    binary: "/usr/bin/git",
    repository,
    stagingRoot: join(root, "worktrees"),
    branch: "main",
  });
  const audit = new SqliteAudit(join(root, "audit.sqlite"));
  t.after(async () => audit.close());
  const workers: SandboxSpec[] = [];
  let round = 0;
  const specs = new Map<string, SandboxSpec>();
  const runtime: SandboxRuntime = {
    async create(spec) {
      const id = randomUUID();
      specs.set(id, spec);
      return { id };
    },
    async exec(handle, command) {
      const entry = command.argv[0];
      if (entry === "worker") {
        workers.push(specs.get(handle.id)!);
        round++;
      }
      const output =
        entry === "worker"
          ? '{"tool":"collect"}'
          : entry === "reviewer"
            ? (reviews.shift() ?? '{"review":"pass"}')
            : '{"review":"pass"}';
      return {
        status: "exited",
        exitCode: 0,
        stdout: Buffer.from(output),
        stderr: new Uint8Array(),
      };
    },
    async collect() {
      return {
        files: [
          {
            path: "hello.txt",
            bytes: Buffer.from(`round ${round} from Worker\n`),
          },
        ],
      };
    },
    async destroy() {},
  };
  const journal = new IntegrationJournal(journalDir, randomUUID());
  const flow = new ReviewedIntegration(
    git,
    new TrustedHost(audit, runtime),
    journal,
    {
      path: "hello.txt",
      worker: { argv: ["worker"], timeoutMs: 123 },
      reviewer: { argv: ["reviewer"], timeoutMs: 123 },
      verification: { argv: ["verify"], timeoutMs: 123 },
    },
  );
  return { flow, git, journal, journalDir, workers };
}

test("a revision is a new candidate that needs its own review and approval", async (t) => {
  const { flow, git, journal, journalDir, workers } = await fixture(t, [
    JSON.stringify({ review: "revise", notes }),
    '{"review":"pass"}',
  ]);
  const first = await flow.prepareCandidate();
  assert.equal((await flow.reviewCandidate()).review, "revise");
  assert.equal(await flow.reviewedPin(), null);
  await assert.rejects(flow.decide(first, "approve"), /eligible review/);

  const second = await flow.revise();
  assert.equal(second.base, first.base);
  assert.notEqual(second.candidate, first.candidate);
  assert.notEqual(second.digest, first.digest);
  // The revising Worker starts from the reviewed candidate, with the notes
  // read-only and no other host input.
  const revising = workers[1];
  assert.deepEqual(
    revising?.files?.map((file) => [
      file.path,
      Buffer.from(file.bytes).toString(),
    ]),
    [["hello.txt", "round 1 from Worker\n"]],
  );
  assert.deepEqual(
    revising?.readOnlyFiles?.map((file) => [
      file.path,
      Buffer.from(file.bytes).toString(),
    ]),
    [["review-notes.txt", notes]],
  );
  // Nothing about the first candidate can be reviewed, decided or integrated.
  await assert.rejects(
    flow.decide(first, "approve"),
    /eligible review|incomplete/,
  );
  await assert.rejects(flow.revise(), /incomplete/);
  assert.equal((await flow.reviewCandidate()).review, "pass");
  assert.deepEqual(await flow.reviewedPin(), second);
  await assert.rejects(flow.decide(first, "approve"), /eligible review/);
  await assert.rejects(flow.revise(), /reviewed as needing changes/);
  await flow.decide(second, "approve");
  assert.equal(await flow.integrate(), "completed");
  assert.equal(await git.head(), second.candidate);

  const events = await journal.read();
  const requested = events.find((event) => event.kind === "revision.requested");
  assert.deepEqual(requested && { ...requested, at: undefined }, {
    kind: "revision.requested",
    round: "1",
    from: first.digest,
    notes: sha256(notes),
    at: undefined,
  });
  assert.equal(
    Buffer.from(await journal.readNote(sha256(notes))).toString(),
    notes,
  );
  // The notes are stored as a private file; the journal keeps only digests.
  for (const name of await readdir(journalDir))
    if (!name.startsWith("note-"))
      assert.doesNotMatch(
        await readFile(join(journalDir, name), "utf8"),
        /fixture-private-note/,
      );
});

test("a concern can be revised without notes, and revisions are capped", async (t) => {
  const reviews = Array.from({ length: MAX_REVISIONS + 1 }, (_, index) =>
    index === 0 ? "not json" : '{"review":"revise"}',
  );
  const { flow, journal, workers } = await fixture(t, reviews);
  await flow.prepareCandidate();
  assert.equal((await flow.reviewCandidate()).review, "concern");
  for (let index = 0; index < MAX_REVISIONS; index++) {
    await flow.revise();
    assert.equal((await flow.reviewCandidate()).review, "revise");
  }
  await assert.rejects(flow.revise(), /Revision limit/);
  assert.equal(workers.length, 1 + MAX_REVISIONS);
  assert.ok(workers.every((spec) => spec.readOnlyFiles === undefined));
  assert.equal(
    (await journal.read()).filter(
      (event) => event.kind === "revision.requested",
    ).length,
    MAX_REVISIONS,
  );
});

test("malformed or oversized review notes are a concern without notes", async (t) => {
  for (const response of [
    JSON.stringify({ review: "revise", notes: "x".repeat(3000) }),
    JSON.stringify({ review: "revise", notes: "" }),
    JSON.stringify({ review: "revise", notes: 7 }),
    JSON.stringify({ review: "pass", notes, extra: true }),
  ]) {
    const { flow, journal } = await fixture(t, [response]);
    await flow.prepareCandidate();
    assert.equal((await flow.reviewCandidate()).review, "concern");
    assert.ok(
      !(await journal.read()).some((event) => event.kind === "review.noted"),
    );
  }
});
