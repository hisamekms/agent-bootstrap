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
import {
  ReviewedIntegration,
  verificationResult,
} from "../src/reviewed-integration.ts";
import type { SandboxRuntime, SandboxSpec } from "../src/sandbox-runtime.ts";
import { ProfileCatalog, type ProfileName } from "../src/sandbox-profiles.ts";
import { TrustedHost } from "../src/trusted-host.ts";

const profiles = new ProfileCatalog({
  base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
  db: { image: `fixture.invalid/db@sha256:${"b".repeat(64)}` },
});

const notes = "Use a formal greeting. fixture-private-note";
const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Reviewer answers come from `reviews` in order; each Worker round writes
 * `round N from Worker`. */
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  reviews: string[],
  verification = '{"review":"pass"}',
  extras: {
    workerSandbox?: {
      provider?: { host: string; secretEnv: string };
      profile?: ProfileName;
    };
    reviewerSandbox?: {
      provider?: { host: string; secretEnv: string };
      profile?: ProfileName;
    };
    verification?: ConstructorParameters<
      typeof ReviewedIntegration
    >[3]["verification"];
  } = {},
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
            : verification;
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
  const host = new TrustedHost(audit, runtime, profiles);
  const flow = new ReviewedIntegration(git, host, journal, {
    path: "hello.txt",
    worker: { argv: ["worker"], timeoutMs: 123 },
    reviewer: { argv: ["reviewer"], timeoutMs: 123 },
    verification: { command: { argv: ["verify"], timeoutMs: 123 } },
    ...extras,
  });
  return { flow, git, host, journal, journalDir, workers, specs, audit };
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

