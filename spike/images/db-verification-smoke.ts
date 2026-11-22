import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteAudit } from "../../src/audit.ts";
import { LocalGitIntegration } from "../../src/git-integration.ts";
import { IntegrationJournal } from "../../src/integration-journal.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { parseProfileLock, profileCatalog } from "../../src/profile-lock.ts";
import { ReviewedIntegration } from "../../src/reviewed-integration.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

const gitBinary = "/usr/bin/git";
const path = "schema.sql";
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const lockFile = fileURLToPath(
  new URL("../../images/profiles.lock.json", import.meta.url),
);
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const baseSchema =
  "CREATE TABLE greeting (id integer primary key, text text not null);\n";

function seed(directory: string) {
  const git = (args: string[], input = "") => {
    const result = spawnSync(gitBinary, args, {
      cwd: directory,
      input,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture Worker",
        GIT_AUTHOR_EMAIL: "worker@example.invalid",
        GIT_COMMITTER_NAME: "Fixture Host",
        GIT_COMMITTER_EMAIL: "host@example.invalid",
      },
    });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  git(["init", "--bare", "--template=", "--initial-branch=main"]);
  const blob = git(["hash-object", "-w", "--stdin"], baseSchema);
  const tree = git(["mktree"], `100644 blob ${blob}\t${path}\n`);
  const commit = git(["commit-tree", tree, "-m", "Fixture baseline"]);
  git(["update-ref", "refs/heads/main", commit, "0".repeat(40)]);
}

const suite = `set -eu
url=$(agent-bootstrap-postgres)
passed=0
failed=0
failures=""
record() {
  if [ "$1" = ok ]; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    if [ -n "$failures" ]; then failures="$failures,"; fi
    failures="$failures\\"$2\\""
  fi
}
rm -f /tmp/t.db
if psql "$url" -v ON_ERROR_STOP=1 -q -f /review/candidate.source >/dev/null 2>&1; then record ok; else record bad pg-apply; fi
if sqlite3 /tmp/t.db < /review/candidate.source >/dev/null 2>&1; then record ok; else record bad sqlite-apply; fi
got=$(psql "$url" -v ON_ERROR_STOP=1 -q -At -c "insert into greeting (id, text) values (1, 'hi'); select text from greeting where id = 1" 2>/dev/null || true)
if [ "$got" = hi ]; then record ok; else record bad pg-roundtrip; fi
got=$(sqlite3 /tmp/t.db "insert into greeting (id, text) values (1, 'hi'); select text from greeting where id = 1;" 2>/dev/null || true)
if [ "$got" = hi ]; then record ok; else record bad sqlite-roundtrip; fi
if [ "$failed" -eq 0 ]; then review=pass; else review=revise; fi
printf '{"review":"%s","tests":{"passed":%d,"failed":%d,"failures":[%s]}}\\n' "$review" "$passed" "$failed" "$failures"
`;

const sh = (script: string, timeoutMs = 120_000) => ({
  argv: ["/bin/sh", "-c", script],
  timeoutMs,
});

const goodSchema =
  "CREATE TABLE greeting (id integer primary key, text text not null, created_at text);\n";
const worker = (sql: string) =>
  sh(
    `set -eu
test -f /review/suite/test.sh && command -v psql >/dev/null && command -v sqlite3 >/dev/null
cat > /workspace/schema.sql <<'SQL'
${sql}SQL
printf '%s' '{"tool":"collect"}'
`,
    60_000,
  );

