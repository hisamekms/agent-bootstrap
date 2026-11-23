import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  configRoot,
  loadConfig,
  parseConfig,
  projectConfigDirectory,
  userConfigPath,
  userStateDirectory,
  writePrivateConfig,
} from "../src/config/layers.ts";
import { ConfigError } from "../src/config/messages.ts";
import { migrate } from "../src/config/migrate.ts";
import { addProject, removeProject } from "../src/config/projects.ts";
import { loadClaudeConfig } from "../src/local-orchestrator/claude-config.ts";
import {
  createClaudePolicy,
  managedClaudeSettings,
} from "../src/local-orchestrator/claude-policy.ts";
import { runBootstrap, type BootstrapIo } from "../src/onboarding/cli.ts";
import { localActorHarnesses } from "../src/actors.ts";
import { doctor, systemHost } from "../src/onboarding/prerequisites.ts";
import {
  MountBusy,
  Volume,
  type VolumeCommand,
} from "../src/volumes/volume.ts";
import { configEnv, initConfigRepo } from "./config-fixture.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "declared-volumes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = configEnv(root);
  const definition = {
    image: join(root, "volume.sparseimage"),
    keychainService: "volume-service",
    attach: "while-running",
  } as const;
  let attachment = "";
  let detachFailure = false;
  let attachedDevice: number | undefined;
  let attachFault: "symlink" | "owner" | "device" | undefined;
  const symlinkTarget = join(root, "symlink-target");
  const events: { command: string; args: string[]; input?: Buffer }[] = [];
  const command: VolumeCommand = (file, args, input) => {
    const [command] = args as [string];
    events.push({
      command,
      args,
      ...(input ? { input: Buffer.from(input) } : {}),
    });
    if (file.endsWith("/plutil"))
      return {
        status: 0,
        stdout: Buffer.from(
          JSON.stringify({
            images: attachment
              ? [
                  {
                    "image-path": definition.image,
                    "system-entities": [
                      {
                        "mount-point": attachment,
                        "dev-entry": "/dev/disk99s1",
                      },
                    ],
                  },
                ]
              : [],
          }),
        ),
      };
    if (command === "create")
      writeFileSync(definition.image, "", { mode: 0o600 });
    if (command === "isencrypted")
      return { status: 0, stdout: Buffer.from("encrypted: YES\n") };
    if (command === "attach") {
      attachment = args[args.indexOf("-mountpoint") + 1]!;
      chmodSync(attachment, 0o755);
      attachedDevice = lstatSync(attachment).dev;
      if (attachFault === "symlink") {
        rmSync(attachment, { recursive: true });
        mkdirSync(symlinkTarget, { mode: 0o755 });
        symlinkSync(symlinkTarget, attachment);
      }
    }
    if (command === "detach") {
      if (detachFailure) return { status: 1, stdout: Buffer.alloc(0) };
      attachment = "";
    }
    if (command === "find-generic-password")
      return args.includes("-w")
        ? { status: 0, stdout: Buffer.from("volume-fixture-passphrase\n") }
        : { status: 44, stdout: Buffer.alloc(0) };
    return { status: 0, stdout: Buffer.alloc(0) };
  };
  return {
    root,
    env,
    definition,
    volume: () =>
      new Volume(definition, userStateDirectory(env), command, {
        volume: "private",
        mount: "example",
        mountIo: {
          deviceNumber(path) {
            assert.equal(path, "/dev/disk99s1");
            return attachedDevice;
          },
          rootStat(fd) {
            const info = fstatSync(fd);
            return {
              dev: info.dev + Number(attachFault === "device"),
              uid: info.uid + Number(attachFault === "owner"),
              isDirectory: () => info.isDirectory(),
            };
          },
        },
      }),
    setAttachFault: (fault: typeof attachFault) => {
      attachFault = fault;
    },
    symlinkTarget,
    events,
    failDetach: () => {
      detachFailure = true;
    },
  };
}

