import { addProject } from "../src/config/projects.ts";
import { resolveTarget } from "../src/local-orchestrator/target.ts";
import { configEnv, initConfigRepo } from "./config-fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ALPINE_3_23 } from "../src/image-recipes.ts";
import {
  claudeCodeProvider,
  claudeCodeTools,
  type ClaudeCodeAuth,
} from "../src/claude-code.ts";
import {
  conciergeCommand,
  conciergeContext,
  parseConciergeMode,
  snapshotConciergeRepo,
  startConcierge,
  type ConciergeDeps,
} from "../src/local-orchestrator/concierge.ts";
import type { ExecutionRequester } from "../src/local-orchestrator/host-api.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import { MICROSANDBOX_LIMITS } from "../src/microsandbox.ts";

const auth = {
  mode: "operator-credential",
  variable: "ANTHROPIC_API_KEY",
  header: "x-api-key",
} as const;
const install = {
  binary: "/host/untrusted; binary",
  packageDir: "/host/untrusted packages",
};
const model = "claude-model.1";

async function fixture<T>(
  run: (
    root: string,
    store: OrchestratorStore,
    target: Awaited<ReturnType<typeof resolveTarget>>,
  ) => Promise<T>,
) {
  // macOS keeps the socket path short under /private/tmp; Linux CI has /tmp.
  const root = await mkdtemp(
    join(existsSync("/private/tmp") ? "/private/tmp" : tmpdir(), "lo-test-"),
  );
  try {
    const store = OrchestratorStore.open(join(root, "state.db"));
    try {
      const repo = initConfigRepo(join(root, "repo"));
      const env = configEnv(root);
      addProject(repo, undefined, env);
      return await run(repo, store, await resolveTarget(repo, repo, env));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const snapshotCommit = "a".repeat(40);

const failures = [
  "start",
  "snapshot",
  "context",
  "listen",
  "volume",
  "run",
  "attach",
  "end",
  "close",
] as const;
for (const failure of [undefined, ...failures]) {
  test(
    failure
      ? `Concierge cleans up after ${failure} failure`
      : "Concierge starts and cleans up in order with an exact interactive plan",
    async () => {
      await fixture(async (repoRoot, store, target) => {
        const log: string[] = [];
        const step = (name: string) => {
          log.push(name);
          if (failure === name) throw new Error(name);
        };
        let snapshotDir: string | undefined;
        let socketDir: string | undefined;
        let sessionId: string | undefined;
        let runtimeId: string | undefined;
        const start = store.startSession.bind(store);
        store.startSession = (actor, runtime) => {
          step("start");
          assert.equal(actor, "Concierge");
          assert.match(runtime, /^[0-9a-f-]{36}$/);
          runtimeId = runtime;
          return start(actor, runtime);
        };
        const end = store.endSession.bind(store);
        store.endSession = (session) => {
          assert.equal(session, sessionId);
          step("end");
          end(session);
        };
        const deps: ConciergeDeps = {
          store,
          config: { version: 1 },
          baseImage: ALPINE_3_23.reference,
          auth,
          install,
          async snapshot(root, session) {
            step("snapshot");
            assert.equal(root, repoRoot);
            assert.equal(session, sessionId);
            assert.ok(store.isActiveConciergeSession(session));
            snapshotDir = await mkdtemp(join(repoRoot, "snapshot-"));
            if (failure === "context") {
              // A malformed snapshot fixture makes context collection fail before listen.
              await rm(snapshotDir, { recursive: true });
              await writeFile(snapshotDir, "not a directory");
            }
            return {
              dir: snapshotDir,
              commit: snapshotCommit,
              files: ["AGENTS.md"],
            };
          },
          async listen(options) {
            assert.equal(options.sessionId, sessionId);
            socketDir = dirname(options.socketPath);
            assert.match(
              options.socketPath,
              /^(?:\/private\/tmp|\/tmp|\/var\/folders\/.+)\/lo-[^/]+\/h\.sock$/,
            );
            assert.equal((await lstat(socketDir)).mode & 0o777, 0o700);
            step("listen");
            return {
              async close() {
                assert.equal(
                  store.isActiveConciergeSession(options.sessionId),
                  failure === "end",
                );
                assert.ok(await lstat(snapshotDir!));
                step("close");
              },
            };
          },
          host: {
            async prepareConciergeVolume(name) {
              assert.equal(name, target.volume);
              step("volume");
              return { reused: true };
            },
            async runConcierge(plan, id, use) {
              step("run");
              assert.equal(id, runtimeId);
              assert.deepEqual(plan, {
                sandbox: {
                  profile: "concierge",
                  claude: true,
                  tools: claudeCodeTools(install, "alpine"),
                  provider: claudeCodeProvider(auth),
                  maxLifetimeMs: 28_800_000,
                  interactive: {
                    vsock: { hostPath: join(socketDir!, "h.sock"), port: 5000 },
                    stateVolume: target.volume,
                    snapshotDir,
                  },
                },
              });
              const value = await use({
                async attach(command) {
                  step("attach");
                  assert.deepEqual(command, conciergeCommand({ model }, auth));
                  return { exitCode: 0 };
                },
              });
              return { id, outcome: "ok", value };
            },
            async runPlanner() {
              throw new Error("unexpected Planner");
            },
            async runReviewer() {
              throw new Error("unexpected Reviewer");
            },
          },
        };
        const started = startConcierge(deps, {
          repoRoot,
          target,
          model,
          onSession(id) {
            sessionId = id;
          },
        });
        if (failure) await assert.rejects(started);
        else
          assert.deepEqual(await started, {
            sessionId,
            outcome: "ok",
            exitCode: 0,
          });

        if (sessionId) {
          assert.equal(
            store.isActiveConciergeSession(sessionId),
            failure === "end",
          );
          const events = store.listEvents({ subjectId: sessionId, limit: 3 });
          const snapshotted = failure !== "snapshot";
          assert.deepEqual(
            events.map(({ kind }) => kind),
            [
              ...(failure === "end" ? [] : ["session.ended"]),
              ...(snapshotted ? ["session.snapshot"] : []),
              "session.started",
            ],
          );
          assert.equal(
            store.sessionSnapshotCommit(sessionId),
            snapshotted ? snapshotCommit : null,
          );
          if (snapshotted)
            assert.deepEqual(
              events.find(({ kind }) => kind === "session.snapshot")?.data,
              { snapshotCommit },
            );
        }
        for (const dir of [snapshotDir, socketDir])
          if (dir) await assert.rejects(lstat(dir), { code: "ENOENT" });
        const setup = [
          "start",
          "snapshot",
          "listen",
          "volume",
          "run",
          "attach",
        ];
        const attempted =
          failure === "context"
            ? setup.slice(0, 2)
            : failure && setup.includes(failure)
              ? setup.slice(0, setup.indexOf(failure) + 1)
              : setup;
        const cleanup = failure === "start" ? [] : ["end"];
        if (attempted.includes("volume")) cleanup.push("close");
        assert.deepEqual(log, [...attempted, ...cleanup]);
      });
    },
  );
}

test("Concierge drains a single active Planner and cancels queued work on exit", async () => {
  await fixture(async (repoRoot, store, target) => {
    let requester: ExecutionRequester;
    let firstId: string;
    let secondId: string;
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const result = await startConcierge(
      {
        store,
        config: { version: 1 },
        baseImage: ALPINE_3_23.reference,
        auth,
        install,
        snapshot: async () => ({
          dir: await mkdtemp(join(repoRoot, "snapshot-")),
          commit: snapshotCommit,
          files: [],
        }),
        async listen(options) {
          requester = options.requester;
          return {
            async close() {
              assert.equal(store.getExecution(firstId)?.status, "running");
              assert.equal(
                store.isActiveConciergeSession(options.sessionId),
                false,
              );
              finish.resolve();
            },
          };
        },
        host: {
          async prepareConciergeVolume() {
            return { reused: false };
          },
          async runConcierge(_plan, id, use) {
            await use({
              async attach() {
                const sessionId = store.listEvents({ limit: 1 })[0]!.subjectId;
                const input = {
                  sessionId,
                  mode: "goal-design",
                  brief: "a plan",
                } as const;
                firstId = await requester.requestPlanner(input);
                await entered.promise;
                secondId = await requester.requestPlanner(input);
                assert.equal(store.getExecution(secondId)?.status, "queued");
                return { exitCode: 17 };
              },
            });
            return { id, outcome: "failed" };
          },
          async runPlanner(plan, id) {
            assert.ok(id);
            assert.deepEqual(
              plan.sandbox.readOnlyFiles?.map(({ path }) => path),
              ["request.json", "repo/files.txt"],
            );
            entered.resolve();
            await finish.promise;
            return { id, outcome: "timed-out" };
          },
          async runReviewer() {
            throw new Error("unexpected Reviewer");
          },
        },
      },
      { repoRoot, target, model, mode: "plan" },
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.exitCode, 17);
    assert.equal(store.getExecution(firstId!)?.status, "timed-out");
    assert.equal(store.getExecution(secondId!)?.status, "cancelled");
  });
});

test("Concierge refuses further Planner work after a failed execution audit write", async () => {
  await fixture(async (repoRoot, store, target) => {
    let api: Parameters<NonNullable<ConciergeDeps["listen"]>>[0];
    let plannerCalls = 0;
    const failed = Promise.withResolvers<void>();
    store.startExecution = () => {
      failed.resolve();
      throw new Error("simulated audit failure");
    };
    const deps: ConciergeDeps = {
      store,
      config: { version: 1 },
      baseImage: ALPINE_3_23.reference,
      auth,
      install,
      snapshot: async () => ({
        dir: await mkdtemp(join(repoRoot, "snapshot-")),
        commit: snapshotCommit,
        files: [],
      }),
      async listen(options) {
        api = options;
        return { async close() {} };
      },
      host: {
        async prepareConciergeVolume() {
          return { reused: true };
        },
        async runConcierge(_plan, id, use) {
          const value = await use({
            async attach() {
              const input = {
                mode: "goal-design",
                brief: "plan",
                sessionId: api.sessionId,
              } as const;
              const first = await api.requester.requestPlanner(input);
              await failed.promise;
              await new Promise<void>((resolve) => setImmediate(resolve));
              await assert.rejects(
                api.requester.requestPlanner(input),
                /concierge-runner-failed/,
              );
              assert.equal(store.getExecution(first)?.status, "queued");
              return { exitCode: 0 };
            },
          });
          return { id, outcome: "ok", value };
        },
        async runPlanner() {
          plannerCalls++;
          throw new Error("unexpected Planner");
        },
        async runReviewer() {
          throw new Error("unexpected Reviewer");
        },
      },
    };
    await assert.rejects(
      startConcierge(deps, { repoRoot, target, model }),
      /concierge-drain-failed/,
    );
    assert.equal(plannerCalls, 0);
  });
});

test("Concierge guest command admits only validated options and uses a fixed relay and guest state", () => {
  const alpine = conciergeCommand({ model }, auth);
  const [shell, flags, script] = alpine.argv;
  assert.equal(shell, "/bin/sh");
  assert.equal(flags, "-ec");
  assert.equal(alpine.argv.length, 3);
  assert.equal(alpine.workdir, "/repo");
  execFileSync("/bin/sh", ["-n"], { input: script! });
  assert.match(script!, /sha256sum -c/);
  assert.match(script!, /apk add --no-network --no-cache/);
  assert.ok(
    script!.includes("test \"$ANTHROPIC_API_KEY\" = '$MSB_ANTHROPIC_API_KEY'"),
  );
  assert.ok(script!.includes('["STDIO","VSOCK-CONNECT:2:5000"]'));
  assert.doesNotMatch(script!, /managed-settings/);
  assert.match(script!, /--strict-mcp-config --setting-sources ''/);
  assert.match(
    script!,
    /--append-system-prompt '[^']*get_inbox[^']*Only the operator can answer gates[^']*' \\\n/,
  );
  assert.match(script!, /exec env -i .*HOME=\/state\/home/);
  assert.ok(script!.includes("claude_config=/state/claude"));
  assert.ok(script!.includes('CLAUDE_CONFIG_DIR="$claude_config"'));
  assert.ok(
    script!.includes("--model 'claude-model.1' --permission-mode auto"),
  );
  assert.ok(!script!.includes("--continue"));
  for (const mode of ["default", "acceptEdits", "plan", "auto"] as const) {
    assert.equal(parseConciergeMode(mode), mode);
    const resumed = conciergeCommand({ model, mode, continue: true }, auth);
    assert.ok(
      resumed.argv[2]!.includes(`--permission-mode ${mode} --continue`),
    );
  }
  for (const mode of ["auto; ls", "bypassPermissions", "", ["auto"], null])
    assert.throws(() => parseConciergeMode(mode));
  assert.throws(() =>
    conciergeCommand({ model: "m'; touch /repo/file" }, auth),
  );
  assert.throws(() =>
    conciergeCommand({ model }, {
      ...auth,
      variable: "NAME;touch",
    } as ClaudeCodeAuth),
  );
});

test("snapshot uses committed local main, skips .local, and keeps directories private", async () => {
  await fixture(async (repoRoot, _store, projectTarget) => {
    const git = (...args: string[]) =>
      execFileSync("/usr/bin/git", args, {
        cwd: repoRoot,
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    git("init", "--initial-branch=main");
    await mkdir(join(repoRoot, ".local"));
    await mkdir(join(repoRoot, "docs/local-orchestrator"), { recursive: true });
    await writeFile(
      join(repoRoot, ".local/secret"),
      "excluded even when tracked",
    );
    await writeFile(join(repoRoot, "AGENTS.md"), "committed");
    await writeFile(
      join(repoRoot, ".gitattributes"),
      "AGENTS.md filter=fixture\n",
    );
    await writeFile(
      join(repoRoot, "docs/local-orchestrator/stage1.md"),
      "docs",
    );
    await symlink("AGENTS.md", join(repoRoot, "README.md"));
    git(
      "add",
      "AGENTS.md",
      "README.md",
      ".gitattributes",
      "docs",
      ".local/secret",
    );
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    git("checkout", "-b", "feature");
    await writeFile(
      join(repoRoot, "docs/local-orchestrator/feature.md"),
      "feature",
    );
    git("add", "docs/local-orchestrator/feature.md");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "feature only",
    );
    git("config", "filter.fixture.smudge", "printf filtered");
    git("config", "filter.fixture.required", "true");
    await writeFile(join(repoRoot, "AGENTS.md"), "worktree version");
    await writeFile(join(repoRoot, "untracked.txt"), "untracked");

    const snapshot = await snapshotConciergeRepo(
      repoRoot,
      randomUUID(),
      undefined,
      false,
      projectTarget,
    );
    assert.equal(
      await readFile(join(snapshot.dir, "AGENTS.md"), "utf8"),
      "committed",
    );
    assert.equal((await lstat(snapshot.dir)).mode & 0o7777, 0o700);
    assert.equal(
      (await lstat(join(snapshot.dir, "docs/local-orchestrator"))).mode &
        0o7777,
      0o700,
    );
    for (const path of [".local", "state.db", "untracked.txt"])
      await assert.rejects(lstat(join(snapshot.dir, path)), { code: "ENOENT" });
    assert.deepEqual(
      (await conciergeContext(snapshot)).map(({ path }) => path),
      ["files.txt", "AGENTS.md", "docs/local-orchestrator/stage1.md"],
    );
    assert.ok(!snapshot.files.includes(".local/secret"));
    assert.ok(!snapshot.files.includes("docs/local-orchestrator/feature.md"));
    assert.equal(snapshot.commit, git("rev-parse", "refs/heads/main").trim());
    for (const target of ["../outside", "/absolute"]) {
      await rm(join(repoRoot, "README.md"));
      await symlink(target, join(repoRoot, "README.md"));
      git("add", "README.md");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "unsafe link",
      );
      await assert.rejects(
        snapshotConciergeRepo(
          repoRoot,
          randomUUID(),
          git("rev-parse", "HEAD").trim(),
          false,
          projectTarget,
        ),
        {
          code: "unsafe-input-symlink",
          message: /Replace absolute or escaping symlinks/,
        },
      );
    }
  });
});

test("Planner selection reserves space for request.json and bounds file count, bytes, and listing", async () => {
  await fixture(async (dir) => {
    const docs = "docs/local-orchestrator";
    await mkdir(join(dir, docs), { recursive: true });
    const { files, fileBytes, workspaceBytes } = MICROSANDBOX_LIMITS;
    const names = Array.from(
      { length: files + 5 },
      (_, n) => `${docs}/${String(n).padStart(3, "0")}.md`,
    );
    await Promise.all(
      names.map((path, index) =>
        writeFile(
          join(dir, path),
          Buffer.alloc(
            index === 0 ? fileBytes + 1 : index <= 3 ? fileBytes : 0,
          ),
        ),
      ),
    );
    await writeFile(join(dir, "AGENTS.md"), Buffer.alloc(fileBytes));
    const listing = Array.from(
      { length: 1200 },
      (_, n) => `src/${"a".repeat(230)}${n}`,
    );
    const context = await conciergeContext({
      dir,
      files: [".local/private", "AGENTS.md", ...names, ...listing],
    });
    assert.equal(context.length, files - 1);
    const index = context[0]!;
    assert.equal(index.path, "files.txt");
    const indexText = Buffer.from(index.bytes).toString("utf8");
    assert.ok(indexText.endsWith("\n"));
    assert.ok(!indexText.includes(".local/"));
    assert.ok(!indexText.includes(listing.at(-1)!));
    assert.ok(context.every(({ bytes }) => bytes.byteLength <= fileBytes));
    assert.ok(!context.some(({ path }) => path === names[0]));
    assert.ok(context.some(({ path }) => path === names[1]));
    assert.ok(!context.some(({ path }) => path === names[2]));
    assert.ok(
      context.reduce((size, { bytes }) => size + bytes.byteLength, fileBytes) <=
        workspaceBytes,
    );
  });
});
