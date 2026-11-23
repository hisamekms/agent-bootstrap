import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../src/local-orchestrator/cli.ts";
import {
  conciergeContext,
  conciergeVolumeName,
  snapshotConciergeRepo,
} from "../src/local-orchestrator/concierge.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import { resolveTarget } from "../src/local-orchestrator/target.ts";
import {
  configuredVerification,
  parseVerificationConfig,
} from "../src/local-orchestrator/verification.ts";
import { verificationResult } from "../src/reviewed-integration.ts";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "lo-target-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@localhost",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@localhost",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function repo(root: string, branch = "main") {
  await mkdir(root, { recursive: true });
  git(
    root,
    "init",
    "--template=",
    `--initial-branch=${branch}`,
    "--object-format=sha1",
  );
  git(root, "commit", "--allow-empty", "-m", "base");
  return root;
}

async function cli(
  bootstrap: string,
  args: string[],
  answer?: (prompt: string) => string | Promise<string>,
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      stdin: process.stdin,
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      isTTY: answer !== undefined,
      prompt: (question) => answer?.(question),
    },
    bootstrap,
  );
  return { code, stdout, stderr };
}

test("validates worktree roots and isolates canonical targets with the same basename", () =>
  fixture(async (root) => {
    const bootstrap = await repo(join(root, ".local", "bootstrap"));
    const one = await repo(join(root, "one", "dagq-lite"));
    const two = await repo(join(root, "two", "dagq-lite"));
    const alias = join(root, "alias");
    await symlink(one, alias);
    const defaultTarget = await resolveTarget(undefined, bootstrap);
    assert.deepEqual(await resolveTarget(bootstrap, bootstrap), defaultTarget);
    assert.equal(
      defaultTarget.directory,
      join(bootstrap, ".local/local-orchestrator"),
    );
    assert.equal(defaultTarget.volume, conciergeVolumeName(bootstrap));
    const first = await resolveTarget(one, bootstrap);
    assert.deepEqual(await resolveTarget(alias, bootstrap), first);
    assert.equal(first.repoRoot, one);
    assert.match(first.directory, /\/targets\/dagq-lite-[a-f0-9]{12}$/);
    assert.equal(
      first.volume,
      `lo-concierge-${first.directory.split("/").at(-1)}`,
    );
    assert.notEqual(
      (await resolveTarget(two, bootstrap)).directory,
      first.directory,
    );

    const nested = join(one, "sub");
    await mkdir(nested);
    const inside = await repo(join(bootstrap, ".local", "inside"));
    const insideAlias = join(root, "inside-alias");
    await symlink(inside, insideAlias);
    const bare = join(root, "bare.git");
    git(one, "clone", "--bare", "--", one, bare);
    for (const path of [
      nested,
      bare,
      await repo(join(root, "no-main"), "work"),
      root,
    ])
      await assert.rejects(
        resolveTarget(path, bootstrap),
        /Git worktree root with a local main/,
      );
    for (const path of [inside, insideAlias])
      await assert.rejects(resolveTarget(path, bootstrap), /outside .local/);
    await assert.rejects(
      resolveTarget(join(root, "missing"), bootstrap),
      /inaccessible/,
    );
  }));

test("external snapshots pin local main and limit Planner context to the target's root docs and listing", () =>
  fixture(async (root) => {
    const bootstrap = await repo(join(root, "bootstrap"));
    const target = await repo(join(root, "dagq-lite"));
    await mkdir(join(target, "docs/local-orchestrator"), { recursive: true });
    await writeFile(
      join(target, "docs/local-orchestrator/stage3.md"),
      "target doc",
    );
    await writeFile(join(target, "AGENTS.md"), "target instructions");
    await writeFile(join(target, "README.md"), "target readme");
    git(target, "add", ".");
    git(target, "commit", "-m", "context");
    const main = git(target, "rev-parse", "main");
    git(target, "switch", "-c", "work");
    await writeFile(join(target, "README.md"), "uncommitted");

    const resolved = await resolveTarget(target, bootstrap);
    const snapshot = await snapshotConciergeRepo(
      target,
      randomUUID(),
      undefined,
      false,
      resolved,
    );
    assert.equal(snapshot.commit, main);
    assert.ok(
      snapshot.dir.startsWith(join(resolved.directory, "snapshots") + "/"),
    );
    const context = await conciergeContext(snapshot, resolved.isDefault);
    assert.deepEqual(
      context.map(({ path }) => path),
      ["files.txt", "AGENTS.md", "README.md"],
    );
    assert.match(
      Buffer.from(context[0]!.bytes).toString(),
      /docs\/local-orchestrator\/stage3\.md/,
    );
    assert.equal(Buffer.from(context[2]!.bytes).toString(), "target readme");
    assert.equal(existsSync(join(target, ".local")), false);
  }));