const mount = {
  volume: "private",
  dir: "parent",
  path: "/mnt/example",
  actors: ["Executor"],
  env: "CLAUDE_CONFIG_DIR",
} as const;
const audit = () => {};

test("encrypted image initialization and independent directory leases keep passphrases off argv", async (t) => {
  const { volume, events } = fixture(t);
  const first = volume();
  const second = volume();
  first.init();
  assert.equal(lstatSync(first.mount).mode & 0o7777, 0o700);
  assert.deepEqual(first.status(), { mounted: false, active: 0, stale: false });
  assert.deepEqual(
    events
      .filter(({ command }) => command === "attach" || command === "detach")
      .map(({ command }) => command),
    ["attach", "detach"],
  );
  const create = events.find(({ command }) => command === "create")!;
  assert.ok(create.args.includes("APFS") && create.args.includes("AES-256"));
  assert.ok(create.args.includes("-stdinpass"));
  assert.equal(create.args[create.args.indexOf("-mode") + 1], "0700");
  assert.match(create.input!.toString(), /^[a-f0-9]{64}\0$/);
  assert.equal(
    events.some(({ args }) =>
      args.join(" ").includes(create.input!.toString().slice(0, -1)),
    ),
    false,
  );

  const initial = await first.acquire("parent", "ro", "Executor", audit);
  assert.equal(lstatSync(first.mount).mode & 0o7777, 0o700);
  initial.prepare();
  initial.ready();
  const overlap = await second.acquire("parent", "ro", "Reviewer", audit);
  const separate = await second.acquire("other", "rw", "operator shell", audit);
  assert.deepEqual(first.status(), { mounted: true, active: 3, stale: false });
  await assert.rejects(
    second.acquire(
      "parent",
      "rw",
      "operator shell",
      audit,
      performance.now() + 20,
    ),
    (error: MountBusy) =>
      error.code === "mount-busy" &&
      /Executor run|Reviewer run/.test(error.next),
  );
  assert.throws(() => first.detach(true), { code: "volume-detached" });
  initial.release();
  overlap.release();
  separate.release();
  assert.deepEqual(first.status(), { mounted: false, active: 0, stale: false });
  assert.equal(events.filter(({ command }) => command === "attach").length, 2);

  const writer = await first.acquire("parent", "rw", "operator shell", audit);
  await assert.rejects(
    second.acquire("parent", "ro", "Reviewer", audit, performance.now()),
    (error: MountBusy) =>
      error.code === "mount-busy" &&
      /Mount "example".*busy/.test(error.message) &&
      /operator shell/.test(error.next),
  );
  const path = first.directory("parent", true);
  assert.equal(lstatSync(path).mode & 0o7777, 0o700);
  symlinkSync(path, join(first.mount, "alias"));
  assert.throws(() => first.directory("alias"), {
    code: "config-invalid",
    message: /Mount "example" directory.*symbolic link/,
    next: /Replace the link/,
  });
  for (const entry of [path, first.mount]) {
    chmodSync(entry, 0o755);
    assert.throws(() => first.directory("parent"), {
      code: "config-invalid",
      message: /Mount "example".*mode 0700/,
      next: /chmod 700/,
    });
    chmodSync(entry, 0o700);
  }
  writer.quarantine();
  assert.equal(first.status().stale, true);
  assert.throws(() => first.detach(), { code: "volume-detached" });
  first.detach(true);
  assert.deepEqual(first.status(), { mounted: false, active: 0, stale: false });
});

for (const [fault, code, message] of [
  ["symlink", "config-invalid", /Mount "example" root.*symbolic link/],
  ["owner", "config-invalid", /Mount "example" root.*not owned/],
  ["device", "volume-detached", /Mount "example".*expected mounted device/],
] as const) {
  test(`attach refuses a mounted root with a ${fault} mismatch`, (t) => {
    const {
      volume: makeVolume,
      setAttachFault,
      symlinkTarget,
      events,
    } = fixture(t);
    const volume = makeVolume();
    volume.init();
    setAttachFault(fault);
    assert.throws(() => volume.attach(), { code, message });
    const untouched = fault === "symlink" ? symlinkTarget : volume.mount;
    assert.equal(lstatSync(untouched).mode & 0o7777, 0o755);
    assert.deepEqual(events.at(-1)?.args, ["detach", "/dev/disk99s1"]);
    assert.deepEqual(volume.status(), {
      mounted: false,
      active: 0,
      stale: false,
    });
  });
}

