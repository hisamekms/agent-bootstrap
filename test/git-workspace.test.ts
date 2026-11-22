import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitIntegrationError,
  LocalGitIntegration,
} from "../src/git-integration.ts";

const gitBinary = "/usr/bin/git";

function git(
  directory: string,
  args: string[],
  input = "",
  extraEnv: Record<string, string> = {},
): string {
  const result = spawnSync(gitBinary, args, {
    cwd: directory,
    input,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "f@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "f@example.invalid",
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Bare repo with commits c1 <- c2 <- c3 on main. */
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "bootstrap-ws-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo.git");
  await mkdir(repository, { mode: 0o700 });
  git(repository, ["init", "--bare", "--template=", "--initial-branch=main"]);
  const blob = (text: string) =>
    git(repository, ["hash-object", "-w", "--stdin"], text);
  const commit = (entries: string[], parent?: string) => {
    const tree = git(repository, ["mktree"], entries.join(""));
    return git(repository, [
      "commit-tree",
      tree,
      ...(parent ? ["-p", parent] : []),
      "-m",
      "commit",
    ]);
  };
  const readme = blob("readme\n");
  const script = blob("#!/bin/sh\n");
  const deep = blob("deep\n");
  const other = blob("other\n");
  const link = blob("README.md");
  const sub = (name: string, entries: string[]) =>
    git(repository, ["mktree"], entries.join("")) + `\t${name}`;
  const lib = git(repository, ["mktree"], `100644 blob ${deep}\tx.ts\n`);
  const srcA = git(
    repository,
    ["mktree"],
    `040000 tree ${lib}\tlib\n100644 blob ${other}\ta.ts\n`,
  );
  void sub;
  const docs = git(repository, ["mktree"], `100644 blob ${other}\td.md\n`);
  const c1 = commit([
    `100644 blob ${readme}\tREADME.md\n`,
    `100755 blob ${script}\trun.sh\n`,
    `120000 blob ${link}\tlink\n`,
    `040000 tree ${srcA}\tsrc\n`,
    `040000 tree ${docs}\tdocs\n`,
  ]);
  const readme2 = blob("readme 2\n");
  const c2 = commit(
    [
      `100644 blob ${readme2}\tREADME.md\n`,
      `100755 blob ${script}\trun.sh\n`,
      `120000 blob ${link}\tlink\n`,
      `040000 tree ${srcA}\tsrc\n`,
      `040000 tree ${docs}\tdocs\n`,
    ],
    c1,
  );
  const c3 = commit(
    [
      `100644 blob ${blob("readme 3\n")}\tREADME.md\n`,
      `100755 blob ${script}\trun.sh\n`,
      `120000 blob ${link}\tlink\n`,
      `040000 tree ${srcA}\tsrc\n`,
      `040000 tree ${docs}\tdocs\n`,
    ],
    c2,
  );
  git(repository, ["update-ref", "refs/heads/main", c3]);
  const integration = new LocalGitIntegration({
    binary: gitBinary,
    repository,
    stagingRoot: join(root, "staging"),
    branch: "main",
  });
  return { root, repository, integration, c1, c2, c3 };
}

const inRepo = (gitDir: string, args: string[]) =>
  git(gitDir, [`--git-dir=${gitDir}`, ...args]);

function parseTar(bytes: Buffer) {
  const out = new Map<
    string,
    { mode: number; type: string; body: string; link: string }
  >();
  let offset = 0;
  let pax: Record<string, string> = {};
  while (offset + 512 <= bytes.length && bytes[offset] !== 0) {
    const header = bytes.subarray(offset, offset + 512);
    const text = (a: number, b: number) =>
      header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(text(124, 136), 8);
    const type = text(156, 157);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = {};
      for (const line of body.toString("utf8").split("\n").filter(Boolean)) {
        const rest = line.slice(line.indexOf(" ") + 1);
        pax[rest.slice(0, rest.indexOf("="))] = rest.slice(
          rest.indexOf("=") + 1,
        );
      }
      continue;
    }
    out.set(pax.path ?? text(0, 100), {
      mode: Number.parseInt(text(100, 108), 8),
      type,
      body: body.toString("utf8"),
      link: pax.linkpath ?? text(157, 257),
    });
    pax = {};
  }
  return out;
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof GitIntegrationError && error.code === code,
  );
}

