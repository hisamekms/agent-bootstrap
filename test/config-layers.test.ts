import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  configRoot,
  layerFix,
  loadConfig,
  parseConfig,
  projectConfigDirectory,
  projectStateDirectory,
  privatePath,
  userConfigPath,
  userStateDirectory,
  writePrivateConfig,
} from "../src/config/layers.ts";
import { ConfigError } from "../src/config/messages.ts";
import { migrate } from "../src/config/migrate.ts";
import {
  addProject,
  approveProject,
  driftWarning,
  listProjects,
  moveProject,
  projectMissing,
  readDeclaration,
  removeProject,
} from "../src/config/projects.ts";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";
import { resolveTarget } from "../src/local-orchestrator/target.ts";
import { runBootstrap, type BootstrapIo } from "../src/onboarding/cli.ts";
import { systemHost } from "../src/onboarding/prerequisites.ts";
import { isConciergeVolumeName } from "../src/sandbox-runtime.ts";
import { configEnv, fixtureGit, initConfigRepo } from "./config-fixture.ts";

function fixture(t: { after(cleanup: () => void): void }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "config-layers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = initConfigRepo(join(root, "sample"));
  return { root, repo, env: configEnv(root) };
}

function commitDeclaration(repo: string, contents?: string, mode = 0o644) {
  const directory = join(repo, ".agent-bootstrap");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "project.json");
  if (contents === undefined) {
    rmSync(path, { force: true });
    symlinkSync("elsewhere", path);
  } else {
    rmSync(path, { force: true });
    writeFileSync(path, contents, { mode });
  }
  fixtureGit(repo, "add", ".agent-bootstrap");
  fixtureGit(repo, "commit", "--allow-empty", "-m", "declare");
}

const verification = (arg: string) => ({ profile: "bun", argv: ["bun", arg] });