test("failed attach cleanup keeps the validation code and gives recovery steps", (t) => {
  const { volume: makeVolume, setAttachFault, failDetach } = fixture(t);
  const volume = makeVolume();
  volume.init();
  setAttachFault("owner");
  failDetach();
  assert.throws(() => volume.attach(), {
    code: "config-invalid",
    message: /not owned.*could not detach/,
    next: /volume status private.*volume detach private --force/,
  });
  assert.deepEqual(volume.status(), { mounted: true, active: 0, stale: true });
});

test("manual volume attachment is consumed by the next lease and failed detach is recoverable", async (t) => {
  const { volume: makeVolume, failDetach } = fixture(t);
  const volume = makeVolume();
  volume.init();
  volume.attach();
  assert.deepEqual(volume.status(), { mounted: true, active: 1, stale: false });
  const lease = await volume.acquire("parent", "ro", "Executor", audit);
  failDetach();
  assert.throws(lease.release, { code: "volume-detached" });
  assert.deepEqual(volume.status(), { mounted: true, active: 0, stale: true });
});

test("mount schema rejects invalid paths, environments, actors and user write grants", (t) => {
  const { env, definition } = fixture(t);
  const volumes = { private: definition };
  for (const [patch, expected] of [
    [{ dir: "../nested" }, /mounts\.example\.dir/],
    [{ path: "/mnt/nested/dir" }, /mounts\.example\.path/],
    [{ mode: "rw" }, /mounts\.example\.mode/],
    [{ actors: ["Verification"] }, /Verification cannot receive/],
    [{ actors: ["Coordinator"] }, /no adapter/],
    [{ env: "PATH" }, /mounts\.example\.env/],
    [{ env: "ANTHROPIC_API_KEY" }, /mounts\.example\.env/],
    [{ env: "AGENT_BOOTSTRAP_GATEWAY_SECRET" }, /mounts\.example\.env/],
  ] as const) {
    assert.throws(
      () =>
        parseConfig(
          { version: 1, volumes, mounts: { example: { ...mount, ...patch } } },
          "user",
        ),
      (error: ConfigError) => expected.test(error.message) && !!error.next,
    );
  }
  assert.throws(
    () =>
      parseConfig(
        {
          version: 1,
          mounts: {
            example: {
              ...mount,
              mode: "rw",
              actors: ["Executor", "Reviewer"],
            },
          },
        },
        "local",
      ),
    /exactly one actor/,
  );
  assert.throws(
    () => parseConfig({ version: 1, volumes, mounts: { Bad: mount } }, "user"),
    /entry name/,
  );
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    volumes,
    mounts: { example: mount },
  });
  assert.equal(loadConfig(env).config.mounts?.example?.mode, "ro");
});

