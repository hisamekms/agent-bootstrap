import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  configRoot,
  projectConfigDirectory,
  userConfigPath,
  writePrivateConfig,
} from "../src/config/layers.ts";
import { EnvironmentStore } from "../src/environments/store.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { taskEnvironment } from "../src/local-orchestrator/task-environment.ts";
import { createWorkplaceEnvironment } from "../src/local-orchestrator/workplace-environment.ts";
import {
  workplaceEnvironmentAction,
  workplaceStopAction,
} from "../src/local-orchestrator/operator-api.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import { workplaceStop } from "../src/local-orchestrator/workplace.ts";
import { MISE_MSB } from "../src/mise-tools.ts";
import { writeWorkspaceTar } from "../src/oci-image.ts";
import {
  environmentResponsibilityNotice,
  environmentStatus,
} from "../src/onboarding/environment.ts";

const digest = "a".repeat(64);
const profile = {
  image: `localhost/agent-bootstrap/bun@sha256:${digest}`,
  recipeDigest: digest,
  memoryMiB: 2048,
  cpus: 2,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath("/tmp"), "lo-env-"));
  const journal = OrchestratorStore.open(join(root, "state.db"));
  t.after(async () => {
    journal.close();
    await rm(root, { recursive: true, force: true });
  });
  const env = {
    HOME: root,
    MSB_HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const repository = join(root, "repo");
  await Promise.all([
    mkdir(repository, { mode: 0o700 }),
    mkdir(env.XDG_CONFIG_HOME, { mode: 0o700 }),
    mkdir(env.XDG_STATE_HOME, { mode: 0o700 }),
  ]);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", repository, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
    });
  git("init", "-b", "main");
  const commit = (...paths: string[]) => {
    git("add", "--", ...paths);
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.org",
      "commit",
      "-m",
      "Fixture",
    );
  };
  await writeFile(join(repository, "package.json"), "{}");
  commit("package.json");
  const configDirectory = projectConfigDirectory("fixture", env);
  const target = {
    project: {
      version: 1 as const,
      name: "fixture",
      id: "0123456789ab",
      identity: join(repository, ".git"),
    },
    configDirectory,
    env,
  };
  const store = new EnvironmentStore(target.project.id, env);
  let backendCalls = 0;
  const host = {
    env,
    async command() {
      backendCalls++;
      throw new Error("unexpected backend call");
    },
  };
  return {
    target,
    host,
    store,
    journal,
    repository,
    commit,
    backendCalls: () => backendCalls,
  };
}

test("environment confirmation binds the committed tree, destinations and first notice", async (t) => {
  const { target, host, store, journal, repository, commit, backendCalls } =
    await fixture(t);
  const env = createWorkplaceEnvironment({ target, host, profile, journal });
  assert.deepEqual(await env.status(), {
    status: await environmentStatus(target, profile),
    build: null,
  });
  const first = await env.preview();
  assert.deepEqual(
    await workplaceEnvironmentAction(env, "environment.status", {}),
    {
      result: await env.status(),
    },
  );
  assert.deepEqual(
    await workplaceEnvironmentAction(env, "environment.buildPreview", {}),
    {
      result: first,
    },
  );
  assert.deepEqual(
    await workplaceEnvironmentAction(env, "environment.build", {
      confirmation: "bad",
    }),
    {
      error: { code: "invalid-params" },
    },
  );
  assert.deepEqual(
    await workplaceEnvironmentAction(env, "environment.build", {
      confirmation: "0".repeat(64),
    }),
    {
      error: { code: "confirmation-mismatch" },
    },
  );
  assert.deepEqual(first.destinations, ["registry.npmjs.org:443"]);
  assert.equal(first.responsibilityNotice, environmentResponsibilityNotice);

  await writeFile(join(repository, "setup.sh"), "#!/bin/sh\n");
  commit("setup.sh");
  await assert.rejects(env.start(first.confirmation), {
    code: "confirmation-mismatch",
  });
  const second = await env.preview();
  assert.equal(second.key, first.key);
  writePrivateConfig(userConfigPath(target.env), configRoot(target.env), {
    version: 1,
    environment: { allow: ["registry.example.org:8443"] },
  });
  await assert.rejects(env.start(second.confirmation), {
    code: "confirmation-mismatch",
  });
  const third = await env.preview();
  assert.deepEqual(third.destinations, [
    "registry.example.org:8443",
    "registry.npmjs.org:443",
  ]);

  store.prepare();
  await writeFile(join(store.directory, "responsibility-shown"), "1\n", {
    mode: 0o600,
  });
  await assert.rejects(env.start(third.confirmation), {
    code: "confirmation-mismatch",
  });
  assert.equal((await env.preview()).responsibilityNotice, null);
  await env.close();
  await assert.rejects(env.start(third.confirmation), {
    code: "environment-unavailable",
  });
  assert.equal(backendCalls(), 0);
});