test("workspace has full history, work/base refs, no remotes and a HEAD index", async (t) => {
  const { integration, c1, c3 } = await fixture(t);
  const ws = await integration.prepareWorkspace({ base: c3 });
  t.after(() => integration.cleanupWorkspace(ws.directory));
  assert.equal((await stat(ws.directory)).mode & 0o077, 0);
  assert.equal(inRepo(ws.gitDir, ["rev-list", "--count", "HEAD"]), "3");
  assert.equal(inRepo(ws.gitDir, ["rev-parse", "HEAD"]), c3);
  assert.equal(inRepo(ws.gitDir, ["symbolic-ref", "HEAD"]), "refs/heads/work");
  assert.equal(inRepo(ws.gitDir, ["rev-parse", "refs/heads/base"]), c3);
  assert.equal(inRepo(ws.gitDir, ["rev-parse", "refs/heads/work"]), c3);
  assert.equal(inRepo(ws.gitDir, ["rev-parse", c1]), c1);
  assert.equal(inRepo(ws.gitDir, ["remote"]), "");
  assert.equal(inRepo(ws.gitDir, ["config", "core.hooksPath"]), "/dev/null");
  assert.equal(inRepo(ws.gitDir, ["config", "core.bare"]), "false");
  assert.equal(
    inRepo(ws.gitDir, ["config", "user.email"]),
    "worker@agent-bootstrap.invalid",
  );
  assert.equal(inRepo(ws.gitDir, ["config", "commit.gpgsign"]), "false");
  const lsFiles = inRepo(ws.gitDir, ["ls-files", "-s"])
    .split("\n")
    .map((l) => l.replace(/ 0\t/, " ").split(" ").join("|"));
  const lsTree = inRepo(ws.gitDir, ["ls-tree", "-r", "HEAD"])
    .split("\n")
    .map((l) =>
      l
        .replace(/ blob /, " ")
        .replace("\t", " ")
        .split(" ")
        .join("|"),
    );
  assert.deepEqual(lsFiles, lsTree);
  assert.equal(inRepo(ws.gitDir, ["ls-files", "-v"]).includes("S "), false);
  assert.deepEqual(
    (await import("node:fs")).readdirSync(ws.gitDir).includes("hooks"),
    false,
  );
});

