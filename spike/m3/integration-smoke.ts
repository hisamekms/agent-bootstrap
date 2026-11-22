import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { SqliteAudit } from "../../src/audit.ts";
import { LocalGitIntegration } from "../../src/git-integration.ts";
import { IntegrationJournal } from "../../src/integration-journal.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { ProfileCatalog } from "../../src/sandbox-profiles.ts";
import { ReviewedIntegration } from "../../src/reviewed-integration.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

const gitBinary = "/usr/bin/git";
const path = "hello.txt";
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";

export function seed(directory: string) {
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
  const blob = git(["hash-object", "-w", "--stdin"], "hello from base\n");
  const tree = git(["mktree"], `100644 blob ${blob}\t${path}\n`);
  const commit = git(["commit-tree", tree, "-m", "Fixture baseline"]);
  git(["update-ref", "refs/heads/main", commit, "0".repeat(40)]);
}

const command = (script: string) => ({
  argv: ["/bin/sh", "-ec", script],
  timeoutMs: 8000,
});

async function main() {
  const [mode, binary, existing] = process.argv.slice(2);
  const home = process.env.MSB_HOME;
  assert.ok(mode === "prepare" || mode === "review" || mode === "trace");
  const id =
    mode === "prepare" ? randomUUID() : mode === "trace" ? binary : existing;
  assert.ok(id && /^[a-f0-9-]{36}$/.test(id));
  assert.ok(mode !== "review" || (process.stdin.isTTY && process.stdout.isTTY));
  const root = join(local, `m3-${id}`);
  const repository = join(root, "repository.git");
  const journalDir = join(root, "journal");
  if (mode === "prepare") {
    assert.ok(binary && isAbsolute(binary) && home && isAbsolute(home));
    await mkdir(local, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    await mkdir(repository, { mode: 0o700 });
    await mkdir(journalDir, { mode: 0o700 });
    seed(repository);
  }
  assert.equal(await realpath(root), join(await realpath(local), `m3-${id}`));
  const journal = new IntegrationJournal(journalDir, id);
  const auditFile = join(root, "audit.sqlite");
  if (mode === "trace") {
    const events = await journal.read();
    const traces = new SqliteAudit(auditFile, { readonly: true });
    try {
      const roles = events.flatMap((event) =>
        "run" in event ? traces.read(event.run) : [],
      );
      console.log(JSON.stringify({ id, events, roles }, null, 2));
    } finally {
      traces.close();
    }
    return;
  }
  assert.ok(binary && isAbsolute(binary) && home && isAbsolute(home));
  const git = new LocalGitIntegration({
    binary: gitBinary,
    repository,
    branch: "main",
    stagingRoot: join(root, "worktrees"),
  });
  const audit = new SqliteAudit(auditFile);
  try {
    const runtime = new MicrosandboxRuntime({
      binary,
      home,
      profiles: new ProfileCatalog({ base: { image } }),
      stagingRoot: join(root, "sandboxes"),
    });
    const integration = new ReviewedIntegration(
      git,
      new TrustedHost(audit, runtime),
      journal,
      {
        path,
        worker: command(`
        test "$(cat /workspace/hello.txt)" = "hello from base"
        printf '%s\\n' "hello from Worker" > /workspace/hello.txt
        printf '%s' '{"tool":"collect"}'
      `),
        reviewer: command(`
        if (printf reject >> /review/candidate.source) 2>/dev/null; then exit 9; fi
        grep -Fqx '+hello from Worker' /review/candidate.diff
        test "$(cat /review/candidate.source)" = "hello from Worker"
        printf '%s' '{"review":"pass"}'
      `),
        verification: command(`
        test "$(cat /review/candidate.source)" = "hello from Worker"
        printf '%s' '{"review":"pass"}'
      `),
      },
    );
    if (mode === "prepare") {
      const pin = await integration.prepare();
      assert.equal(await git.head(), pin.base);
      console.log(JSON.stringify({ id, ...pin }));
      return;
    }
    const events = await journal.read();
    const [request] = events;
    const candidate = events.find(
      (event) => event.kind === "candidate.created",
    );
    const review = events.at(-1);
    assert.ok(
      request?.kind === "requested" &&
        candidate &&
        review?.kind === "review.submitted",
    );
    const pin = {
      base: request.base,
      candidate: candidate.candidate,
      digest: candidate.digest,
    };
    const bytes = await git.diff(pin.base, pin.candidate);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.digest);
    const diff = new TextDecoder().decode(bytes);
    console.log(JSON.stringify({ ...pin, review: review.review }));
    console.log(
      diff.replace(
        /[^\x20-\x7e\n]/gu,
        (character) => `\\u{${character.codePointAt(0)?.toString(16)}}`,
      ),
    );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await terminal.question(
        `Type approve ${pin.candidate} to integrate, or reject: `,
      );
      if (answer !== "reject" && answer !== `approve ${pin.candidate}`) return;
      await integration.decide(pin, answer === "reject" ? "reject" : "approve");
      console.log(`Integration ${await integration.integrate()}.`);
    } finally {
      terminal.close();
    }
  } finally {
    audit.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error(
      "M3 smoke stopped. Inspect the local integration journal for its last committed event.",
    );
    process.exitCode = 1;
  }
}