test("environment builds reject duplicates and fence backend calls on a failed audit", async (t) => {
  const { target, host, store, journal, backendCalls } = await fixture(t);
  store.prepare();
  await symlink(
    join(store.directory, "unavailable"),
    join(store.directory, "audit.sqlite"),
  );
  const env = createWorkplaceEnvironment({ target, host, profile, journal });
  try {
    const { confirmation, key } = await env.preview();
    const first = workplaceEnvironmentAction(env, "environment.build", {
      confirmation,
    });
    await assert.rejects(env.start(confirmation), {
      code: "environment-build-running",
    });
    assert.deepEqual(await first, { result: { state: "running", key } });

    let state = await env.status();
    for (
      let index = 0;
      state.build?.state === "running" && index < 200;
      index++
    ) {
      await setTimeout(5);
      state = await env.status();
    }
    assert.deepEqual(state, {
      status: { key, state: "missing", hasLock: false, size: 0 },
      build: { state: "failed", key, failure: "env-build-failed" },
    });
    assert.equal(backendCalls(), 0);
    await assert.rejects(env.start(confirmation), {
      code: "confirmation-mismatch",
    });
    const fresh = await env.preview();
    assert.notEqual(fresh.confirmation, confirmation);
    assert.equal(fresh.key, key);
    assert.equal(backendCalls(), 0);
  } finally {
    await env.close();
  }
});

test("Workplace refuses a busy target and fails closed on a failed operator authorization", async (t) => {
  const { target, host, store, journal, backendCalls } = await fixture(t);
  const env = createWorkplaceEnvironment({ target, host, profile, journal });
  const { confirmation } = await env.preview();
  const unlock = store.tryLockBuild();
  assert.ok(unlock);
  try {
    await assert.rejects(env.start(confirmation), {
      code: "environment-build-running",
    });
  } finally {
    unlock();
  }
  assert.deepEqual(
    journal.listEvents({ subjectId: "workplace", limit: 10 }),
    [],
  );
  journal.close();
  await assert.rejects(env.start(confirmation), { code: "write-failed" });
  assert.equal((await env.status()).build, null);
  assert.equal(backendCalls(), 0);
  const available = store.tryLockBuild();
  assert.ok(available);
  available();
});