test("writable ownership excludes every read claim on the same directory", (t) => {
  const { root, env, definition } = fixture(t);
  const first = addProject(initConfigRepo(join(root, "first")), undefined, env);
  const second = addProject(
    initConfigRepo(join(root, "second")),
    undefined,
    env,
  );
  const unaffected = addProject(
    initConfigRepo(join(root, "unaffected")),
    undefined,
    env,
  );
  const directory = (name: string) => projectConfigDirectory(name, env);
  const local = (name: string, mounts: object) =>
    writePrivateConfig(join(directory(name), "local.json"), configRoot(env), {
      version: 1,
      mounts,
    });
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    volumes: { private: definition },
  });
  local(first.name, {
    example: { ...mount, mode: "rw" },
    reader: { ...mount, path: "/mnt/other", actors: ["Reviewer"] },
  });
  assert.throws(() => loadConfig(env, directory(first.name)), /single mount/);
  local(first.name, { example: { ...mount, mode: "rw" } });
  local(second.name, { reader: { ...mount, actors: ["Reviewer"] } });
  assert.throws(
    () => loadConfig(env, directory(first.name)),
    (error: ConfigError) => error.next.includes(second.name),
  );
  assert.throws(
    () => loadConfig(env, directory(second.name)),
    (error: ConfigError) => error.next.includes(first.name),
  );
  assert.equal(
    loadConfig(env, directory(unaffected.name)).config.mounts,
    undefined,
  );
  removeProject(first.name, env);
  assert.equal(
    loadConfig(env, directory(second.name)).config.mounts?.reader?.mode,
    "ro",
  );
});

test("managed settings keep mounts outside file-tool scopes and remove shell tools", () => {
  for (const [actor, scope] of [
    ["Executor", "workspace"],
    ["Reviewer", "review"],
  ] as const) {
    const settings = managedClaudeSettings(actor, true, [mount.path]);
    assert.equal(settings.allowManagedPermissionRulesOnly, true);
    assert.equal(settings.permissions.allow.includes("Bash"), false);
    assert.ok(settings.permissions.deny.includes("Bash"));
    assert.ok(
      settings.permissions.allow.every((rule) =>
        rule.includes(`//${scope}/**`),
      ),
    );
    for (const tool of ["Read", "Glob", "Grep", "Edit", "Write"]) {
      assert.ok(settings.permissions.deny.includes(`${tool}(/${mount.path})`));
      assert.ok(
        settings.permissions.deny.includes(`${tool}(/${mount.path}/**)`),
      );
    }
  }
});

test("migration converts mounts and actor egress once and refuses active attachments or leases", async (t) => {
  const { root, env, definition, volume: makeVolume } = fixture(t);
  const repo = initConfigRepo(join(root, "migration"));
  const project = addProject(repo, undefined, env);
  const second = addProject(
    initConfigRepo(join(root, "second")),
    undefined,
    env,
  );
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    claude: {
      auth: "config-dir",
      configDir: {
        volume: definition,
        groups: { shared: { actors: ["Executor", "Reviewer"] } },
        egress: ["models.example.test:443"],
        loginEgress: ["shell.example.test:443"],
        errors: [{ match: "fixture", code: "auth-required" }],
        leakPatterns: ["private-fixture-pattern"],
      },
    },
  });
  assert.throws(
    () =>
      migrate(repo, [], env, () => {
        throw new Error("attached");
      }),
    /must be detached/,
  );
  const volume = makeVolume();
  volume.init();
  const lease = await volume.acquire("shared", "ro", "Executor", audit);
  assert.throws(
    () => migrate(repo, [], env, () => {}),
    /A lease or run is active/,
  );
  lease.release();
  const result = migrate(repo, [], env, () => {});
  assert.deepEqual(result.volumeMigration?.actorsLosingShellTools, [
    "Executor",
    "Reviewer",
  ]);
  assert.deepEqual(result.volumeMigration?.actorsLosingWriteAccess, [
    "Executor",
    "Reviewer",
  ]);
  assert.deepEqual(loadConfig(env).user, {
    version: 1,
    volumes: { private: definition },
    egress: { shell: ["shell.example.test:443"] },
  });
  assert.deepEqual(
    result.volumeMigration?.projects,
    [project, second].map(({ name }) => ({
      project: name,
      addedMounts: 1,
      addedEgress: { Executor: 1, Reviewer: 1 },
      actorsLosingShellTools: ["Executor", "Reviewer"],
    })),
  );
  for (const { name } of [project, second]) {
    const directory = projectConfigDirectory(name, env);
    const { local } = loadConfig(env, directory);
    const effective = loadClaudeConfig(env, directory);
    assert.equal(effective.auth, "external");
    assert.deepEqual(local.mounts?.shared, {
      volume: "private",
      dir: "shared",
      path: "/mnt/shared",
      actors: ["Executor", "Reviewer"],
      mode: "ro",
      env: "CLAUDE_CONFIG_DIR",
    });
    assert.deepEqual(local.egress, {
      Executor: ["models.example.test:443"],
      Reviewer: ["models.example.test:443"],
    });
    assert.deepEqual(effective.config.egress, local.egress);
    assert.equal(effective.errors[0]?.code, "auth-required");
    assert.deepEqual(effective.leakPatterns, ["private-fixture-pattern"]);
  }
  const files = [
    userConfigPath(env),
    ...[project, second].map(({ name }) =>
      join(projectConfigDirectory(name, env), "local.json"),
    ),
  ];
  const snapshot = files.map((path) => readFileSync(path, "utf8"));
  assert.deepEqual(
    migrate(repo, [], env, () => {}),
    { projects: [], orphanedVolumes: [] },
  );
  assert.deepEqual(
    files.map((path) => readFileSync(path, "utf8")),
    snapshot,
  );
});