test("concurrent revisions start one Worker, and a missing note stops before any Worker", async (t) => {
  const { flow, workers } = await fixture(t, [
    JSON.stringify({ review: "revise", notes }),
  ]);
  await flow.prepareCandidate();
  await flow.reviewCandidate();
  const raced = await Promise.allSettled([flow.revise(), flow.revise()]);
  assert.equal(
    raced.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(workers.length, 2);

  const missing = await fixture(t, [
    JSON.stringify({ review: "revise", notes }),
  ]);
  await missing.flow.prepareCandidate();
  await missing.flow.reviewCandidate();
  await rm(join(missing.journalDir, `note-${sha256(notes)}`));
  await assert.rejects(missing.flow.revise());
  assert.equal(missing.workers.length, 1);
  // The revision request stays as the last event: uncertain, never retried.
  assert.equal(
    (await missing.journal.read()).at(-1)?.kind,
    "revision.requested",
  );
  await assert.rejects(missing.flow.revise());
  await assert.rejects(missing.flow.reviewCandidate());
});

test("verification keeps its strict response format", async (t) => {
  const { flow, git, journal } = await fixture(
    t,
    [],
    JSON.stringify({ review: "pass", notes }),
  );
  const pin = await flow.prepareCandidate();
  await flow.reviewCandidate();
  await flow.decide(pin, "approve");
  assert.equal(await flow.integrate(), "denied");
  assert.equal(await git.head(), pin.base);
  const events = await journal.read();
  assert.equal(
    events.findLast((event) => event.kind === "verification.finished")?.kind ===
      "verification.finished" &&
      events.findLast((event) => event.kind === "verification.finished")
        ?.review,
    "concern",
  );
  assert.ok(!events.some((event) => event.kind === "review.noted"));
});

test("blank review notes mean a review without notes", async (t) => {
  const { flow, journal } = await fixture(t, [
    JSON.stringify({ review: "revise", notes: "  " }),
  ]);
  await flow.prepareCandidate();
  assert.equal((await flow.reviewCandidate()).review, "revise");
  assert.ok(
    !(await journal.read()).some((event) => event.kind === "review.noted"),
  );
});

test("provider egress reaches Worker and Reviewer VMs, never verification, and is audited", async (t) => {
  const provider = {
    host: "api.openai.com",
    secretEnv: "AGENT_BOOTSTRAP_TOKEN",
  };
  const { flow, specs, journal, audit } = await fixture(
    t,
    [],
    '{"review":"pass"}',
    { workerSandbox: { provider }, reviewerSandbox: { provider } },
  );
  const pin = await flow.prepareCandidate();
  await flow.reviewCandidate();
  await flow.decide(pin, "approve");
  assert.equal(await flow.integrate(), "completed");
  const created = [...specs.values()];
  assert.equal(created.length, 3);
  // Worker, Reviewer, then verification.
  assert.deepEqual(
    created.map((spec) => spec.provider?.host ?? null),
    ["api.openai.com", "api.openai.com", null],
  );
  const runs = (await journal.read()).flatMap((event) =>
    "run" in event ? [event.run] : [],
  );
  const egress = (id: string) =>
    audit
      .read(id)
      .filter((event) => event.operation === "provider.egress")
      .map((event) => `${event.kind} ${event.outcome ?? ""}`.trim());
  for (const run of runs.slice(0, 2))
    assert.deepEqual(egress(run), [
      "operation.requested",
      "operation.allowed",
      "operation.finished ok",
    ]);
  assert.deepEqual(egress(runs.at(-1)!), []);
});

const suite = [
  { path: "suite/test.sh", bytes: Buffer.from("echo one\n") },
  { path: "data.txt", bytes: Buffer.from("fixture") },
];
const verifier = { argv: ["verify"], timeoutMs: 123 };
const paths = (spec?: SandboxSpec) =>
  spec?.readOnlyFiles?.map((file) => file.path);

test("suite and profile reach Worker (both rounds) and verification, never the Reviewer", async (t) => {
  const { flow, specs, git } = await fixture(
    t,
    [JSON.stringify({ review: "revise", notes }), '{"review":"pass"}'],
    '{"review":"pass"}',
    { verification: { command: verifier, profile: "db", suite } },
  );
  await flow.prepareCandidate();
  await flow.reviewCandidate();
  const second = await flow.revise();
  await flow.reviewCandidate();
  await flow.decide(second, "approve");
  assert.equal(await flow.integrate(), "completed");
  assert.equal(await git.head(), second.candidate);
  // Worker, Reviewer, Worker, Reviewer, verification.
  const all = [...specs.values()];
  assert.equal(all.length, 5);
  const [w1, r1, w2, r2, v] = all;
  assert.deepEqual(paths(w1), ["suite/suite/test.sh", "suite/data.txt"]);
  assert.deepEqual(paths(w2), [
    "review-notes.txt",
    "suite/suite/test.sh",
    "suite/data.txt",
  ]);
  assert.deepEqual(paths(v), [
    "candidate.diff",
    "candidate.source",
    "suite/suite/test.sh",
    "suite/data.txt",
  ]);
  assert.equal(
    Buffer.from(v!.readOnlyFiles![2]!.bytes).toString(),
    "echo one\n",
  );
  assert.equal(w1?.profile, "db");
  assert.equal(w2?.profile, "db");
  assert.equal(v?.profile, "db");
  for (const r of [r1, r2]) {
    assert.deepEqual(paths(r), ["candidate.diff", "candidate.source"]);
    assert.ok(r?.profile === undefined || r.profile === "base");
  }
});

test("workerSandbox.profile overrides the verification profile for the Worker", async (t) => {
  const { flow, specs } = await fixture(t, [], '{"review":"pass"}', {
    workerSandbox: { profile: "base" },
    verification: { command: verifier, profile: "db" },
  });
  await flow.prepareCandidate();
  assert.equal([...specs.values()][0]?.profile, "base");
});

test("no suite and no profile send no extras", async (t) => {
  const { flow, specs } = await fixture(t, []);
  const pin = await flow.prepareCandidate();
  await flow.reviewCandidate();
  await flow.decide(pin, "approve");
  await flow.integrate();
  const [w, , v] = [...specs.values()];
  assert.equal(w?.readOnlyFiles, undefined);
  // The host resolves an omitted profile to "base".
  assert.equal(w?.profile ?? "base", "base");
  assert.equal(v?.profile ?? "base", "base");
  assert.deepEqual(paths(v), ["candidate.diff", "candidate.source"]);
});

test("an invalid suite is rejected by the constructor", async (t) => {
  const bytes = new Uint8Array(1);
  const bad = [
    [{ path: "../x", bytes }],
    [{ path: "/x", bytes }],
    [{ path: "a//b", bytes }],
    [
      { path: "a", bytes },
      { path: "a", bytes },
    ],
    Array.from({ length: 33 }, (_, i) => ({ path: `f${i}`, bytes })),
  ];
  for (const files of bad)
    await assert.rejects(
      fixture(t, [], "", { verification: { command: verifier, suite: files } }),
      /Invalid verification suite/,
    );
});

test("changing the suite or profile invalidates earlier approvals", async (t) => {
  const first = await fixture(t, [], '{"review":"pass"}', {
    verification: { command: verifier, suite },
  });
  const pin = await first.flow.prepare();
  const make = (
    verification: (typeof suite)[number][] | undefined,
    profile?: ProfileName,
  ) =>
    new ReviewedIntegration(first.git, first.host, first.journal, {
      path: "hello.txt",
      worker: { argv: ["worker"], timeoutMs: 123 },
      reviewer: { argv: ["reviewer"], timeoutMs: 123 },
      verification: {
        command: verifier,
        ...(profile ? { profile } : {}),
        ...(verification ? { suite: verification } : {}),
      },
    });
  const edited = [
    { ...suite[0]!, bytes: Buffer.from("echo two\n") },
    suite[1]!,
  ];
  for (const other of [make(edited), make(suite, "db"), make(undefined)]) {
    await assert.rejects(other.decide(pin, "approve"), /incomplete/);
    assert.equal(await other.reviewedPin(), null);
  }
  // An unchanged verifier, and an explicit "base", still match.
  assert.equal((await make(suite).reviewedPin())?.digest, pin.digest);
  await make(suite).decide(pin, "approve");
});

async function verificationOutcome(
  t: Parameters<typeof fixture>[0],
  output: string,
) {
  const { flow, journal } = await fixture(t, [], output);
  const pin = await flow.prepareCandidate();
  await flow.reviewCandidate();
  await flow.decide(pin, "approve");
  const result = await flow.integrate();
  const finished = (await journal.read()).findLast(
    (event) => event.kind === "verification.finished",
  );
  assert.equal(finished?.kind, "verification.finished");
  return { result, finished: finished as Record<string, unknown> };
}

test("verification test counts reach the journal, never failure names", async (t) => {
  // One end-to-end run; output shapes are covered by the unit test below.
  const revise = await verificationOutcome(
    t,
    JSON.stringify({
      review: "revise",
      tests: { passed: 1, failed: 2, failures: ["a b", "c"] },
    }),
  );
  assert.equal(revise.result, "denied");
  assert.equal(revise.finished.review, "revise");
  assert.deepEqual(revise.finished.tests, { passed: 1, failed: 2 });
  assert.ok(!JSON.stringify(revise.finished).includes("a b"));
});

test("verification output shapes are strict", () => {
  const judge = (text: string) =>
    verificationResult({
      id: randomUUID(),
      outcome: "ok",
      response: Buffer.from(text),
    });
  assert.deepEqual(judge('{"review":"pass"}'), { review: "pass" });
  assert.deepEqual(
    judge(
      JSON.stringify({
        review: "pass",
        tests: { passed: 12, failed: 0, failures: [] },
      }),
    ),
    { review: "pass", tests: { passed: 12, failed: 0 } },
  );
  const t0 = { passed: 1, failed: 0, failures: [] as unknown[] };
  for (const value of [
    { review: "pass", tests: { ...t0, failed: 1 } }, // contradiction
    { review: "pass", tests: { ...t0, extra: 1 } },
    { review: "pass", tests: { passed: 1, failed: 0 } },
    { review: "pass", tests: { ...t0, passed: 1.5 } },
    { review: "pass", tests: { ...t0, passed: -1 } },
    { review: "pass", tests: { ...t0, passed: 100_001 } },
    { review: "pass", tests: { ...t0, failures: ["\u00e9"] } },
    { review: "pass", tests: { ...t0, failures: ["line\nbreak"] } },
    { review: "pass", tests: { ...t0, failures: ["x".repeat(201)] } },
    { review: "pass", tests: { ...t0, failures: Array(21).fill("x") } },
    { review: "pass", tests: { ...t0, failures: [1] } },
    { review: "pass", tests: [] },
    { review: "pass", tests: t0, other: 1 },
    { review: "pass", notes: "x" },
    { review: "ok" },
  ])
    assert.deepEqual(
      judge(JSON.stringify(value)),
      { review: "concern" },
      JSON.stringify(value),
    );
  const big = JSON.stringify({
    review: "pass",
    tests: { ...t0, failures: Array(20).fill("x".repeat(200)) },
  });
  assert.ok(big.length > 4096);
  assert.deepEqual(judge(big), { review: "concern" });
  const bounded = JSON.stringify({
    review: "revise",
    tests: { ...t0, failed: 20, failures: Array(20).fill("x".repeat(150)) },
  });
  assert.ok(bounded.length < 4096);
  assert.equal(judge(bounded).review, "revise");
  // The bare form keeps its 128-byte bound.
  assert.deepEqual(judge(`{"review":"pass"${" ".repeat(120)}}`), {
    review: "concern",
  });
  assert.deepEqual(
    verificationResult({
      id: randomUUID(),
      outcome: "failed",
      response: Buffer.from('{"review":"pass"}'),
    }),
    { review: "concern" },
  );
});