test("C1/C3/C4: only pinned approval grants a declaration; a hostile terminal string is escaped", async (t) => {
  const { repo, env } = fixture(t);
  const project = addProject(repo, undefined, env);
  const directory = projectConfigDirectory(project.name, env);
  const hostile = "run\u202e\u009b\u001b[2J\u2028";
  commitDeclaration(
    repo,
    JSON.stringify({
      version: 1,
      verification: verification(hostile),
      egress: { Reviewer: ["first.example:443"] },
    }),
  );
  const declaration = readDeclaration(project);
  writeFileSync(join(repo, ".agent-bootstrap/project.json"), "uncommitted");
  assert.equal(loadConfig(env, directory).config.verification, undefined);
  assert.match(
    driftWarning(project)!,
    /Added requests: egress.Reviewer \(1 destination\), verification/,
  );
  let preview = "";
  const mount = {
    volume: "m",
    dir: "tool",
    actors: ["Reviewer"],
    path: "/mnt/tool",
  };
  writePrivateConfig(join(directory, "local.json"), configRoot(env), {
    version: 1,
    mounts: { tool: mount },
  });
  const local = readFileSync(join(directory, "local.json"));
  const io = {
    isTTY: true,
    write: (chunk: string) => {
      preview += chunk;
    },
    async confirm() {
      assert.match(preview, /\\u202e\\u009b\\u001b\[2J\\u2028/);
      assert.match(
        preview,
        /egress.Reviewer adds destinations for an actor with a mount/,
      );
      for (const control of ["\u202e", "\u009b", "\u001b", "\u2028"])
        assert.equal(preview.includes(control), false);
      commitDeclaration(
        repo,
        JSON.stringify({
          version: 1,
          egress: { Executor: ["second.example:443"] },
        }),
      );
      return project.name;
    },
  };
  await assert.rejects(
    approveProject(project.name, env, { ...io, isTTY: false }),
    /requires a terminal/,
  );
  await assert.rejects(
    approveProject(project.name, env, { ...io, confirm: async () => "yes" }),
    /did not match/,
  );
  assert.equal(loadConfig(env, directory).approved, undefined);
  await approveProject(project.name, env, io);
  const { config, approved, sources } = loadConfig(env, directory);
  assert.equal(approved?.commit, declaration.commit);
  assert.equal(approved?.blob, declaration.blob);
  assert.deepEqual(config.verification, verification(hostile));
  assert.equal(sources.verification, "approved");
  assert.deepEqual(config.egress, { Reviewer: ["first.example:443"] });
  const warning = driftWarning(project, approved)!;
  assert.match(
    warning,
    /Added requests: egress.Executor \(1 destination\). Not granted until approved/,
  );
  assert.match(
    warning,
    /Removed requests: egress.Reviewer \(1 destination\), verification. Still granted until approved/,
  );
  assert.doesNotMatch(warning, /first\.example|second\.example/);
  assert.deepEqual(readFileSync(join(directory, "local.json")), local);
  await approveProject(project.name, env, {
    ...io,
    confirm: async () => project.name,
  });
  assert.equal(
    driftWarning(project, loadConfig(env, directory).approved),
    undefined,
  );
  fixtureGit(repo, "rm", ".agent-bootstrap/project.json");
  fixtureGit(repo, "commit", "-m", "remove declaration");
  assert.match(
    driftWarning(project, loadConfig(env, directory).approved)!,
    /Removed requests: egress.Executor/,
  );
  await approveProject(project.name, env, {
    ...io,
    confirm: async () => project.name,
  });
  assert.equal(loadConfig(env, directory).config.egress, undefined);
});

test("C2: worktrees share identity and moving preserves the state, name and volume", async (t) => {
  const { root, repo, env } = fixture(t);
  const work = join(root, "linked");
  fixtureGit(repo, "worktree", "add", "-b", "work", work);
  const project = addProject(work, undefined, env);
  assert.equal(project.name, "sample");
  assert.match(project.id, /^[a-f0-9]{12}$/);
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        join(projectConfigDirectory(project.name, env), "project.json"),
        "utf8",
      ),
    ),
    project,
  );
  assert.throws(() => addProject(repo, "duplicate", env), /already registered/);
  const first = await resolveTarget(work, repo, env);
  assert.equal(
    (await resolveTarget(repo, repo, env)).directory,
    first.directory,
  );
  const moved = join(root, "moved");
  renameSync(repo, moved);
  assert.equal(projectMissing(project), true);
  await assert.rejects(
    resolveTarget(moved, moved, env),
    (error: ConfigError) => error.next === "agent-bootstrap project add <path>",
  );
  const state = projectStateDirectory("sample", env);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const updated = moveProject(project.name, moved, env);
  assert.equal(projectMissing(updated), false);
  assert.equal(updated.id, project.id);
  const movedTarget = await resolveTarget(moved, moved, env);
  assert.equal(movedTarget.volume, `lo-concierge-sample-${project.id}`);
  assert.equal(movedTarget.volume, first.volume);
  removeProject("sample", env);
  assert.deepEqual(listProjects(env), []);
  assert.equal(existsSync(state), true);
});

test("re-registering the same identity allocates a new volume for a maximum-length project name", async (t) => {
  const { repo, env } = fixture(t);
  const name = "a".repeat(48);
  addProject(repo, name, env);
  const first = await resolveTarget(repo, repo, env);
  assert.equal(isConciergeVolumeName(first.volume), true);
  removeProject(name, env);
  addProject(repo, name, env);
  const second = await resolveTarget(repo, repo, env);
  assert.notEqual(second.volume, first.volume);
});

test("C3: a symbolic main cannot supply the declaration", (t) => {
  const { repo, env } = fixture(t);
  const project = addProject(repo, undefined, env);
  fixtureGit(repo, "switch", "-c", "work");
  fixtureGit(repo, "symbolic-ref", "refs/heads/main", "refs/heads/work");
  assert.throws(
    () => readDeclaration(project),
    (error: ConfigError) => {
      assert.match(
        error.message,
        /Invalid project declaration.*\.agent-bootstrap\/project\.json/,
      );
      assert.match(error.message, /refs\/heads\/main.*direct commit reference/);
      assert.match(error.next, /project approve sample/);
      return true;
    },
  );
});