test("verification CLI scopes audited config to each target and requires a typed terminal answer", () =>
  fixture(async (root) => {
    const bootstrap = await repo(join(root, "bootstrap"));
    const one = await repo(join(root, "one"));
    const two = await repo(join(root, "two"));
    const set = [
      "--target",
      one,
      "verification",
      "set",
      "--profile",
      "base",
      "--",
      "test",
      "-f",
      "a; echo literal",
    ];
    assert.match((await cli(bootstrap, set)).stderr, /requires a terminal/);
    assert.match(
      (await cli(bootstrap, set, () => "yes")).stderr,
      /Confirmation did not match/,
    );
    const accept = (prompt: string) => /^Type "([^"]+)"/.exec(prompt)![1]!;
    const result = await cli(bootstrap, set, accept);
    assert.equal(result.code, 0, result.stderr);
    const expected = {
      profile: "base",
      argv: ["test", "-f", "a; echo literal"],
    };
    const show = ["verification", "show"];
    assert.deepEqual(
      JSON.parse((await cli(bootstrap, ["--repo", one, ...show])).stdout),
      expected,
    );
    assert.equal(
      JSON.parse((await cli(bootstrap, ["--target", two, ...show])).stdout),
      null,
    );
    assert.equal(JSON.parse((await cli(bootstrap, show)).stdout), null);
    const { directory } = await resolveTarget(one, bootstrap);
    const path = join(directory, "config.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const clear = ["--target", one, "verification", "clear"];
    assert.match((await cli(bootstrap, clear)).stderr, /requires a terminal/);
    assert.match(
      (await cli(bootstrap, clear, () => "yes")).stderr,
      /Confirmation did not match/,
    );
    assert.equal(existsSync(path), true);
    assert.equal((await cli(bootstrap, clear, accept)).code, 0);
    assert.equal(existsSync(path), false);
    const store = OrchestratorStore.open(join(directory, "state.db"));
    try {
      assert.deepEqual(
        store
          .listEvents({ limit: 10 })
          .toReversed()
          .map(({ kind }) => kind),
        [
          "project.verification-change-authorized",
          "project.verification-set",
          "project.verification-change-authorized",
          "project.verification-cleared",
        ],
      );
    } finally {
      store.close();
    }

    const replacement = [...set.slice(0, -1), "replacement"];
    const stale = await cli(bootstrap, set, async (prompt) => {
      assert.equal((await cli(bootstrap, replacement, accept)).code, 0);
      return accept(prompt);
    });
    assert.match(stale.stderr, /Verification changed/);
    assert.deepEqual(
      JSON.parse((await cli(bootstrap, ["--target", one, ...show])).stdout),
      { profile: "base", argv: ["test", "-f", "replacement"] },
    );
    assert.equal((await cli(bootstrap, clear, accept)).code, 0);

    const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
      Database: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new Database(join(directory, "state.db"));
    try {
      db.exec(`
        CREATE TRIGGER refuse_verification_authorization BEFORE INSERT ON events
        WHEN NEW.kind = 'project.verification-change-authorized'
        BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;
      `);
    } finally {
      db.close();
    }
    assert.equal((await cli(bootstrap, set, accept)).code, 1);
    assert.equal(existsSync(path), false);
  }));

test("verification validates argv bounds and produces only the fixed verdict", () => {
  for (const argv of [
    [],
    [""],
    ["x\0y"],
    ["x".repeat(1025)],
    Array(33).fill("x"),
  ])
    assert.throws(() => parseVerificationConfig({ profile: "base", argv }));
  assert.throws(() =>
    parseVerificationConfig({ profile: "missing", argv: ["true"] }),
  );
  for (const [status, expected] of [
    ["0", { review: "pass" }],
    ["1", { review: "revise", tests: { passed: 0, failed: 1 } }],
  ] as const) {
    const trial = configuredVerification({
      profile: "base",
      argv: [
        "/bin/sh",
        "-c",
        'printf \'{"review":"pass"}\'; printf noise >&2; test "$1" = \'$(exit 99)\' || exit 99; exit "$2"',
        "fixture",
        "$(exit 99)",
        status,
      ],
    });
    const [shell, ...args] = trial.command.argv;
    const response = execFileSync(shell!, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.deepEqual(
      verificationResult({ id: "verification", outcome: "ok", response }),
      expected,
    );
  }
});
