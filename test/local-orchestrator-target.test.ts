import {
  addProject,
  moveProject,
  removeProject,
} from "../src/config/projects.ts";
import { parseConfig } from "../src/config/layers.ts";
import { ConfigError } from "../src/config/messages.ts";
import { configEnv } from "./config-fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/local-orchestrator/cli.ts";
import {
  conciergeContext,
  snapshotConciergeRepo,
} from "../src/local-orchestrator/concierge.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import {
  resolveTarget,
  TargetError,
} from "../src/local-orchestrator/target.ts";
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
    configEnv(join(bootstrap, "..")),
  );
  return { code, stdout, stderr };
}

test("registered worktree paths resolve to private state and named volumes", () =>
  fixture(async (root) => {
    const bootstrap = await repo(join(root, "bootstrap"));
    const one = await repo(join(root, "one", "dagq-lite"));
    const two = await repo(join(root, "two", "dagq-lite"));
    const env = configEnv(root);
    await assert.rejects(
      resolveTarget(undefined, bootstrap, env),
      /not registered/,
    );
    addProject(bootstrap, undefined, env);
    addProject(one, undefined, env);
    addProject(two, "other", env);
    const alias = join(root, "alias");
    await symlink(one, alias);
    const defaultTarget = await resolveTarget(undefined, bootstrap, env);
    assert.equal(
      defaultTarget.directory,
      join(env.XDG_STATE_HOME!, "agent-bootstrap/projects/bootstrap"),
    );
    assert.match(defaultTarget.volume, /^lo-concierge-bootstrap-[a-f0-9]{12}$/);
    const first = await resolveTarget(one, bootstrap, env);
    assert.deepEqual(await resolveTarget(alias, bootstrap, env), first);
    assert.match(first.volume, /^lo-concierge-dagq-lite-[a-f0-9]{12}$/);
    assert.notEqual(
      (await resolveTarget(two, bootstrap, env)).directory,
      first.directory,
    );
    removeProject("dagq-lite", env);
    removeProject("other", env);
    addProject(two, "dagq-lite", env);
    assert.notEqual(
      (await resolveTarget(two, bootstrap, env)).volume,
      first.volume,
    );

    const localPath = join(root, ".LOCAL");
    await mkdir(localPath);
    const localRepo = await repo(join(localPath, "inside"));
    const outsideAlias = join(root, "outside-alias");
    await symlink(localRepo, outsideAlias);
    const insideAlias = join(localPath, "inside-alias");
    await symlink(two, insideAlias);
    addProject(localRepo, undefined, env);
    for (const path of [localRepo, outsideAlias, insideAlias])
      await assert.rejects(
        resolveTarget(path, bootstrap, env),
        /must be outside \.local/,
      );
    const nested = join(one, "sub");
    await mkdir(nested);
    const bare = join(root, "bare.git");
    git(one, "clone", "--bare", "--", one, bare);
    for (const path of [nested, bare, root])
      await assert.rejects(
        resolveTarget(path, bootstrap, env),
        /Git worktree root/,
      );
    await assert.rejects(resolveTarget(join(root, "missing"), bootstrap, env), {
      constructor: ConfigError,
      message: /project\.identity/,
    });
    await assert.rejects(resolveTarget(undefined, join(root, "missing"), env), {
      code: "ENOENT",
    });
    await rm(join(two, ".git"), { recursive: true });
    await assert.rejects(resolveTarget(two, bootstrap, env), {
      constructor: TargetError,
      message: /project\.identity.*registered Git directory is missing/,
      next: "Run agent-bootstrap project move <name> <path>.",
    });
  }));