test("C3: missing main cannot resolve through a decoy ref", (t) => {
  const { repo, env } = fixture(t);
  const project = addProject(repo, undefined, env);
  fixtureGit(repo, "switch", "-c", "work");
  fixtureGit(repo, "branch", "-D", "main");
  fixtureGit(repo, "branch", "main/decoy");
  fixtureGit(repo, "tag", "refs/heads/main");
  assert.throws(() => readDeclaration(project), /direct commit reference/);
});

test("C3: declaration validation rejects executable and symlink blobs, oversized, deep, long-list and invalid JSON", (t) => {
  const { repo, env } = fixture(t);
  const project = addProject(repo, undefined, env);
  for (const [raw, mode, expected] of [
    ['{"version":1}', 0o755, /mode 100644/],
    [undefined, 0o644, /mode 100644/],
    [" ".repeat(64 * 1024 + 1), 0o644, /64 KiB/],
    [
      '{"x":' + "[".repeat(8) + "1" + "]".repeat(8) + "}",
      0o644,
      /eight levels/,
    ],
    [
      JSON.stringify({
        version: 1,
        egress: { Planner: Array(65).fill("one.example:443") },
      }),
      0o644,
      /64 entries/,
    ],
    ['{"version":}', 0o644, /UTF-8 JSON/],
  ] as const) {
    commitDeclaration(repo, raw, mode);
    assert.throws(() => readDeclaration(project), expected);
  }
  fixtureGit(repo, "rm", "-r", ".agent-bootstrap");
  rmSync(join(repo, ".agent-bootstrap"), { recursive: true, force: true });
  symlinkSync("external", join(repo, ".agent-bootstrap"));
  fixtureGit(repo, "add", ".agent-bootstrap");
  fixtureGit(repo, "commit", "-m", "replace directory");
  assert.throws(() => readDeclaration(project), /must be a Git tree/);
  fixtureGit(repo, "rm", ".agent-bootstrap");
  mkdirSync(join(repo, ".agent-bootstrap"));
  const head = fixtureGit(repo, "rev-parse", "HEAD");
  fixtureGit(
    repo,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},.agent-bootstrap/project.json`,
  );
  fixtureGit(repo, "commit", "-m", "declare a gitlink");
  assert.throws(() => readDeclaration(project), /mode 100644/);
});

test("C5/C6/C8: merge sources, union grants and enforce actor and layer constraints", async (t) => {
  const { repo, env } = fixture(t);
  const { name } = addProject(repo, undefined, env);
  const dir = projectConfigDirectory(name, env);
  const mount = {
    volume: "private",
    dir: "tool",
    actors: ["Executor"],
    path: "/mnt/tool",
  };
  const user = {
    version: 1,
    verification: verification("user"),
    egress: { Executor: ["first.example:443"] },
    mounts: { tool: mount },
    volumes: {
      private: {
        image: "/volume",
        keychainService: "keychain",
        attach: "while-running",
      },
    },
  };
  const local = {
    version: 1,
    verification: verification("local"),
    egress: { Executor: ["first.example:443", "third.example:443"] },
  };
  writePrivateConfig(userConfigPath(env), configRoot(env), user);
  writePrivateConfig(join(dir, "local.json"), configRoot(env), local);
  commitDeclaration(
    repo,
    JSON.stringify({
      version: 1,
      verification: verification("approved"),
      profiles: { Worker: "bun" },
      egress: { Executor: ["second.example:443"] },
    }),
  );
  await approveProject(name, env, {
    isTTY: true,
    write() {},
    confirm: async () => name,
  });
  const { config, sources } = loadConfig(env, dir);
  assert.deepEqual(config.verification, verification("local"));
  assert.deepEqual(config.egress?.Executor, [
    "first.example:443",
    "second.example:443",
    "third.example:443",
  ]);
  assert.deepEqual(sources["egress.Executor"], ["user", "approved", "local"]);
  assert.equal(sources["profiles.Worker"], "approved");
  assert.equal(sources["mounts.tool"], "user");
  writePrivateConfig(join(dir, "local.json"), configRoot(env), { version: 1 });
  assert.deepEqual(
    loadConfig(env, dir).config.verification,
    verification("approved"),
  );
  writePrivateConfig(join(dir, "local.json"), configRoot(env), {
    version: 1,
    mounts: { tool: mount },
  });
  assert.throws(() => loadConfig(env, dir), /A named entry appears/);
  for (const key of ["claude", "volumes", "mounts"])
    assert.throws(
      () => parseConfig({ version: 1, [key]: {} }, "approved"),
      new RegExp(key),
    );
  assert.throws(
    () => parseConfig({ version: 1, volumes: {} }, "local"),
    /volumes/,
  );
  for (const actor of ["Coordinator", "Verification", "shell"])
    assert.throws(
      () => parseConfig({ version: 1, egress: { [actor]: [] } }, "approved"),
      new RegExp(actor),
    );
  for (const layer of ["user", "local"] as const)
    assert.throws(
      () => parseConfig({ version: 1, egress: { Verification: [] } }, layer),
      /stays offline/,
    );
  assert.throws(
    () =>
      parseConfig({ version: 1, profiles: { Reviewer: "bun" } }, "approved"),
    /profiles.Reviewer/,
  );
});

test("exclusive config creation publishes a private file with one link and preserves it on EEXIST", (t) => {
  const { env } = fixture(t);
  const directory = configRoot(env);
  const file = userConfigPath(env);
  writePrivateConfig(file, directory, { version: 1 }, true);
  assert.equal(statSync(file).nlink, 1);
  assert.equal(statSync(file).mode & 0o7777, 0o600);
  assert.throws(
    () => writePrivateConfig(file, directory, { version: 2 }, true),
    { code: "EEXIST" },
  );
  assert.equal(loadConfig(env).user.version, 1);
  assert.equal(statSync(file).nlink, 1);
  assert.deepEqual(readdirSync(directory), ["config.json"]);
});

test("exclusive config recovers from crashes at each write and publication step", (t) => {
  const { root } = fixture(t);
  const module = new URL("../src/config/layers.ts", import.meta.url).href;
  const child = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const [module, path, directory, point] = process.argv.slice(1);
    const { openSync, closeSync, fstatSync, fsyncSync, linkSync, unlinkSync, writeFileSync } = fs;
    const crash = (step) => {
      if (point === step) process.kill(process.pid, "SIGKILL");
    };
    mock.module("node:fs", () => ({
      ...fs,
      openSync(path, flags, mode) {
        const fd = openSync(path, flags, mode);
        if (flags === "wx") crash("open");
        return fd;
      },
      writeFileSync(fd, bytes) {
        if (point === "partial-write") {
          writeFileSync(fd, bytes.slice(0, 4));
          crash("partial-write");
        }
        writeFileSync(fd, bytes);
        crash("write");
      },
      fsyncSync(fd) {
        fsyncSync(fd);
        crash(fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync");
      },
      closeSync(fd) {
        const file = fstatSync(fd).isFile();
        closeSync(fd);
        if (file) crash("close");
      },
      linkSync(source, destination) {
        linkSync(source, destination);
        if (destination === path) crash("link");
      },
      unlinkSync(path) {
        unlinkSync(path);
        crash("unlink");
      },
    }));
    const { writePrivateConfig } = await import(module);
    writePrivateConfig(path, directory, { version: 1, egress: { Reviewer: ["fixture:443"] } }, true);
  `;
  const unpublished = ["open", "partial-write", "write", "file-sync", "close"];
  for (const point of [...unpublished, "link", "unlink", "directory-sync"]) {
    const env = configEnv(join(root, point));
    const directory = configRoot(env);
    const file = userConfigPath(env);
    const result = spawnSync(process.execPath, [
      "-e",
      child,
      "--",
      module,
      file,
      directory,
      point,
    ]);
    assert.ifError(result.error);
    assert.equal(result.signal, "SIGKILL", `${point}: ${result.stderr}`);
    const published = !unpublished.includes(point);
    assert.equal(existsSync(file), published, point);
    if (point === "link") assert.equal(statSync(file).nlink, 2);
    assert.deepEqual(
      loadConfig(env).user,
      published
        ? { version: 1, egress: { Reviewer: ["fixture:443"] } }
        : { version: 1 },
      point,
    );
    assert.deepEqual(
      readdirSync(directory),
      published ? ["config.json"] : [],
      point,
    );
    if (published) assert.equal(statSync(file).nlink, 1, point);
  }
});

