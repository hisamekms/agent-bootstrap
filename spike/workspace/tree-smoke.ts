import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SqliteAudit } from "../../src/audit.ts";
import { LocalGitIntegration } from "../../src/git-integration.ts";
import { IntegrationJournal } from "../../src/integration-journal.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { parseProfileLock, profileCatalog } from "../../src/profile-lock.ts";
import { ReviewedIntegration } from "../../src/reviewed-integration.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

const gitBinary = "/usr/bin/git";
const runFile = promisify(execFile);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ALLOW_PROTOCOL: "",
};
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const lockFile = new URL("../../images/profiles.lock.json", import.meta.url);
const baseImage =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const mainRef = "refs/heads/main";

function seed(repository: string) {
  const git = (argv: string[], input = "") =>
    execFileSync(gitBinary, argv, {
      cwd: repository,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...gitEnv,
        GIT_AUTHOR_NAME: "Fixture Worker",
        GIT_AUTHOR_EMAIL: "worker@example.invalid",
        GIT_COMMITTER_NAME: "Fixture Host",
        GIT_COMMITTER_EMAIL: "host@example.invalid",
      },
    }).trim();
  git(["init", "--bare", "--template=", "--initial-branch=main"]);
  const blob = (contents: string) =>
    git(["hash-object", "-w", "--stdin"], contents);
  const file = (name: string, contents: string, mode = "100644") =>
    `${mode} blob ${blob(contents)}\t${name}\n`;
  const tree = (...entries: string[]) => git(["mktree"], entries.join(""));
  const dir = (name: string, oid: string) => `040000 tree ${oid}\t${name}\n`;
  const docs = dir("docs", tree(file("readme.md", "Fixture docs\n")));
  const other = dir("other", tree(file("keep.txt", "Keep this file\n")));
  const first = git([
    "commit-tree",
    tree(docs, other),
    "-m",
    "Add fixture docs",
  ]);
  const lib = dir("lib", tree(file("util.sh", "#!/bin/sh\necho original\n")));
  const second = git([
    "commit-tree",
    tree(dir("app", tree(lib)), docs, other),
    "-p",
    first,
    "-m",
    "Add library",
  ]);
  const app = dir(
    "app",
    tree(lib, file("main.sh", "#!/bin/sh\necho main\n", "100755")),
  );
  const head = git([
    "commit-tree",
    tree(app, docs, other),
    "-p",
    second,
    "-m",
    "Add executable",
  ]);
  git(["update-ref", mainRef, head, "0".repeat(40)]);
  const commits = Number(git(["rev-list", "--count", mainRef]));
  assert.ok(commits >= 3);
  return { head, commits };
}

const sh = (script: string, timeoutMs = 60_000) => ({
  argv: ["/bin/sh", "-ec", script],
  timeoutMs,
});
const collect = `printf '%s\n' '{"tool":"collect"}'`;
const sparseChecks = `test ! -e other/keep.txt
test -f app/main.sh`;
const editUtil = `printf '%s\n' '#!/bin/sh' 'echo tree-smoke-updated' > app/lib/util.sh`;
const utilCheck = `grep -Fxq 'echo tree-smoke-updated' app/lib/util.sh`;
const pass = `printf '%s\n' '{"review":"pass","tests":{"passed":4,"failed":0,"failures":[]}}'`;
const runs = [
  {
    name: "positive",
    tree: {},
    edit: `${editUtil}
rm docs/readme.md
printf '%s\n' '#!/bin/sh' 'echo new' > app/new.sh
chmod 755 app/new.sh
chmod 644 app/main.sh
stat=$(git diff --stat)
test -n "$stat"`,
    suite: `test -f app/new.sh && test -x app/new.sh || exit 1
test ! -e docs/readme.md
test -f app/main.sh && test ! -x app/main.sh || exit 1
${utilCheck}`,
    changes: [
      ["app/lib/util.sh", "100644", "100644", "M"],
      ["app/main.sh", "100755", "100644", "M"],
      ["app/new.sh", "000000", "100755", "A"],
      ["docs/readme.md", "100644", "000000", "D"],
    ],
  },
  {
    name: "scope-denied",
    tree: { scope: ["app/"] },
    // An otherwise eligible change makes silently ignoring the new file fail.
    edit: `${sparseChecks}
${editUtil}
mkdir -p other
printf '%s\n' 'Outside scope' > other/sneaky.txt`,
    suite: "exit 1",
    changes: [],
  },
  {
    name: "scope-positive",
    tree: { scope: ["app/"] },
    edit: `${sparseChecks}
${editUtil}`,
    suite: `${utilCheck}
test -x app/main.sh
grep -Fxq 'Fixture docs' docs/readme.md
grep -Fxq 'Keep this file' other/keep.txt`,
    changes: [["app/lib/util.sh", "100644", "100644", "M"]],
  },
] as const;