test("volume CLI reports a named fault without exposing configuration values", async (t) => {
  const { root, env, definition } = fixture(t);
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    volumes: { private: definition },
  });
  const state = userStateDirectory(env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o755);
  const output: string[] = [];
  const io: BootstrapIo = {
    stdin: process.stdin,
    isTTY: false,
    conciergeTTY: false,
    stdout: { write: (text) => output.push(text) },
    stderr: { write: (text) => output.push(text) },
    async prompt() {
      return "";
    },
  };
  const result = await runBootstrap(["volume", "status", "private"], root, io, {
    ...systemHost,
    env,
  });
  assert.equal(result, 1);
  const message = output.join("");
  assert.match(message, /Volume "private".*state directory is unsafe/);
  assert.match(message, /\nnext: .*mode 0700/);
  assert.ok(
    !message.includes(root) && !message.includes(definition.keychainService),
  );
});

test("volume shell requires a TTY and resolves the named mount before launching", async (t) => {
  const { env, root, definition } = fixture(t);
  const repo = initConfigRepo(join(root, "project"));
  addProject(repo, undefined, env);
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    volumes: { private: definition },
    mounts: { example: mount },
  });
  const output: string[] = [];
  let launches = 0;
  const io: BootstrapIo = {
    stdin: process.stdin,
    isTTY: false,
    conciergeTTY: false,
    stdout: { write: (text) => output.push(text) },
    stderr: { write: (text) => output.push(text) },
    async prompt() {
      return "";
    },
    async launch(_, args) {
      launches++;
      assert.deepEqual(args, ["--volume-shell", "example", "--target", repo]);
      return true;
    },
  };
  const host = { ...systemHost, env };
  const shell = ["volume", "shell", "example", "--target", repo];
  assert.equal(await runBootstrap(shell, repo, io, host), 1);
  assert.equal(launches, 0);
  assert.equal(
    await runBootstrap(shell, repo, { ...io, conciergeTTY: true }, host),
    0,
  );
  assert.equal(launches, 1);
});

test("a cached writable grant cannot launch after its registration is removed", async (t) => {
  const { root, env, definition } = fixture(t);
  const original = addProject(
    initConfigRepo(join(root, "original")),
    undefined,
    env,
  );
  const replacement = addProject(
    initConfigRepo(join(root, "replacement")),
    undefined,
    env,
  );
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    volumes: { private: definition },
  });
  const writable = { ...mount, mode: "rw" } as const;
  const directory = projectConfigDirectory(original.name, env);
  writePrivateConfig(join(directory, "local.json"), configRoot(env), {
    version: 1,
    mounts: { example: writable },
  });
  const policy = createClaudePolicy(
    loadClaudeConfig(env, directory),
    userStateDirectory(env),
    () => {},
    original,
    env,
  );
  removeProject(original.name, env);
  writePrivateConfig(
    join(projectConfigDirectory(replacement.name, env), "local.json"),
    configRoot(env),
    {
      version: 1,
      mounts: { example: writable },
    },
  );
  await assert.rejects(
    policy.beginMount!(
      { ...writable, name: "example" },
      "Executor",
      audit,
      performance.now(),
    ),
    ConfigError,
  );
});