test("config cleanup only removes regular temp files in checked directories", (t) => {
  const { root, env } = fixture(t);
  const dir = configRoot(env);
  const file = userConfigPath(env);
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  const outsideTemp = join(outside, ".config-outside");
  writeFileSync(outsideTemp, "keep");
  privatePath(dir, dir, true);
  const stale = join(dir, ".config-stale");
  writeFileSync(stale, "partial");
  symlinkSync(outsideTemp, join(dir, ".config-link"));
  mkdirSync(join(dir, ".config-directory"));
  chmodSync(dir, 0o755);
  assert.throws(() => loadConfig(env), ConfigError);
  assert.throws(
    () => writePrivateConfig(file, dir, { version: 1 }, true),
    ConfigError,
  );
  assert.equal(existsSync(stale), true);
  chmodSync(dir, 0o700);
  writePrivateConfig(file, dir, { version: 1 }, true);
  assert.deepEqual(readdirSync(dir).sort(), [
    ".config-directory",
    ".config-link",
    "config.json",
  ]);
  assert.equal(readFileSync(outsideTemp, "utf8"), "keep");
  rmSync(dir, { recursive: true });
  symlinkSync(outside, dir);
  assert.throws(() => loadConfig(env), ConfigError);
  assert.equal(existsSync(outsideTemp), true);
});

