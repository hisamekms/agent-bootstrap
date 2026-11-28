import assert from "node:assert/strict";
import {
  cpSync,
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
import { test, type TestContext } from "node:test";
import {
  configRoot,
  loadConfig,
  parseConfig,
  projectConfigDirectory,
  userConfigPath,
  writePrivateConfig,
} from "../src/config/layers.ts";
import { addProject, readDeclaration } from "../src/config/projects.ts";
import { bunAdapter } from "../src/environments/bun.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { BUN_VERSION } from "../src/image-recipes.ts";
import {
  hostCheckDigest,
  matchHostCheck,
  parseHostChecks,
  recomputeHostCheckApprovalDigest,
  validateHostCheckHome,
} from "../src/local-orchestrator/host-checks.ts";
import { runBootstrap } from "../src/onboarding/cli.ts";
import { doctor, systemHost } from "../src/onboarding/prerequisites.ts";
import { configEnv, fixtureGit, initConfigRepo } from "./config-fixture.ts";

const basic = { name: "runtime-1", argv: ["/bin/check"], timeoutMs: 1000 };
const parse = (overrides: Record<string, unknown> = {}) =>
  parseHostChecks([{ ...basic, ...overrides }], "Edit local.json.")[0]!;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "host-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = configEnv(root);
  const repo = initConfigRepo(join(root, "repo"));
  const project = addProject(repo, "sample", env);
  const directory = projectConfigDirectory(project.name, env);
  const local = (hostChecks: unknown) =>
    writePrivateConfig(join(directory, "local.json"), configRoot(env), {
      version: 1,
      hostChecks,
    });
  const user = (settings: object) =>
    writePrivateConfig(userConfigPath(env), configRoot(env), {
      version: 1,
      ...settings,
    });
  return { root, env, repo, project, directory, local, user };
}

test("host check declarations accept inclusive limits and default the VM count", () => {
  assert.deepEqual(parse(), { ...basic, vmCount: 0 });
  assert.deepEqual(parseHostChecks([], "Edit local.json."), []);
  const limits = {
    argv: ["/", ...Array.from({ length: 31 }, () => "x".repeat(1024))],
    timeoutMs: 7_200_000,
    env: Object.fromEntries([
      ["MSB_HOME", "/tmp/target-msb"],
      ["_EMPTY", ""],
      ...Array.from({ length: 30 }, (_, i) => [`ENV_${i}`, "a".repeat(1024)]),
    ]),
    keychain: Array.from({ length: 8 }, (_, i) => ({
      service: "項".repeat(128),
      env: `KEY_${i}`,
    })),
    triggers: [
      "x".repeat(4096),
      ...Array.from({ length: 63 }, (_, i) => `path/${i}`),
    ],
    vmCount: 4,
  };
  const all = Array.from({ length: 8 }, (_, i) => ({
    ...limits,
    name: `-${"a".repeat(30)}${i}`,
  }));
  assert.deepEqual(parseHostChecks(all, "Edit local.json."), all);
});

test("host check declarations reject invalid shapes, names and commands", () => {
  for (const value of [
    {},
    null,
    "checks",
    Array.from({ length: 9 }, (_, i) => ({ ...basic, name: `check-${i}` })),
  ])
    assert.throws(() => parseHostChecks(value, ""), /hostChecks/);
  assert.throws(() => parseHostChecks([null], ""), /hostChecks\[0\]/);
  assert.throws(() => parseHostChecks([basic, basic], ""), /\.name/);
  for (const name of ["", "a".repeat(33), "UPPER", "name_1", "name\n", 42])
    assert.throws(() => parse({ name }), /\.name/);
  assert.throws(() => parse({ unexpected: true }), /only supported keys/);
  for (const argv of [
    undefined,
    "command",
    [],
    ["relative"],
    ["/bin/check", 1],
    ["/bin/check", ""],
    ["/bin/ch\0eck"],
    ["/bin/check", "bad\0argument"],
    ["/" + "x".repeat(1024)],
    Array.from({ length: 33 }, () => "/bin/check"),
  ])
    assert.throws(() => parse({ argv }), /\.argv/);
  for (const timeoutMs of [
    undefined,
    "1000",
    999,
    1000.1,
    7_200_001,
    Infinity,
    2 ** 53,
  ])
    assert.throws(() => parse({ timeoutMs }), /\.timeoutMs/);
});