test("migration preserves project inheritance across an interrupted user publication", (t) => {
  const { root, env, definition } = fixture(t);
  const repo = initConfigRepo(join(root, "registered"));
  const project = addProject(repo, undefined, env);
  const local = join(projectConfigDirectory(project.name, env), "local.json");
  const existingMounts = Object.fromEntries(
    Array.from({ length: 800 }, (_, index) => {
      const name = `existing-${index}`;
      return [
        name,
        {
          volume: "private",
          dir: name,
          path: `/mnt/${name}`,
          actors: ["Reviewer"],
        },
      ];
    }),
  );
  const original = {
    version: 1,
    mounts: existingMounts,
    claude: {
      auth: "config-dir",
      configDir: { volume: definition, egress: ["models.example.test:443"] },
    },
  };
  const actors = ["Concierge", "Planner", "Executor", "Reviewer"];
  const legacyLocal = {
    version: 1,
    claude: { configDir: { groups: { shared: { actors } } } },
  };
  writePrivateConfig(userConfigPath(env), configRoot(env), original);
  const override = {
    ...legacyLocal,
    claude: {
      configDir: {
        ...legacyLocal.claude.configDir,
        egress: ["local.example.test:443"],
      },
    },
  };
  writePrivateConfig(local, configRoot(env), override);
  const published = {
    version: 1,
    mounts: existingMounts,
    volumes: { private: definition },
  };
  const planned = {
    version: 1,
    mounts: {
      shared: {
        volume: "private",
        dir: "shared",
        path: "/mnt/shared",
        actors,
        mode: "ro",
        env: "CLAUDE_CONFIG_DIR",
      },
    },
    egress: Object.fromEntries(
      actors.map((actor) => [actor, ["local.example.test:443"]]),
    ),
    claude: { auth: "external" },
  };
  const journal = join(configRoot(env), ".volume-migration.json");
  writePrivateConfig(journal, configRoot(env), {
    version: 1,
    before: original,
    after: published,
    legacyRoot: null,
    projects: {
      [project.name]: {
        id: project.id,
        digest: createHash("sha256")
          .update(JSON.stringify([project.identity, planned]))
          .digest("hex"),
      },
    },
  });
  assert.ok(readFileSync(journal).length > 256 * 1024);
  writePrivateConfig(userConfigPath(env), configRoot(env), published);
  const late = addProject(initConfigRepo(join(root, "late")), undefined, env);
  const lateDirectory = projectConfigDirectory(late.name, env);

  writePrivateConfig(local, configRoot(env), { version: 1 });
  assert.throws(
    () => migrate(repo, [], env, () => {}),
    /The project configuration changed during an incomplete migration/,
  );
  writePrivateConfig(local, configRoot(env), override);

  migrate(repo, [], env, () => {});
  const effective = loadConfig(env, projectConfigDirectory(project.name, env));
  for (const actor of ["Concierge", "Planner", "Executor", "Reviewer"] as const)
    assert.deepEqual(effective.config.egress?.[actor], [
      "local.example.test:443",
    ]);
  assert.deepEqual(effective.local.mounts?.shared?.actors, actors);
  assert.deepEqual(effective.local.claude, { auth: "external" });
  assert.deepEqual(effective.user, published);
  assert.equal(existsSync(join(lateDirectory, "local.json")), false);
  assert.equal(loadClaudeConfig(env, lateDirectory).auth, "api-key");
  assert.equal(existsSync(journal), false);
  assert.deepEqual(
    migrate(repo, [], env, () => {}),
    { projects: [], orphanedVolumes: [] },
  );
});