test("C7: XDG defaults, exact file permissions, links and redacted doctor checks", (t) => {
  const { root, env } = fixture(t);
  const relative = {
    HOME: root,
    XDG_CONFIG_HOME: "config",
    XDG_STATE_HOME: "state",
  };
  assert.equal(
    userConfigPath(relative),
    join(root, ".config/agent-bootstrap/config.json"),
  );
  assert.equal(
    layerFix("user", { env: relative }).path,
    userConfigPath(relative),
  );
  assert.equal(layerFix("user").path, "config.json");
  assert.equal(
    userStateDirectory(relative),
    join(root, ".local/state/agent-bootstrap"),
  );
  const file = userConfigPath(env);
  writePrivateConfig(file, configRoot(env), { version: 1 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(configRoot(env)).mode & 0o777, 0o700);
  chmodSync(file, 0o400);
  assert.throws(() => loadConfig(env), /mode 0600/);
  chmodSync(file, 0o600);
  const link = join(root, "link");
  linkSync(file, link);
  assert.throws(() => loadConfig(env), /no links/);
  rmSync(link);
  const other = join(root, "other");
  renameSync(configRoot(env), other);
  symlinkSync(other, configRoot(env));
  assert.throws(
    () => loadConfig(env),
    (error: ConfigError) => {
      assert.ok(
        error.message.includes(
          `Invalid user configuration (${file}): ${configRoot(env)}`,
        ),
      );
      assert.match(error.message, /without links/);
      return true;
    },
  );
  for (const value of [
    { version: 9 },
    { version: 1, privateValue: "secret" },
    { version: 1, verification: verification(999 as unknown as string) },
  ]) {
    assert.throws(
      () => parseConfig(value, "user"),
      (error: ConfigError) => {
        const check = error.doctorCheck();
        assert.equal(check.status, "wrong");
        assert.equal(check.needsHuman, true);
        assert.doesNotMatch(check.detail, /privateValue|secret|999/);
        assert.match(check.fix[0]!, /config edit/);
        return true;
      },
    );
  }
});

test("C5/C7: the CLI creates local settings privately and rejects project approval flags", async (t) => {
  const { repo, env } = fixture(t);
  let output = "";
  const io: BootstrapIo = {
    stdin: process.stdin,
    isTTY: false,
    conciergeTTY: false,
    stdout: {
      write: (text) => {
        output += text;
      },
    },
    stderr: {
      write: (text) => {
        output += text;
      },
    },
    prompt: () => {
      throw new Error("Unexpected prompt");
    },
  };
  const host = { ...systemHost, env: { ...env, EDITOR: "/usr/bin/true" } };
  assert.equal(await runBootstrap(["project", "add", repo], repo, io, host), 0);
  assert.equal(
    await runBootstrap(
      ["config", "edit", "--project", "sample"],
      repo,
      io,
      host,
    ),
    0,
  );
  const local = join(projectConfigDirectory("sample", env), "local.json");
  assert.equal(statSync(local).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), { version: 1 });
  const edit = (editor: string) =>
    runBootstrap(["config", "edit", "--project", "sample"], repo, io, {
      ...host,
      env: { ...host.env, EDITOR: editor },
    });
  output = "";
  assert.equal(await edit("chmod 644"), 1);
  assert.ok(output.includes(`Invalid local configuration (${local})`));
  assert.ok(output.includes(`chmod 600 ${local}`));
  assert.match(output, /config edit --project sample/);
  chmodSync(local, 0o600);
  output = "";
  assert.equal(
    await edit(`/bin/sh -c 'mv "$1" "$1.bak" && ln -s "$1.bak" "$1"' editor`),
    1,
  );
  assert.match(output, /without links/);
  assert.match(output, /config edit --project sample/);
  rmSync(local);
  renameSync(local + ".bak", local);
  output = "";
  assert.equal(await edit("rm"), 1);
  assert.match(output, /must leave a configuration file/);
  assert.equal(await edit("/usr/bin/true"), 0);
  assert.equal(
    await runBootstrap(
      ["project", "approve", "sample", "--yes"],
      repo,
      io,
      host,
    ),
    2,
  );
  assert.equal(
    await runBootstrap(["project", "approve", "sample"], repo, io, host),
    1,
  );
  assert.match(output, /requires a terminal/);
  commitDeclaration(
    repo,
    JSON.stringify({ version: 1, verification: verification("approved") }),
  );
  assert.equal(
    await runBootstrap(
      ["project", "approve", "sample"],
      repo,
      {
        ...io,
        approvalTTY: true,
        confirmProject: async () => "sample",
      },
      host,
    ),
    0,
  );
  let doctorOutput = "";
  const doctorIo = {
    ...io,
    stdout: {
      write: (text: string) => {
        doctorOutput += text;
      },
    },
  };
  const offline = {
    ...host,
    platform: "linux" as const,
    async command() {
      return { code: 1, stdout: "" };
    },
  };
  writeFileSync(join(repo, "package.json"), "{}");
  const args = ["doctor", "--target", repo, "--json"];
  assert.equal(await runBootstrap(args, repo, doctorIo, offline), 3);
  const checks = JSON.parse(doctorOutput);
  const effective = checks.find(
    ({ id }: { id: string }) => id === "effective-configuration",
  ).effective;
  assert.deepEqual(effective.config.verification, verification("approved"));
  assert.equal(effective.sources.verification, "approved");
  writeFileSync(
    local,
    JSON.stringify({
      version: 1,
      egress: { Verification: ["redacted-value:443"] },
    }),
  );
  doctorOutput = "";
  assert.equal(await runBootstrap(args, repo, doctorIo, offline), 3);
  const check = JSON.parse(doctorOutput).find(
    ({ id }: { id: string }) => id === "configuration",
  );
  assert.equal(check.status, "wrong");
  assert.equal(check.needsHuman, true);
  assert.ok(check.detail.includes(`Invalid local configuration (${local})`));
  assert.match(check.detail, /egress.Verification/);
  assert.match(check.fix[0], /config edit --project sample/);
  rmSync(local);
  const approved = join(projectConfigDirectory("sample", env), "approved.json");
  writeFileSync(approved, "{}");
  assert.throws(
    () => loadConfig(env, projectConfigDirectory("sample", env)),
    (error: ConfigError) => {
      assert.ok(
        error.message.includes(`Invalid approved configuration (${approved})`),
      );
      assert.match(error.next, /project approve sample/);
      return true;
    },
  );
  assert.doesNotMatch(doctorOutput, /redacted-value/);
});