test("host check declarations validate literal environment and Keychain names", () => {
  for (const env of [
    null,
    [],
    { a: "" },
    { "0A": "" },
    { "A-B": "" },
    { "A\n": "" },
    { PATH: "" },
    { HOME: "" },
    { TMPDIR: "" },
    { A: false },
    { A: "x\0" },
    { A: "x".repeat(1025) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`A${i}`, ""])),
  ])
    assert.throws(() => parse({ env }), /\.env/);
  const item = { service: "shared item", env: "TOKEN" };
  assert.deepEqual(
    parse({ keychain: [item, { ...item, env: "TOKEN_2" }] }).keychain?.length,
    2,
  );
  for (const keychain of [
    {},
    null,
    [null],
    [{ ...item, secret: "value" }],
    Array(9).fill(item),
    [item, item],
    [{ env: "A" }],
    [{ ...item, service: "" }],
    [{ ...item, service: 5 }],
    [{ ...item, service: "x".repeat(129) }],
    [{ ...item, service: "bad\x7f" }],
    [{ ...item, service: "bad\nline" }],
    ...["PATH", "HOME", "TMPDIR", "bad-key", undefined].map((env) => [
      { ...item, env },
    ]),
  ])
    assert.throws(() => parse({ keychain }), /\.keychain/);
  assert.throws(
    () => parse({ env: { TOKEN: "" }, keychain: [item] }),
    /appears only once/,
  );
});

test("host check declarations validate triggers and VM fields", () => {
  assert.throws(
    () => parse({ triggers: [] }),
    /hostChecks\[0\]\.triggers.*Omit triggers to always run the check; otherwise list at least one path\./,
  );
  for (const triggers of [
    {},
    null,
    Array(65).fill("src/"),
    [12],
    [""],
    ["/src"],
    ["../src"],
    ["src//nested"],
    ["a/./b"],
    ["C:/src"],
    ["src\\file"],
    ["nul\0"],
    ["line\n"],
    ["x".repeat(4097)],
  ])
    assert.throws(() => parse({ triggers }), /\.triggers/);
  for (const vmCount of [-1, 5, 2.5, "2", undefined, 2 ** 53])
    assert.throws(() => parse({ vmCount }), /\.vmCount/);
  for (const env of [{}, { MSB_HOME: "" }, { MSB_HOME: ".msb" }])
    assert.throws(() => parse({ vmCount: 1, env }), /\.env\.MSB_HOME/);
  assert.throws(
    () =>
      parse({ vmCount: 1, keychain: [{ service: "item", env: "MSB_HOME" }] }),
    /absolute path is required/,
  );
  assert.equal(parse({ vmCount: 0 }).vmCount, 0);
});

test("only private target config can declare host checks and supplies the source", (t) => {
  const { env, repo, project, directory, local, user } = fixture(t);
  const denial = /hostChecks\. Allowed only in private local\.json\./;
  user({ hostChecks: [] });
  assert.throws(() => loadConfig(env, directory), denial);
  user({});
  mkdirSync(join(repo, ".agent-bootstrap"));
  writeFileSync(
    join(repo, ".agent-bootstrap/project.json"),
    JSON.stringify({ version: 1, hostChecks: [] }),
  );
  fixtureGit(repo, "add", ".agent-bootstrap/project.json");
  fixtureGit(repo, "commit", "-m", "Disallowed project declaration");
  assert.throws(() => readDeclaration(project), denial);
  assert.throws(
    () => parseConfig({ version: 1, hostChecks: [] }, "approved"),
    denial,
  );
  local([basic]);
  const loaded = loadConfig(env, directory);
  assert.deepEqual(loaded.config.hostChecks, [parse()]);
  assert.equal(loaded.sources.hostChecks, "local");
});