test("migration respects a local API-key override of user config-dir mode", (t) => {
  const { root, env, definition } = fixture(t);
  const repo = initConfigRepo(join(root, "active"));
  const active = addProject(repo, undefined, env);
  const inactive = addProject(
    initConfigRepo(join(root, "inactive")),
    undefined,
    env,
  );
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    claude: {
      auth: "config-dir",
      configDir: {
        volume: definition,
        groups: { shared: { actors: ["Reviewer"] } },
        egress: ["models.example.test:443"],
        loginEgress: ["shell.example.test:443"],
      },
    },
  });
  const activeDirectory = projectConfigDirectory(active.name, env);
  const inactiveDirectory = projectConfigDirectory(inactive.name, env);
  const inactiveFile = join(inactiveDirectory, "local.json");
  writePrivateConfig(inactiveFile, configRoot(env), {
    version: 1,
    claude: { auth: "api-key" },
  });
  const before = readFileSync(inactiveFile, "utf8");
  writePrivateConfig(join(activeDirectory, "local.json"), configRoot(env), {
    version: 1,
    claude: { configDir: { groups: { worker: { actors: ["Executor"] } } } },
  });

  const result = migrate(repo, [], env, () => {});
  assert.deepEqual(loadConfig(env).user, {
    version: 1,
    volumes: { private: definition },
    egress: { shell: ["shell.example.test:443"] },
  });
  const { local } = loadConfig(env, activeDirectory);
  assert.deepEqual(local.claude, { auth: "external" });
  assert.deepEqual(Object.keys(local.mounts ?? {}), ["shared", "worker"]);
  assert.deepEqual(local.egress, {
    Reviewer: ["models.example.test:443"],
    Executor: ["models.example.test:443"],
  });
  assert.equal(readFileSync(inactiveFile, "utf8"), before);
  const effective = loadClaudeConfig(env, inactiveDirectory);
  assert.equal(effective.auth, "api-key");
  assert.equal(effective.config.mounts, undefined);
  assert.equal(effective.config.egress, undefined);
  assert.deepEqual(
    result.volumeMigration?.projects.find(
      ({ project }) => project === inactive.name,
    ),
    {
      project: inactive.name,
      addedMounts: 0,
      addedEgress: {},
      actorsLosingShellTools: [],
    },
  );
});