test("tar content, modes and symlinks match the commit", async (t) => {
  const { integration, c3 } = await fixture(t);
  const ws = await integration.prepareWorkspace({ base: c3 });
  t.after(() => integration.cleanupWorkspace(ws.directory));
  const tar = parseTar(await readFile(ws.tree));
  assert.deepEqual(
    [...tar.keys()],
    inRepo(ws.gitDir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n"),
  );
  assert.equal(tar.get("README.md")?.body, "readme 3\n");
  assert.equal(tar.get("README.md")?.mode, 0o644);
  assert.equal(tar.get("run.sh")?.mode, 0o755);
  assert.equal(tar.get("link")?.type, "2");
  assert.equal(tar.get("link")?.link, "README.md");
  assert.equal(tar.get("src/lib/x.ts")?.body, "deep\n");
  assert.equal(spawnSync("/usr/bin/tar", ["-tf", ws.tree]).status, 0);
});

test("previous mode requires base as ancestor", async (t) => {
  const { integration, c1, c2, c3 } = await fixture(t);
  const ws = await integration.prepareWorkspace({ base: c1, previous: c3 });
  t.after(() => integration.cleanupWorkspace(ws.directory));
  assert.equal(inRepo(ws.gitDir, ["rev-parse", "refs/heads/base"]), c1);
  assert.equal(inRepo(ws.gitDir, ["rev-parse", "refs/heads/work"]), c3);
  assert.equal(inRepo(ws.gitDir, ["rev-parse", "HEAD"]), c3);
  assert.equal(inRepo(ws.gitDir, ["rev-list", "--count", "base..work"]), "2");
  assert.equal(
    parseTar(await readFile(ws.tree)).get("README.md")?.body,
    "readme 3\n",
  );
  await rejects(
    integration.prepareWorkspace({ base: c3, previous: c2 }),
    "invalid-input",
  );
});

test("sparse cone mode marks other entries skip-worktree", async (t) => {
  const { integration, c3 } = await fixture(t);
  const ws = await integration.prepareWorkspace({
    base: c3,
    sparsePaths: ["src/lib"],
  });
  t.after(() => integration.cleanupWorkspace(ws.directory));
  assert.equal(inRepo(ws.gitDir, ["config", "core.sparseCheckout"]), "true");
  assert.equal(
    inRepo(ws.gitDir, ["config", "core.sparseCheckoutCone"]),
    "true",
  );
  assert.equal(
    await readFile(join(ws.gitDir, "info", "sparse-checkout"), "utf8"),
    "/*\n!/*/\n/src/\n!/src/*/\n/src/lib/\n",
  );
  const skipped = inRepo(ws.gitDir, ["ls-files", "-v"])
    .split("\n")
    .filter((l) => l.startsWith("S "))
    .map((l) => l.slice(2));
  assert.deepEqual(skipped, ["docs/d.md"]);
  const names = [...parseTar(await readFile(ws.tree)).keys()];
  assert.deepEqual(names, [
    "README.md",
    "link",
    "run.sh",
    "src/a.ts",
    "src/lib/x.ts",
  ]);
});

test("sparse non-cone mode with a file path", async (t) => {
  const { integration, c3 } = await fixture(t);
  const ws = await integration.prepareWorkspace({
    base: c3,
    sparsePaths: ["README.md", "docs"],
  });
  t.after(() => integration.cleanupWorkspace(ws.directory));
  assert.equal(
    inRepo(ws.gitDir, ["config", "core.sparseCheckoutCone"]),
    "false",
  );
  assert.equal(
    await readFile(join(ws.gitDir, "info", "sparse-checkout"), "utf8"),
    "/README.md\n/docs/\n",
  );
  assert.deepEqual(
    [...parseTar(await readFile(ws.tree)).keys()],
    ["README.md", "docs/d.md"],
  );
  await rejects(
    integration.prepareWorkspace({ base: c3, sparsePaths: ["nope"] }),
    "invalid-input",
  );
  await rejects(
    integration.prepareWorkspace({ base: c3, sparsePaths: ["a/../b"] }),
    "invalid-input",
  );
  await rejects(
    integration.prepareWorkspace({ base: c3, sparsePaths: ["*"] }),
    "invalid-input",
  );
});

test("submodules are rejected and cleaned up", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const tree = git(
    repository,
    ["mktree"],
    `160000 commit ${"1".repeat(40)}\tmod\n`,
  );
  const bad = git(repository, ["commit-tree", tree, "-m", "sub"]);
  await rejects(
    integration.prepareWorkspace({ base: bad }),
    "unsupported-entry",
  );
  // Outside the sparse set a gitlink is not materialized.
  const holder = git(
    repository,
    ["mktree"],
    `160000 commit ${"1".repeat(40)}\tmod\n`,
  );
  const mixed = git(
    repository,
    ["mktree"],
    `040000 tree ${holder}\tvendor\n040000 tree ${git(repository, ["rev-parse", `${c3}:docs`])}\tdocs\n`,
  );
  const ok = git(repository, ["commit-tree", mixed, "-m", "mixed"]);
  const ws = await integration.prepareWorkspace({
    base: ok,
    sparsePaths: ["docs"],
  });
  await integration.cleanupWorkspace(ws.directory);
  await rejects(integration.cleanupWorkspace(ws.directory), "invalid-input");
  await rejects(integration.cleanupWorkspace("/tmp"), "invalid-input");
});

test("createCandidateTree builds add, modify, delete, mode and symlink changes", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const candidate = await integration.createCandidateTree(
    c3,
    [
      { path: "new/dir/file.txt", mode: "100644", bytes: Buffer.from("n\n") },
      { path: "README.md", mode: "100644", bytes: Buffer.from("changed\n") },
      { path: "run.sh", mode: "100644", bytes: Buffer.from("#!/bin/sh\n") },
      {
        path: "new/ln",
        mode: "120000",
        bytes: Buffer.from("../new/./dir/file.txt"),
      },
      { path: "docs/d.md", deleted: true },
    ],
    "Worker proposal ✓",
  );
  assert.equal(
    git(repository, ["rev-list", "--parents", "-n1", candidate]),
    `${candidate} ${c3}`,
  );
  assert.equal(
    git(repository, ["log", "-1", "--format=%an|%s", candidate]),
    "Agent Bootstrap|Worker proposal ✓",
  );
  const entries = git(repository, ["ls-tree", "-r", candidate]);
  assert.match(entries, /^100644 blob \w+\tREADME\.md$/m);
  assert.match(entries, /^100644 blob \w+\trun\.sh$/m);
  assert.match(entries, /^120000 blob \w+\tnew\/ln$/m);
  assert.match(entries, /^100644 blob \w+\tnew\/dir\/file\.txt$/m);
  assert.doesNotMatch(entries, /docs/);
  assert.equal(git(repository, ["show", `${candidate}:README.md`]), "changed");
  assert.equal(
    git(repository, ["show", `${candidate}:new/ln`]),
    "../new/./dir/file.txt",
  );
  assert.equal(
    git(repository, [
      "rev-parse",
      `refs/agent-bootstrap/candidates/${candidate}`,
    ]),
    candidate,
  );
  assert.equal(git(repository, ["rev-parse", "main"]), c3);
});