test("VM checks use a home distinct from the configured, overridden or default agent home", (t) => {
  const { root, env, directory, local, user } = fixture(t);
  const agent = join(root, "agent-msb");
  const alias = join(root, "alias-msb");
  mkdirSync(agent);
  symlinkSync(agent, alias);
  const checkHome = (home: string) =>
    local([{ ...basic, vmCount: 1, env: { MSB_HOME: home } }]);
  const clash = /different Microsandbox home/;
  checkHome(`${root}/./.msb/`);
  assert.throws(() => loadConfig(env, directory), clash);
  user({ microsandbox: { home: agent } });
  assert.equal(loadConfig(env, directory).config.hostChecks?.[0]?.vmCount, 1);
  checkHome(`${agent}/../agent-msb/`);
  assert.throws(() => loadConfig(env, directory), clash);
  checkHome(alias);
  assert.throws(() => loadConfig(env, directory), clash);
  checkHome(join(alias, "missing", "child"));
  assert.throws(
    () =>
      loadConfig(
        { ...env, MSB_HOME: join(agent, "missing", "child") },
        directory,
      ),
    clash,
  );
  checkHome(alias);
  assert.equal(
    loadConfig({ ...env, MSB_HOME: join(root, "other-msb") }, directory).config
      .hostChecks?.length,
    1,
  );
  checkHome(`${root}/other-msb/.`);
  assert.throws(
    () => loadConfig({ ...env, MSB_HOME: join(root, "other-msb") }, directory),
    clash,
  );
  mkdirSync(join(root, "other", "nested"), { recursive: true });
  mkdirSync(join(root, "other", "agent-msb"));
  symlinkSync(join(root, "other", "nested"), join(root, "nested-alias"));
  checkHome(`${root}/nested-alias/../agent-msb`);
  assert.equal(loadConfig(env, directory).config.hostChecks?.length, 1);
});

test("VM checks require an absolute agent home", (t) => {
  const { root, env, directory, local } = fixture(t);
  const noHome = { ...env, HOME: undefined };
  local([basic]);
  assert.equal(loadConfig(noHome, directory).config.hostChecks?.length, 1);
  local([{ ...basic, vmCount: 1, env: { MSB_HOME: join(root, "check") } }]);
  for (const agentEnv of [noHome, { ...env, MSB_HOME: "relative" }])
    assert.throws(
      () => loadConfig(agentEnv, directory),
      /hostChecks\[0\]\.env\.MSB_HOME.*agent-bootstrap's Microsandbox home to an absolute path/,
    );
});

test("VM home validation rejects overlapping paths and can be repeated", (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "host-check-homes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const declaration = (home: string) =>
    parse({ vmCount: 1, env: { MSB_HOME: home } });
  const validate = (home: string, agent: string) =>
    validateHostCheckHome(declaration(home), agent, "Edit local.json.");
  const home = join(root, "Café");
  const foldedAlias = join(root, "CAFE\u0301");
  const missingChild = join(foldedAlias, "vm");
  const clash = /different Microsandbox home/;
  assert.throws(() => validate(home, foldedAlias), clash);
  assert.throws(() => validate(missingChild, home), clash);
  assert.throws(() => validate(home, missingChild), clash);
  assert.doesNotThrow(() => validate(join(root, "Café-other"), home));

  const existingChild = join(home, "vm");
  mkdirSync(existingChild, { recursive: true });
  assert.throws(() => validate(existingChild, home), clash);
  assert.throws(() => validate(home, existingChild), clash);

  const alias = join(root, "alias");
  const check = declaration(alias);
  validateHostCheckHome(check, existingChild, "Edit local.json.");
  symlinkSync(home, alias);
  assert.throws(
    () => validateHostCheckHome(check, existingChild, "Edit local.json."),
    clash,
  );
  assert.throws(() => validate(join(alias, "missing"), home), clash);
});

test("config edit checks the declared VM home against the user configuration", async (t) => {
  const { root, env, local, user } = fixture(t);
  const home = join(root, "shared-msb");
  user({ microsandbox: { home } });
  local([{ ...basic, vmCount: 1, env: { MSB_HOME: home } }]);
  let output = "";
  const result = await runBootstrap(
    ["config", "edit", "--project", "sample", "--json"],
    root,
    {
      stdin: process.stdin,
      stdout: {
        write(text) {
          output += text;
        },
      },
      stderr: { write() {} },
      isTTY: false,
      conciergeTTY: false,
      prompt: () => undefined,
    },
    { ...systemHost, env: { ...env, EDITOR: "/usr/bin/true" } },
  );
  assert.notEqual(result, 0);
  assert.match(JSON.parse(output).error, /different Microsandbox home/);
});