async function main() {
  const [binary] = process.argv.slice(2);
  const home = process.env.MSB_HOME;
  assert.ok(binary && isAbsolute(binary) && home && isAbsolute(home));
  await mkdir(local, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(local, "db-verification-"));
  const repository = join(root, "repository.git");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(join(root, "journal"), { mode: 0o700 });
  seed(repository);

  const lock = parseProfileLock(await readFile(lockFile, "utf8"));
  const dbDigest = /@sha256:([a-f0-9]{64})$/.exec(
    lock.profiles["db"]?.image ?? "",
  )?.[1];
  const baseDigest = /@sha256:([a-f0-9]{64})$/.exec(image)?.[1];
  assert.ok(dbDigest && baseDigest);
  const profiles = profileCatalog(image, lock);
  const git = new LocalGitIntegration({
    binary: gitBinary,
    repository,
    branch: "main",
    stagingRoot: join(root, "worktrees"),
  });
  const audit = new SqliteAudit(join(root, "audit.sqlite"));
  const runtime = new MicrosandboxRuntime({
    binary,
    home,
    profiles,
    stagingRoot: join(root, "sandboxes"),
  });
  const host = new TrustedHost(audit, runtime, profiles);
  const report: unknown[] = [];
  let stage = "setup";
  try {
    for (const [name, sql, expected] of [
      ["positive", goodSchema, "completed"],
      ["negative", "CREATE TABLE greeting (\n", "denied"],
    ] as const) {
      stage = name;
      const id = randomUUID();
      const journal = new IntegrationJournal(join(root, "journal"), id);
      const integration = new ReviewedIntegration(git, host, journal, {
        path,
        worker: worker(sql),
        reviewer: sh(`printf '%s' '{"review":"pass"}'`, 30_000),
        verification: {
          command: sh("sh /review/suite/test.sh"),
          profile: "db",
          suite: [{ path: "test.sh", bytes: new TextEncoder().encode(suite) }],
        },
        workerSandbox: { profile: "db" },
      });
      const pin = await integration.prepareCandidate();
      const reviewed = await integration.reviewCandidate();
      assert.equal(reviewed.review, "pass");
      await integration.decide(pin, "approve");
      const result = await integration.integrate();
      const events = await journal.read();
      const finished = events.find(
        (event) => event.kind === "verification.finished",
      );
      assert.ok(finished && finished.kind === "verification.finished");
      const roleOf = (run: string) => {
        const trail = audit.read(run);
        const create = trail.find(
          (event) =>
            event.kind === "operation.requested" &&
            event.operation === "sandbox.create",
        );
        const last = trail.at(-1);
        return {
          role: trail[0]?.role,
          profile: create?.profile,
          image: create?.image,
          outcome:
            last?.kind === "invocation.finished" ? last.outcome : "incomplete",
        };
      };
      const runs = (kind: string) =>
        events.flatMap((event) =>
          event.kind === kind && "run" in event ? [event.run] : [],
        );
      const [workerRun] = runs("candidate.authorized");
      const [reviewRun] = runs("review.submitted");
      assert.ok(workerRun && reviewRun);
      const invocations = {
        Worker: roleOf(workerRun),
        Reviewer: roleOf(reviewRun),
        Verification: roleOf(finished.run),
      };
      assert.equal(result, expected);
      assert.deepEqual(
        [
          invocations.Worker.role,
          invocations.Worker.profile,
          invocations.Worker.image,
        ],
        ["Worker", "db", dbDigest],
      );
      assert.deepEqual(
        [
          invocations.Verification.role,
          invocations.Verification.profile,
          invocations.Verification.image,
        ],
        ["Verification", "db", dbDigest],
      );
      assert.deepEqual(
        [
          invocations.Reviewer.role,
          invocations.Reviewer.profile,
          invocations.Reviewer.image,
        ],
        ["Reviewer", "base", baseDigest],
      );
      const tests = (finished as { tests?: { passed: number; failed: number } })
        .tests;
      assert.ok(tests);
      if (name === "positive") {
        assert.deepEqual(
          [finished.review, tests.passed, tests.failed],
          ["pass", 4, 0],
        );
      } else {
        assert.equal(finished.review, "revise");
        assert.ok(tests.failed > 0);
      }
      report.push({ run: name, result, verification: finished, invocations });
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (process.env["SMOKE_DEBUG"] === "1") console.error(error);
    console.error(`DB verification smoke stopped at ${stage}.`);
    process.exitCode = 1;
  } finally {
    audit.close();
  }
}

if (import.meta.main) await main();