test("createCandidateTree single-file candidate works with diff and advance", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const candidate = await integration.createCandidateTree(
    c3,
    [{ path: "README.md", mode: "100644", bytes: Buffer.from("x\n") }],
    "m",
  );
  assert.match(
    Buffer.from(
      await integration.diff(c3, candidate, { path: "README.md" }),
    ).toString("utf8"),
    /\+x/,
  );
  await rejects(
    integration.diff(c3, candidate, { path: "run.sh" }),
    "invalid-candidate",
  );
  await integration.advance(c3, candidate, { path: "README.md" });
  assert.equal(git(repository, ["rev-parse", "main"]), candidate);
});

test("candidate creation and recheck reject traversal through another symlink", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const links = [
    { path: "sub/l1", mode: "120000", bytes: Buffer.from("..") },
    { path: "sub/l2", mode: "120000", bytes: Buffer.from("l1/../../.ssh") },
  ] as const;
  await rejects(
    integration.createCandidateTree(c3, links, "unsafe links"),
    "invalid-input",
  );

  const env = { GIT_INDEX_FILE: join(repository, "symlink-index") };
  git(repository, ["read-tree", c3], "", env);
  for (const { path, mode, bytes } of links) {
    const blob = git(
      repository,
      ["hash-object", "-w", "--stdin"],
      bytes.toString(),
    );
    git(
      repository,
      ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`],
      "",
      env,
    );
  }
  const tree = git(repository, ["write-tree"], "", env);
  const candidate = git(repository, [
    "commit-tree",
    tree,
    "-p",
    c3,
    "-m",
    "unsafe links",
  ]);
  await rejects(integration.diff(c3, candidate), "invalid-candidate");
});

test("createCandidateTree rejects unsafe or invalid input", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const file = (path: string) => ({
    path,
    mode: "100644" as const,
    bytes: Buffer.from("x"),
  });
  for (const path of [
    ".git/config",
    "a/.GIT/x",
    ".Git",
    "sub/.git ",
    "GIT~1/x",
    ".gi‌t/x",
    "../x",
    "a//b",
    "/abs",
    "a/",
    "a\0b",
    "a\\b",
    "x/./y",
    "a".repeat(5000),
    "",
  ])
    await rejects(
      integration.createCandidateTree(c3, [file(path)], "m"),
      "invalid-input",
    );
  await rejects(
    integration.createCandidateTree(c3, [{ path: "nope", deleted: true }], "m"),
    "invalid-input",
  );
  await rejects(
    integration.createCandidateTree(c3, [{ path: "docs", deleted: true }], "m"),
    "invalid-input",
  );
  await rejects(
    integration.createCandidateTree(
      c3,
      [file("a"), { path: "a", deleted: true }],
      "m",
    ),
    "invalid-input",
  );
  await rejects(
    integration.createCandidateTree(c3, [file("a"), file("a")], "m"),
    "invalid-input",
  );
  await rejects(integration.createCandidateTree(c3, [], "m"), "invalid-input");
  await rejects(
    integration.createCandidateTree(
      c3,
      [{ ...file("a"), mode: "160000" as never }],
      "m",
    ),
    "invalid-input",
  );
  for (const target of ["", "/README.md", "../../README.md", "a\0b", "a\nb"])
    await rejects(
      integration.createCandidateTree(
        c3,
        [{ path: "src/l", mode: "120000", bytes: Buffer.from(target) }],
        "m",
      ),
      "invalid-input",
    );
  await rejects(
    integration.createCandidateTree(c3, [file("SRC/new.ts")], "m"),
    "invalid-input",
  );
  // D/F conflict fails closed in git.
  await rejects(
    integration.createCandidateTree(c3, [file("README.md/x")], "m"),
    "invalid-input",
  );
  await rejects(
    integration.createCandidateTree(c3, [file("docs")], "m"),
    "invalid-input",
  );
  await integration.createCandidateTree(
    c3,
    [{ path: "docs/d.md", deleted: true }, file("docs")],
    "m",
  );
  for (const message of ["", "a\0b", "x".repeat(4097), "\ud800"])
    await rejects(
      integration.createCandidateTree(c3, [file("a")], message),
      "invalid-input",
    );
  await rejects(
    integration.createCandidateTree("1".repeat(40), [file("a")], "m"),
    "git-failed",
  );
  // Only the one valid candidate above was pinned.
  assert.equal(
    git(repository, ["for-each-ref", "refs/agent-bootstrap/"]).split("\n")
      .length,
    1,
  );
});

test("diff and advance accept multi-file candidates and listTree lists the base", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const candidate = await integration.createCandidateTree(
    c3,
    [
      { path: "README.md", mode: "100644", bytes: Buffer.from("x\n") },
      { path: "src/new/n.ts", mode: "100755", bytes: Buffer.from("n\n") },
      { path: "src/a.ts", deleted: true },
      { path: "run.sh", mode: "100644", bytes: Buffer.from("#!/bin/sh\n") },
    ],
    "m",
  );
  const text = Buffer.from(await integration.diff(c3, candidate)).toString();
  assert.match(text, /src\/new\/n\.ts/);
  assert.match(text, /deleted file mode[^]*src\/a\.ts/);
  assert.match(text, /old mode 100755\nnew mode 100644/);
  const listing = Buffer.from(await integration.listTree(c3)).toString();
  assert.match(listing, /^100644 blob [0-9a-f]{40}\tREADME\.md\0/);
  assert.match(listing, /\tsrc\/lib\/x\.ts\0/);
  const expectation = { path: "README.md" };
  await rejects(
    integration.diff(c3, candidate, expectation),
    "invalid-candidate",
  );
  await rejects(
    integration.advance(c3, candidate, expectation),
    "invalid-candidate",
  );
  assert.equal(await integration.head(), c3);
  await integration.advance(c3, candidate);
  assert.equal(git(repository, ["rev-parse", "main"]), candidate);
});

test("review diff shows text even when base attributes mark it binary", async (t) => {
  const { integration, repository, c3 } = await fixture(t);
  const base = await integration.createCandidateTree(
    c3,
    [
      {
        path: ".gitattributes",
        mode: "100644",
        bytes: Buffer.from("* -diff\n"),
      },
    ],
    "base attributes",
  );
  const candidate = await integration.createCandidate(
    base,
    "README.md",
    Buffer.from("review this change\n"),
  );
  assert.match(
    git(repository, ["-c", `attr.tree=${base}`, "diff", base, candidate]),
    /Binary files/,
  );
  const patch = Buffer.from(
    await integration.diff(base, candidate, { path: "README.md" }),
  ).toString();
  assert.match(patch, /^-readme 3\n\+review this change$/m);
});

test("diff refuses unsafe tree entries, extra parents and empty candidates", async (t) => {
  const { integration, repository, c1, c3 } = await fixture(t);
  const commitWith = (path: string, entry: string, parents = [c3]) => {
    const index = join(repository, `idx-${path.replace(/\W/g, "")}`);
    const env = { GIT_INDEX_FILE: index };
    git(repository, ["read-tree", c3], "", env);
    git(repository, ["update-index", "--add", "--cacheinfo", entry], "", env);
    const tree = git(repository, ["write-tree"], "", env);
    return git(repository, [
      "commit-tree",
      tree,
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      "x",
    ]);
  };
  const blob = git(repository, ["hash-object", "-w", "--stdin"], "z");
  const gitlink = commitWith("sub", `160000,${c1},sub`);
  const typeChange = commitWith("run.sh", `120000,${blob},run.sh`);
  const absolute = git(
    repository,
    ["hash-object", "-w", "--stdin"],
    "/README.md",
  );
  const unsafeSymlink = commitWith("new-link", `120000,${absolute},new-link`);
  const collision = commitWith("SRC/n", `100644,${blob},SRC/n`);
  const merge = commitWith("n", `100644,${blob},n`, [c3, c1]);
  for (const bad of [gitlink, typeChange, unsafeSymlink, collision, merge, c3])
    await assert.rejects(integration.diff(c3, bad), /invalid-candidate/);
});