test("the declaration digest is canonical and includes every field", () => {
  const raw = {
    env: { B: "second", A: "first", MSB_HOME: "/tmp/target-msb" },
    keychain: [{ service: "item", env: "TOKEN" }],
    triggers: ["src/", "test.ts"],
    vmCount: 1,
  };
  const digest = hostCheckDigest(parse(raw));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    digest,
    hostCheckDigest(
      parse({
        vmCount: 1,
        triggers: raw.triggers,
        keychain: [{ env: "TOKEN", service: "item" }],
        env: { MSB_HOME: "/tmp/target-msb", A: "first", B: "second" },
      }),
    ),
  );
  assert.equal(
    hostCheckDigest(parse()),
    hostCheckDigest(parse({ vmCount: 0 })),
  );
  for (const changed of [
    { name: "second" },
    { argv: ["/bin/check", "extra"] },
    { timeoutMs: 2000 },
    { env: { ...raw.env, A: "new" } },
    { keychain: [{ service: "new", env: "TOKEN" }] },
    { keychain: [{ service: "item", env: "NEW_TOKEN" }] },
    { triggers: [...raw.triggers].reverse() },
    { vmCount: 2 },
  ])
    assert.notEqual(digest, hostCheckDigest(parse({ ...raw, ...changed })));
});

test("the declaration digest treats empty env and keychain as omitted", () => {
  const digest = hostCheckDigest(parse());
  for (const fields of [
    { env: {} },
    { keychain: [] },
    { env: {}, keychain: [] },
  ])
    assert.equal(hostCheckDigest(parse(fields)), digest);
});

function change(path: string, oldMode = "100644", newMode = oldMode) {
  return { path, oldMode, newMode };
}

test("matching uses folded NFC scope paths, exact files and directory prefixes", () => {
  const declaration = parse({ triggers: ["Cafe\u0301/", "README.md"] });
  assert.deepEqual(
    matchHostCheck(declaration, [
      change("café/nested/file"),
      change("CAFÉ/sub"),
      change("README.MD"),
      change("caféteria/file"),
      change("café"),
      change("readme.md.bak"),
      change("readme.md/child"),
      change("README.MD"),
    ]),
    { required: true, matched: ["CAFÉ/sub", "README.MD", "café/nested/file"] },
  );
  assert.deepEqual(matchHostCheck(declaration, [change("docs/file")]), {
    required: false,
    matched: [],
  });
  assert.deepEqual(matchHostCheck(parse(), []), {
    required: true,
    matched: [],
  });
  assert.deepEqual(matchHostCheck(parse(), [change("other")]), {
    required: true,
    matched: [],
  });
});

test("matching covers every fixed basename and the Bun adapter's actual layout", async () => {
  const declaration = parse({ triggers: ["src/"] });
  for (const basename of [
    "Package.json",
    "bunfig.toml",
    ".bunfig.toml",
    "bun.lockb",
    "tsconfig.json",
    "TSConfig.test.json",
    "mise.toml",
    ".mise.toml",
    "mise.lock",
    ".tool-versions",
    ".env",
    ".ENV.test",
    ".npmrc",
  ]) {
    const path = `deep/nested/${basename}`;
    assert.deepEqual(matchHostCheck(declaration, [change(path)]), {
      required: true,
      matched: [path],
    });
  }
  const layout = await bunAdapter.layout({
    paths: ["package.json", "packages/workspace/package.json"],
    async read() {
      return Buffer.from('{"workspaces":["packages/*"]}');
    },
  });
  for (const path of [
    ...layout.keyFiles,
    ...layout.outputs,
    ...layout.outputs.map((output) => `${output}/.bin/run`),
    `nested/${bunAdapter.lockPath}`,
  ])
    assert.deepEqual(matchHostCheck(declaration, [change(path)]), {
      required: true,
      matched: [path],
    });
  for (const path of [
    "bun.lock.backup",
    ".environment",
    ".envrc",
    "tsconfig.js",
    "node_modules-extra/file",
  ])
    assert.deepEqual(matchHostCheck(declaration, [change(path)]), {
      required: false,
      matched: [],
    });
});

