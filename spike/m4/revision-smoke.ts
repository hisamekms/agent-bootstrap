import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seed } from "../m3/integration-smoke.ts";
import { SqliteAudit } from "../../src/audit.ts";
import { LocalGitIntegration } from "../../src/git-integration.ts";
import { IntegrationJournal } from "../../src/integration-journal.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { ProfileCatalog } from "../../src/sandbox-profiles.ts";
import { ReviewedIntegration } from "../../src/reviewed-integration.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

// Offline revision path: Worker, a Reviewer that asks for changes with
// notes, a revising Worker in a new VM, and a passing review of the new
// candidate. It stops before the human decision.
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const home = process.env.MSB_HOME;
assert.ok(home && isAbsolute(home), "Set an absolute MSB_HOME");
const binary = await new Promise<string>((resolve, reject) =>
  execFile("/usr/bin/which", ["msb"], (error, stdout) =>
    error ? reject(error) : resolve(stdout.trim()),
  ),
);
const command = (shell: string) => ({
  argv: ["/bin/sh", "-ec", shell],
  timeoutMs: 8000,
});

await mkdir(local, { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(join(local, "m4-revision-")));
const repository = join(root, "repository.git");
const journalDir = join(root, "review");
await mkdir(repository, { mode: 0o700 });
await mkdir(journalDir, { mode: 0o700 });
seed(repository);
const git = new LocalGitIntegration({
  binary: "/usr/bin/git",
  repository,
  branch: "main",
  stagingRoot: join(root, "worktrees"),
});
const audit = new SqliteAudit(join(root, "audit.sqlite"));
try {
  const profiles = new ProfileCatalog({ base: { image } });
  const host = new TrustedHost(
    audit,
    new MicrosandboxRuntime({
      binary,
      home,
      profiles,
      stagingRoot: join(root, "sandboxes"),
    }),
    profiles,
  );
  const journal = new IntegrationJournal(journalDir, randomUUID());
  const flow = new ReviewedIntegration(git, host, journal, {
    path: "hello.txt",
    // First round edits the base. A revision must see the previous
    // candidate and read-only notes, and must not be able to change them.
    worker: command(`
      if test -e /review/review-notes.txt; then
        test "$(cat /workspace/hello.txt)" = "hello from Worker"
        grep -q 'formal greeting' /review/review-notes.txt
        if (printf x >> /review/review-notes.txt) 2>/dev/null; then exit 9; fi
        printf '%s\\n' 'good day from Worker' > /workspace/hello.txt
      else
        test "$(cat /workspace/hello.txt)" = "hello from base"
        printf '%s\\n' 'hello from Worker' > /workspace/hello.txt
      fi
      printf '%s' '{"tool":"collect"}'
    `),
    reviewer: command(`
      if grep -Exq 'hello from Worker' /review/candidate.source; then
        printf '%s' '{"review":"revise","notes":"Use a formal greeting."}'
      else
        grep -Exq '\\+good day from Worker' /review/candidate.diff
        printf '%s' '{"review":"pass"}'
      fi
    `),
    verification: command(`printf '%s' '{"review":"pass"}'`),
  });
  const started = performance.now();
  const first = await flow.prepareCandidate();
  const firstReview = await flow.reviewCandidate();
  const second = await flow.revise();
  const secondReview = await flow.reviewCandidate();
  const events = await journal.read();
  const runs = events.flatMap((event) => ("run" in event ? [event.run] : []));
  const invocations = [...new Set(runs)].map((id) => {
    const trace = audit.read(id);
    return `${trace[0]?.role} ${trace.at(-1)?.outcome}`;
  });
  console.log(
    JSON.stringify(
      {
        seconds: Math.round((performance.now() - started) / 100) / 10,
        first: { ...first, review: firstReview.review },
        second: { ...second, review: secondReview.review },
        journal: events.map((event) => event.kind),
        invocations,
        reviewedPin: await flow.reviewedPin(),
      },
      null,
      2,
    ),
  );
  assert.equal(firstReview.review, "revise");
  assert.equal(secondReview.review, "pass");
  assert.equal(second.base, first.base);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(await flow.reviewedPin(), second);
  await assert.rejects(flow.decide(first, "approve"));
  assert.deepEqual(invocations, [
    "Worker ok",
    "Reviewer ok",
    "Worker ok",
    "Reviewer ok",
  ]);
  assert.equal(await git.head(), first.base);
  console.log(
    "The revision ran in a new Worker VM with read-only notes, produced a new candidate and digest, and only that candidate is eligible for approval.",
  );
} finally {
  audit.close();
}