test("C9: migrates default and external state, refuses active sessions, and permits reruns", async (t) => {
  const { root, repo, env } = fixture(t);
  const other = initConfigRepo(join(root, "other"));
  const legacy = join(repo, ".local/local-orchestrator");
  const slug =
    basename(other) +
    "-" +
    createHash("sha256").update(other).digest("hex").slice(0, 12);
  const oldTarget = join(legacy, "targets", slug);
  mkdirSync(oldTarget, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(oldTarget, "config.json"),
    JSON.stringify(verification("legacy")),
    { mode: 0o600 },
  );
  const db = OrchestratorStore.open(join(legacy, "state.db"));
  const { id } = db.startSession("Concierge", "migration-test");
  assert.throws(() => migrate(repo, [other], env), /A lease or run is active/);
  assert.deepEqual(listProjects(env), []);
  db.endSession(id);
  db.close();
  const state = userStateDirectory(env);
  const leaseDirectory = join(state, "credentials", "fixture");
  privatePath(leaseDirectory, state, true);
  const lease = join(leaseDirectory, "lock.sqlite");
  writeFileSync(lease, "", { mode: 0o600 });
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (path: string) => { exec(sql: string): void; close(): void };
  };
  const leaseDb = new Database(lease);
  leaseDb.exec(
    "CREATE TABLE lease (id TEXT, pid INTEGER); INSERT INTO lease VALUES ('orphan-fixture', 0)",
  );
  assert.throws(
    () => migrate(repo, [other], env),
    (error: ConfigError) => {
      assert.match(error.message, /A lease or run is active/);
      assert.match(
        error.next,
        /agent-bootstrap doctor.*stale or quarantined.*credentials detach --force/,
      );
      return true;
    },
  );
  assert.deepEqual(listProjects(env), []);
  leaseDb.exec("DELETE FROM lease");
  leaseDb.close();
  await assert.rejects(
    resolveTarget(repo, repo, env),
    (error: ConfigError) => error.next === "agent-bootstrap migrate",
  );
  assert.throws(() => migrate(repo, [], env), /cannot be identified/);
  addProject(other, undefined, env);
  const otherConfig = projectConfigDirectory("other", env);
  writePrivateConfig(join(otherConfig, "local.json"), configRoot(env), {
    version: 1,
    verification: verification("conflict"),
  });
  assert.throws(
    () => migrate(repo, [other], env),
    /different local configuration/,
  );
  assert.equal(existsSync(legacy), true);
  assert.equal(
    existsSync(join(projectStateDirectory("sample", env), "state.db")),
    true,
  );
  const migrated = listProjects(env).find(({ name }) => name === "sample")!;
  assert.match(migrated.id, /^[a-f0-9]{12}$/);
  rmSync(join(otherConfig, "local.json"));
  assert.deepEqual(migrate(repo, [other], env), {
    projects: ["sample", "other"],
    orphanedVolumes: [
      `lo-concierge-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}`,
      `lo-concierge-${slug}`,
    ],
  });
  assert.equal(existsSync(legacy), false);
  assert.equal(
    (await resolveTarget(repo, repo, env)).volume,
    `lo-concierge-sample-${migrated.id}`,
  );
  assert.equal(
    existsSync(join(projectStateDirectory("sample", env), "state.db")),
    true,
  );
  assert.deepEqual(
    loadConfig(env, projectConfigDirectory("other", env)).config.verification,
    verification("legacy"),
  );
  assert.deepEqual(migrate(repo, [], env), {
    projects: [],
    orphanedVolumes: [],
  });
  assert.equal(listProjects(env).length, 2);
});