test("matching covers mise's implicit configuration at any depth", () => {
  const declaration = parse({ triggers: ["src/"] });
  for (const prefix of ["", "deep/nested/"]) {
    for (const file of [
      "mise.local.toml",
      ".mise.local.toml",
      "mise.production.toml",
      ".mise.production.local.toml",
      ".CONFIG/MISE/tasks/nested/build",
      ".config/mise/config.toml",
      "mise/config.toml",
      ".mise/config.toml",
      ".config/mise.toml",
    ]) {
      const path = prefix + file;
      assert.deepEqual(matchHostCheck(declaration, [change(path)]), {
        required: true,
        matched: [path],
      });
    }
  }
  for (const path of [
    "deep/not.config/mise/tasks/build",
    "deep/.config/mise-other/config.toml",
    "deep/other-mise/config.toml",
    "deep/mise/config.toml.bak",
    "deep/mise.prod.toml.bak",
  ])
    assert.deepEqual(matchHostCheck(declaration, [change(path)]), {
      required: false,
      matched: [],
    });
});

test("matching requires symlink and mode or type changes but allows ordinary adds and deletes", () => {
  const checks = [
    change("symlink-added", "000000", "120000"),
    change("symlink-deleted", "120000", "000000"),
    change("symlink-retargeted", "120000"),
    change("mode-changed", "100644", "100755"),
    change("type-changed", "100755", "120000"),
  ];
  assert.deepEqual(
    matchHostCheck(parse({ triggers: ["src/"] }), [
      ...checks,
      change("regular-added", "000000", "100644"),
      change("regular-deleted", "100755", "000000"),
      change("regular-modified"),
    ]),
    { required: true, matched: checks.map(({ path }) => path).sort() },
  );
});

test("matching detects file and directory replacements in recursive diffs", () => {
  const declaration = parse({ triggers: ["src/"] });
  for (const [before, after] of [
    ["100644", "000000"],
    ["000000", "100644"],
  ] as const) {
    assert.deepEqual(
      matchHostCheck(declaration, [
        change("nested/Café", before, after),
        change("nested/CAFE\u0301/child/file", after, before),
      ]),
      { required: true, matched: ["nested/Café"] },
    );
  }
});

test("the Git candidate diff matches either side of a rename", async (t) => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo, "from.txt"), "fixture");
  fixtureGit(repo, "add", "from.txt");
  fixtureGit(repo, "commit", "-m", "Add file");
  const base = fixtureGit(repo, "rev-parse", "HEAD");
  fixtureGit(repo, "mv", "from.txt", "to.txt");
  fixtureGit(repo, "commit", "-m", "Rename file");
  const candidate = fixtureGit(repo, "rev-parse", "HEAD");
  const bare = join(root, "candidate.git");
  mkdirSync(bare);
  fixtureGit(bare, "init", "--bare", "--template=", "--object-format=sha1");
  cpSync(join(repo, ".git/objects"), join(bare, "objects"), {
    recursive: true,
  });
  const integration = new LocalGitIntegration({
    binary: "/usr/bin/git",
    repository: bare,
    stagingRoot: root,
    branch: "main",
  });
  const changes = await integration.candidateChanges(base, candidate);
  for (const path of ["from.txt", "to.txt"])
    assert.deepEqual(matchHostCheck(parse({ triggers: [path] }), changes), {
      required: true,
      matched: [path],
    });
  assert.deepEqual(
    matchHostCheck(parse({ triggers: ["to.txt", "from.txt"] }), changes),
    {
      required: true,
      matched: ["from.txt", "to.txt"],
    },
  );
});