test("Task auto-build waits for the target holder and uses its published cache", async (t) => {
  const { target, host, store } = await fixture(t);
  const { commit } = await LocalGitIntegration.committedTree(
    target.project.identity,
  );
  const { key } = await environmentStatus(target, profile, store);
  const started = Promise.withResolvers<void>();
  const lock = store.tryLockBuild();
  assert.ok(lock);
  let provisioningCalls = 0;
  const ensure = taskEnvironment(
    {
      profile,
      autoBuild: true,
      allow: [],
      requireAudit() {},
      host: {
        env: host.env,
        store,
        async run() {
          provisioningCalls++;
          throw new Error("unexpected Provisioner invocation");
        },
        async openGateway() {
          provisioningCalls++;
          throw new Error("unexpected gateway");
        },
      },
    },
    {
      recordTaskEnvironment(_id, event) {
        if (event.kind === "environment.started") started.resolve();
      },
    },
    target.project.identity,
  );
  const result = ensure({
    role: "Executor",
    profile: "bun",
    commit,
    executionId: "fixture",
  });
  try {
    await Promise.race([
      started.promise,
      result.then(() => assert.fail("expected cache wait")),
    ]);
    const archive = writeWorkspaceTar([
      {
        path: "node_modules",
        type: "directory",
        mode: 0o755,
        linkname: "",
        data: Buffer.alloc(0),
      },
    ]);
    await store.publish(
      {
        key,
        adapter: "bun",
        profileDigest: digest,
        hasLock: false,
        packages: [],
        size: archive.length,
        createdAt: new Date().toISOString(),
      },
      archive,
    );
  } finally {
    lock();
  }
  const ready = await result;
  ready.release();
  assert.equal(provisioningCalls, 0);
});

test(
  "Workplace stop aborts a running Provisioner and waits for teardown",
  { timeout: 10_000 },
  async (t) => {
    const { target, host, store, journal, repository } = await fixture(t);
    const commit = execFileSync(
      "/usr/bin/git",
      ["-C", repository, "rev-parse", "main"],
      {
        stdio: "pipe",
      },
    )
      .toString()
      .trim();
    const control = workplaceStop(new EventEmitter(), () =>
      assert.fail("forced exit"),
    );
    t.after(() => control.dispose());
    const created = Promise.withResolvers<void>();
    const destroying = Promise.withResolvers<void>();
    const destroyed = Promise.withResolvers<void>();
    let gatewayClosed = false;
    const environment = createWorkplaceEnvironment({
      target,
      profile,
      journal,
      signal: control.signal,
      host: {
        ...host,
        async openGateway() {
          return {
            socksPort: 19100,
            dnsPort: 19153,
            username: "fake",
            password: "fixture",
            quarantined: false,
            async close() {
              gatewayClosed = true;
            },
          };
        },
        async command(_file, args, _env, _timeout, signal) {
          switch (args[MISE_MSB.length]) {
            case "create":
              assert.ok(signal);
              assert.deepEqual(
                journal.listEvents({ subjectId: "workplace", limit: 10 })[0]
                  ?.data,
                {
                  commit,
                  key: preview.key,
                  destinations: preview.destinations,
                  noticeShown: true,
                  origin: "operator-ui",
                },
              );
              created.resolve();
              await once(signal, "abort");
              signal.throwIfAborted();
              assert.fail("expected cancellation");
            case "rm":
              assert.equal(signal, undefined);
              destroying.resolve();
              await destroyed.promise;
              return { code: 0, stdout: "" };
            default:
              assert.fail("unexpected backend call");
          }
        },
      },
    });
    const preview = await environment.preview();
    let stopped = false;
    const session = once(control.signal, "abort").then(async () => {
      await environment.close();
      stopped = true;
    });
    try {
      assert.deepEqual(await environment.start(preview.confirmation), {
        state: "running",
        key: preview.key,
      });
      await Promise.race([
        created.promise,
        session.then(() => assert.fail("session ended early")),
      ]);
      const { revision } = journal.workplaceStopPreview();
      assert.deepEqual(
        workplaceStopAction(journal, control, "workplace.stop", {
          revision,
          confirm: "Workplace を終える",
        }),
        { result: { stopping: true } },
      );
      await destroying.promise;
      assert.equal(stopped, false);
      assert.equal(gatewayClosed, false);
      assert.equal(store.tryLockBuild(), undefined);
    } finally {
      control.stop();
      destroyed.resolve();
      await session;
    }
    assert.equal(gatewayClosed, true);
    const unlock = store.tryLockBuild();
    assert.ok(unlock);
    unlock();
  },
);