async function main() {
  let stage = "setup";
  try {
    const [binary] = process.argv.slice(2);
    const home = process.env["MSB_HOME"];
    assert.ok(binary && isAbsolute(binary) && home && isAbsolute(home));
    const lock = parseProfileLock(await readFile(lockFile, "utf8"));
    const browser = lock.profiles["browser"];
    assert.ok(browser);
    const profiles = profileCatalog(baseImage, lock);
    const digests = {
      browser: browser.image.slice(-64),
      base: baseImage.slice(-64),
    };
    await mkdir(local, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(local, "tree-smoke-"));
    const report: unknown[] = [];
    try {
      const audit = new SqliteAudit(join(root, "audit.sqlite"));
      try {
        const runtime = new MicrosandboxRuntime({
          binary,
          home,
          profiles,
          stagingRoot: join(root, "sandboxes"),
        });
        const host = new TrustedHost(audit, runtime, profiles);
        const journalRoot = join(root, "journal");
        await mkdir(journalRoot, { mode: 0o700 });

        const invocation = (
          id: string,
          role: "Worker" | "Reviewer" | "Verification",
          profile: keyof typeof digests,
        ) => {
          const trail = audit.read(id);
          const start = trail[0];
          const create = trail.find(
            (event) =>
              event.kind === "operation.requested" &&
              event.operation === "sandbox.create",
          );
          const last = trail.at(-1);
          assert.equal(start?.kind, "invocation.started");
          assert.equal(start.role, role);
          assert.equal(create?.profile, profile);
          assert.equal(create.image, digests[profile]);
          assert.equal(last?.kind, "invocation.finished");
          assert.equal(last.outcome, "ok");
          if (role === "Worker") {
            for (const operation of ["sandbox.exec", "sandbox.collect"]) {
              assert.ok(
                trail.some(
                  (event) =>
                    event.kind === "operation.finished" &&
                    event.operation === operation &&
                    event.outcome === "ok",
                ),
                operation,
              );
            }
          }
          return {
            role: start.role,
            profile: create.profile,
            image: create.image,
            outcome: last.outcome,
          };
        };

        for (const run of runs) {
          stage = `${run.name} setup`;
          const repository = join(root, `${run.name}.git`);
          await mkdir(repository, { mode: 0o700 });
          const { head, commits } = seed(repository);
          const git = new LocalGitIntegration({
            binary: gitBinary,
            repository,
            branch: "main",
            stagingRoot: join(root, "worktrees"),
          });
          const readGit = async (...argv: string[]) =>
            (
              await runFile(gitBinary, argv, { cwd: repository, env: gitEnv })
            ).stdout.trim();
          const journal = new IntegrationJournal(journalRoot, randomUUID());
          const workerId = randomUUID();
          const flow = new ReviewedIntegration(git, host, journal, {
            tree: run.tree,
            worker: sh(`cd /workspace
test "$(git log --oneline | wc -l)" -eq ${commits}
status=$(git status --porcelain)
test -z "$status"
${run.edit}
${collect}`),
            workerSandbox: { profile: "browser" },
            reviewer: sh(`printf '%s\n' '{"review":"pass"}'`),
            reviewerSandbox: { profile: "base" },
            verification: {
              command: sh("sh /review/suite/test.sh", 120_000),
              profile: "browser",
              suite: [
                {
                  path: "test.sh",
                  bytes: new TextEncoder().encode(
                    `set -eu\ncd /workspace\n${run.suite}\n${pass}\n`,
                  ),
                },
              ],
            },
          });

          stage = `${run.name} prepareCandidate`;
          if (run.name === "scope-denied") {
            await assert.rejects(
              flow.prepareCandidate(workerId),
              /Worker did not produce an eligible change/,
            );
            const Worker = invocation(workerId, "Worker", "browser");
            const events = await journal.read();
            assert.deepEqual(
              events.map((event) => event.kind),
              ["requested", "denied"],
            );
            const denied = events.at(-1);
            assert.ok(denied?.kind === "denied" && denied.reason === "worker");
            assert.equal(await readGit("rev-parse", mainRef), head);
            const changedPaths = (
              await readGit("diff-tree", "-r", "--name-only", head, mainRef)
            )
              .split("\n")
              .filter(Boolean);
            assert.deepEqual(changedPaths, []);
            report.push({
              run: run.name,
              result: "denied",
              changedPaths,
              verification: null,
              invocations: { Worker },
            });
            continue;
          }

          const pin = await flow.prepareCandidate(workerId);
          const Worker = invocation(workerId, "Worker", "browser");
          assert.equal(pin.base, head);
          stage = `${run.name} reviewCandidate`;
          assert.equal((await flow.reviewCandidate()).review, "pass");
          stage = `${run.name} decide`;
          await flow.decide(pin, "approve");
          stage = `${run.name} integrate`;
          const result = await flow.integrate();
          const events = await journal.read();
          const review = events.find(
            (event) => event.kind === "review.submitted",
          );
          const verification = events.find(
            (event) => event.kind === "verification.finished",
          );
          assert.ok(review && verification);
          const invocations = {
            Worker,
            Reviewer: invocation(review.run, "Reviewer", "base"),
            Verification: invocation(
              verification.run,
              "Verification",
              "browser",
            ),
          };
          assert.equal(verification.review, "pass");
          assert.ok("tests" in verification);
          assert.deepEqual(verification.tests, { passed: 4, failed: 0 });
          assert.equal(result, "completed");

          stage = `${run.name} Git assertions`;
          assert.equal(await readGit("rev-parse", mainRef), pin.candidate);
          assert.equal(
            await readGit("show", "-s", "--format=%P", mainRef),
            head,
          );
          assert.equal(
            await readGit("show", "-s", "--format=%an <%ae>", mainRef),
            "Agent Bootstrap <agent-bootstrap@localhost>",
          );
          const raw = await readGit(
            "diff-tree",
            "-r",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            head,
            mainRef,
          );
          const changes = raw.split("\n").map((line) => {
            const match =
              /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])\t(.+)$/.exec(
                line,
              );
            assert.ok(match, line);
            const [, oldMode, newMode, oldOid, newOid, status, path] = match;
            if (path === "app/main.sh") assert.equal(oldOid, newOid);
            return [path, oldMode, newMode, status];
          });
          assert.deepEqual(changes, run.changes);
          report.push({
            run: run.name,
            result,
            changedPaths: changes.map(([path]) => path),
            verification,
            invocations,
          });
        }
        stage = "cleanup";
      } finally {
        audit.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (process.env["SMOKE_DEBUG"] === "1") console.error(error);
    console.error(`Tree smoke stopped at ${stage}.`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