test("target doctor reports host check prerequisites without executing a check or reading Keychain", async (t) => {
  const { root, repo, local, env } = fixture(t);
  const executable = join(root, "check executable");
  const nonExecutable = join(root, "check data");
  const missing = join(root, "check missing");
  const msb = join(root, "target-msb");
  writeFileSync(executable, "file", { mode: 0o700 });
  writeFileSync(nonExecutable, "file", { mode: 0o600 });
  mkdirSync(msb);
  local([
    {
      ...basic,
      argv: [executable, "private-argument"],
      env: { MSB_HOME: msb, VALUE: "private-env" },
      triggers: ["src/"],
      vmCount: 2,
      keychain: [{ service: "fixture-runner-item", env: "RUNNER_KEY" }],
    },
    { ...basic, name: "no-exec", argv: [nonExecutable] },
    {
      ...basic,
      name: "missing",
      argv: [missing],
      vmCount: 1,
      env: { MSB_HOME: join(root, "missing-msb") },
    },
  ]);
  const { checks, first } = await doctor(
    fileURLToPath(new URL("..", import.meta.url)),
    {
      ...systemHost,
      env,
      platform: "darwin",
      arch: "arm64",
      bun: BUN_VERSION,
      async command(file, args) {
        assert.ok(![executable, nonExecutable, missing].includes(file));
        assert.ok(!args.includes("fixture-runner-item"));
        return { code: 1, stdout: "" };
      },
      fetch: async () => assert.fail("doctor tried the network"),
    },
    repo,
  );
  assert.partialDeepStrictEqual(
    checks.find(({ id }) => id === "host-checks-warning"),
    {
      detail:
        "host-check runs are not implemented yet; matching Tasks will wait at the host-check gate",
    },
  );
  const items = checks.filter(({ id }) => id.startsWith("host-check-"));
  assert.deepEqual(
    items.map(({ id, status }) => [id, status]),
    [
      ["host-check-runtime-1", "ok"],
      ["host-check-no-exec", "wrong"],
      ["host-check-missing", "missing"],
    ],
  );
  assert.ok(items[0]!.detail.includes(JSON.stringify(executable)));
  assert.match(
    items[0]!.detail,
    /exists and is executable.*Triggers 1.*vmCount 2.*MSB_HOME exists.*fixture-runner-item/,
  );
  assert.match(
    items[1]!.detail,
    /exists and is not executable.*MSB_HOME undeclared/,
  );
  assert.match(
    items[2]!.detail,
    /missing or inaccessible.*MSB_HOME missing or inaccessible/,
  );
  assert.doesNotMatch(
    JSON.stringify(items),
    /private-argument|private-env|RUNNER_KEY/,
  );
  assert.ok(
    items.every(({ needsNetwork, needsHuman }) => !needsNetwork && !needsHuman),
  );
  assert.ok(first && !items.includes(first));
});

test("approval digest pins commits, ordered declarations, archive and executable identity", async (t) => {
  const { root } = fixture(t);
  const command = join(root, "declared-check");
  const first = join(root, "first");
  const second = join(root, "second");
  for (const file of [first, second])
    writeFileSync(file, "fixture executable, never invoked", { mode: 0o700 });
  symlinkSync(first, command);
  const declaration = parse({
    argv: [command, "run"],
    keychain: [{ service: "one", env: "SERVICE_KEY" }],
  });
  const other = { ...declaration, name: "second-check" };
  const pin = { base: "a".repeat(40), candidate: "b".repeat(40) };
  const checks = [declaration, other];
  const archive = "c".repeat(64);
  const digest = await recomputeHostCheckApprovalDigest(pin, checks, archive);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    await recomputeHostCheckApprovalDigest(pin, checks, archive),
    digest,
  );
  for (const newPin of [
    { ...pin, base: "d".repeat(40) },
    { ...pin, candidate: "d".repeat(40) },
  ])
    assert.notEqual(
      await recomputeHostCheckApprovalDigest(newPin, checks, archive),
      digest,
    );
  assert.notEqual(
    await recomputeHostCheckApprovalDigest(pin, checks, null),
    digest,
  );
  assert.notEqual(
    await recomputeHostCheckApprovalDigest(pin, checks, "d".repeat(64)),
    digest,
  );
  assert.notEqual(
    await recomputeHostCheckApprovalDigest(pin, [...checks].reverse(), archive),
    digest,
  );
  assert.notEqual(
    await recomputeHostCheckApprovalDigest(
      pin,
      [
        { ...declaration, keychain: [{ service: "two", env: "SERVICE_KEY" }] },
        other,
      ],
      archive,
    ),
    digest,
  );
  rmSync(command);
  symlinkSync(second, command);
  const retargeted = await recomputeHostCheckApprovalDigest(
    pin,
    checks,
    archive,
  );
  assert.notEqual(retargeted, digest);
  writeFileSync(second, "updated fixture");
  assert.notEqual(
    await recomputeHostCheckApprovalDigest(pin, checks, archive),
    retargeted,
  );
});