test("the user repository root contains the target and its disclosed relative path", () =>
  fixture(async (root) => {
    const allowed = await repo(join(root, "Allowed"));
    const descendant = await repo(join(allowed, "Team", "Worktree"));
    const outside = await repo(join(root, "Allowed-sibling"));
    const foo = await repo(join(allowed, "foo"));
    const alias = join(allowed, "alias");
    await symlink(outside, alias);
    addProject(outside, "existing", configEnv(root));
    const env = configEnv(root, allowed);
    addProject(allowed, "root", env);
    addProject(descendant, "child", env);
    assert.equal(
      (await resolveTarget(allowed, allowed, env)).repositoryPath,
      ".",
    );
    assert.equal(
      (await resolveTarget(descendant, allowed, env)).repositoryPath,
      "Team/Worktree",
    );
    if (process.platform === "darwin" && existsSync(join(root, "allowed"))) {
      assert.equal(
        (
          await resolveTarget(
            join(root, "allowed", "team", "worktree"),
            allowed,
            env,
          )
        ).repositoryPath,
        "Team/Worktree",
      );
    }
    const parent = `${allowed}/../Allowed-sibling`;
    const inRootParent = `${allowed}/Team/../Team/Worktree`;
    assert.equal(
      (await resolveTarget(inRootParent, allowed, env)).repositoryPath,
      "Team/Worktree",
    );
    execFileSync(
      process.execPath,
      [
        "--no-env-file",
        fileURLToPath(new URL("../bin/agent-bootstrap.ts", import.meta.url)),
        "project",
        "add",
        "../foo",
      ],
      {
        cwd: join(allowed, "Team"),
        env: { ...env, PATH: "/usr/bin:/bin" },
        stdio: "pipe",
      },
    );
    assert.equal((await resolveTarget(foo, allowed, env)).project.name, "foo");
    const outsideRoot = {
      message:
        "Invalid configuration: repositories.root. The target is outside repositories.root.",
      next: /Set repositories\.root in the user configuration to a directory that contains the target/,
    };
    for (const path of [outside, alias, parent]) {
      assert.throws(() => addProject(path, "bad", env), {
        constructor: ConfigError,
        ...outsideRoot,
      });
      assert.throws(() => moveProject("child", path, env), {
        constructor: ConfigError,
        ...outsideRoot,
      });
      await assert.rejects(resolveTarget(path, allowed, env), {
        constructor: TargetError,
        ...outsideRoot,
      });
    }
    await assert.rejects(resolveTarget(undefined, outside, env), {
      constructor: TargetError,
      ...outsideRoot,
    });
    await rm(join(outside, ".git"), { recursive: true });
    await assert.rejects(resolveTarget(outside, allowed, env), {
      constructor: TargetError,
      ...outsideRoot,
    });

    const invalidEnv = configEnv(root, join(root, "missing-root"));
    assert.throws(
      () => addProject(allowed, "bad", invalidEnv),
      /repositories\.root/,
    );
    await assert.rejects(
      resolveTarget(allowed, allowed, invalidEnv),
      /repositories\.root/,
    );
  }));

test("the repository root is an absolute path set in user configuration only", () => {
  const config = { version: 1, repositories: { root: "/worktrees" } };
  assert.deepEqual(parseConfig(config, "user"), config);
  for (const layer of ["local", "approved"] as const)
    assert.throws(() => parseConfig(config, layer), /repositories/);
  assert.throws(
    () =>
      parseConfig({ version: 1, repositories: { root: "worktrees" } }, "user"),
    /repositories\.root/,
  );
});

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

    const env = configEnv(root);
    addProject(target, undefined, env);
    const resolved = await resolveTarget(target, bootstrap, env);
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
    const env = configEnv(root);
    addProject(bootstrap, undefined, env);
    addProject(one, undefined, env);
    addProject(two, "other", env);
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
    const { directory, configDirectory } = await resolveTarget(
      one,
      bootstrap,
      env,
    );
    const path = join(configDirectory, "local.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const clear = ["--target", one, "verification", "clear"];
    assert.match((await cli(bootstrap, clear)).stderr, /requires a terminal/);
    assert.match(
      (await cli(bootstrap, clear, () => "yes")).stderr,
      /Confirmation did not match/,
    );
    assert.equal(existsSync(path), true);
    assert.equal((await cli(bootstrap, clear, accept)).code, 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1 });
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
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1 });
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