test("migration keeps project-selected mounts and egress in the selected project", (t) => {
  const { root, env, definition } = fixture(t);
  const repo = initConfigRepo(join(root, "selected"));
  const selected = addProject(repo, undefined, env);
  const other = addProject(initConfigRepo(join(root, "other")), undefined, env);
  const first = projectConfigDirectory(selected.name, env);
  const second = projectConfigDirectory(other.name, env);
  const sharedPatterns = Array.from(
    { length: 16 },
    (_, index) => `shared-fixture-${index}`,
  );
  const localPatterns = Array.from(
    { length: 16 },
    (_, index) => `local-fixture-${index}`,
  );
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    claude: {
      auth: "api-key",
      configDir: {
        volume: definition,
        groups: { shared: { actors: ["Reviewer"] } },
        egress: ["models.example.test:443"],
        loginEgress: ["shell.example.test:443"],
        leakPatterns: sharedPatterns,
      },
    },
  });
  writePrivateConfig(join(first, "local.json"), configRoot(env), {
    version: 1,
    claude: {
      auth: "config-dir",
      configDir: {
        groups: { worker: { actors: ["Executor"] } },
        leakPatterns: localPatterns,
      },
    },
  });
  const otherFile = join(second, "local.json");
  writePrivateConfig(otherFile, configRoot(env), {
    version: 1,
    mounts: { conflicting: { ...mount, dir: "shared", mode: "rw" } },
  });
  assert.throws(
    () => migrate(repo, [], env, () => {}),
    /A directory with a write grant is also claimed by another project/,
  );
  assert.equal(
    existsSync(join(configRoot(env), ".volume-migration.json")),
    false,
  );
  writePrivateConfig(otherFile, configRoot(env), {
    version: 1,
    claude: { configDir: { groups: { unused: { actors: ["Planner"] } } } },
  });
  const result = migrate(repo, [], env, () => {});
  const user = loadConfig(env);
  assert.deepEqual(user.user, {
    version: 1,
    claude: { auth: "api-key" },
    volumes: { private: definition },
    egress: { shell: ["shell.example.test:443"] },
  });
  const active = loadConfig(env, first);
  assert.deepEqual(active.local.claude, {
    auth: "external",
    leakPatterns: [...sharedPatterns, ...localPatterns],
  });
  assert.deepEqual(Object.keys(active.local.mounts ?? {}), [
    "shared",
    "worker",
  ]);
  assert.ok(
    Object.values(active.local.mounts ?? {}).every(({ mode }) => mode === "ro"),
  );
  assert.deepEqual(active.local.egress, {
    Reviewer: ["models.example.test:443"],
    Executor: ["models.example.test:443"],
  });
  assert.deepEqual(loadConfig(env, second).local, { version: 1 });
  assert.deepEqual(
    result.volumeMigration?.projects?.find(
      ({ project }) => project === selected.name,
    ),
    {
      project: selected.name,
      addedMounts: 2,
      addedEgress: { Reviewer: 1, Executor: 1 },
      actorsLosingShellTools: ["Reviewer", "Executor"],
    },
  );
  assert.deepEqual(
    result.volumeMigration?.projects?.find(
      ({ project }) => project === other.name,
    ),
    {
      project: other.name,
      addedMounts: 0,
      addedEgress: {},
      actorsLosingShellTools: [],
    },
  );
  assert.deepEqual(
    migrate(repo, [], env, () => {}),
    { projects: [], orphanedVolumes: [] },
  );
});

test("config validation and doctor reject mounts for a non-Claude harness", async (t) => {
  const { root, env, definition } = fixture(t);
  const repo = initConfigRepo(join(root, "project"));
  const project = addProject(repo, undefined, env);
  const directory = projectConfigDirectory(project.name, env);
  writePrivateConfig(userConfigPath(env), configRoot(env), {
    version: 1,
    volumes: { private: definition },
  });
  writePrivateConfig(join(directory, "local.json"), configRoot(env), {
    version: 1,
    mounts: { example: mount },
  });
  const actorHarnesses = { ...localActorHarnesses, Executor: "codex" } as const;
  assert.throws(() => loadConfig(env, directory, actorHarnesses), {
    message:
      /mounts\.example\.actors\. A mounted actor must use the Claude adapter/,
  });
  const report = await doctor(
    fileURLToPath(new URL("..", import.meta.url)),
    {
      ...systemHost,
      env,
      actorHarnesses,
      async command() {
        return { code: 1, stdout: "" };
      },
    },
    repo,
  );
  const check = report.checks.find(({ id }) => id === "configuration");
  assert.equal(check?.status, "wrong");
  assert.match(check?.detail ?? "", /mounts\.example\.actors/);
  assert.ok(check?.fix.length);
});

test("a waiting lease checks mount ownership when it can acquire the lock", async (t) => {
  const { volume: makeVolume, events } = fixture(t);
  const volume = makeVolume();
  volume.init();
  const writer = await volume.acquire("shared", "rw", "operator shell", audit);
  let ownershipChecks = 0;
  const revoked = new Error("mount grant changed");
  const pending = volume.acquire(
    "shared",
    "ro",
    "Executor",
    audit,
    performance.now() + 1_000,
    () => {
      ownershipChecks++;
      throw revoked;
    },
  );
  const rejected = assert.rejects(pending, (error) => error === revoked);
  assert.equal(ownershipChecks, 0);
  writer.release();
  await rejected;
  assert.equal(ownershipChecks, 1);
  assert.equal(events.filter(({ command }) => command === "attach").length, 2);
  assert.deepEqual(volume.status(), {
    mounted: false,
    active: 0,
    stale: false,
  });
});
