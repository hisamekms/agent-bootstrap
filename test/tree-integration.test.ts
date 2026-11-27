import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SqliteAudit } from "../src/audit.ts";
import type { EgressPolicy } from "../src/egress-policy.ts";
import { LocalGitIntegration } from "../src/git-integration.ts";
import { IntegrationJournal } from "../src/integration-journal.ts";
import {
  ReviewedIntegration,
  workerCommitMessage,
} from "../src/reviewed-integration.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import type { SandboxRuntime, SandboxSpec } from "../src/sandbox-runtime.ts";
import { TrustedHost } from "../src/trusted-host.ts";
import { fakeGateway } from "./fake-gateway.ts";

const profiles = new ProfileCatalog({
  base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
});

function git(dir: string, args: string[], input = "", env = {}): string {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: dir,
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
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function seed(repository: string) {
  git(repository, ["init", "--bare", "--template=", "--initial-branch=main"]);
  const blob = (text: string) =>
    git(repository, ["hash-object", "-w", "--stdin"], text);
  const index = join(repository, "seed-index");
  const entries: [string, string, string][] = [
    ["100644", "README.md", "readme\n"],
    ["100755", "run.sh", "#!/bin/sh\n"],
    ["120000", "link", "README.md"],
    ["100644", "src/a.ts", "a\n"],
    ["100644", "src/lib/x.ts", "x\n"],
    ["100644", "docs/d.md", "doc\n"],
  ];
  for (const [mode, path, text] of entries)
    git(
      repository,
      ["update-index", "--add", "--cacheinfo", `${mode},${blob(text)},${path}`],
      "",
      { GIT_INDEX_FILE: index },
    );
  const tree = git(repository, ["write-tree"], "", { GIT_INDEX_FILE: index });
  const commit = git(repository, ["commit-tree", tree, "-m", "base"]);
  git(repository, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

// --- a tiny tar writer and extractor for the fake sandbox ---

function header(
  name: string,
  type: string,
  mode: number,
  size: number,
  linkname = "",
) {
  const block = Buffer.alloc(512);
  block.write(name, 0, "utf8");
  block.write(mode.toString(8).padStart(7, "0"), 100);
  block.write("0000000", 108);
  block.write("0000000", 116);
  block.write(size.toString(8).padStart(11, "0"), 124);
  block.write("00000000000", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write(linkname, 157);
  block.write("ustar\0" + "00", 257, "latin1");
  const sum = block.reduce((a, b) => a + b, 0);
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

async function tarOf(root: string): Promise<Buffer> {
  const out: Buffer[] = [];
  const walk = async (rel: string) => {
    for (const name of (await readdir(join(root, rel))).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        out.push(header(`${path}/`, "5", 0o755, 0));
        await walk(path);
      } else if (info.isSymbolicLink()) {
        out.push(header(path, "2", 0o777, 0, await readlink(join(root, path))));
      } else {
        const bytes = await readFile(join(root, path));
        out.push(header(path, "0", info.mode & 0o777, bytes.length), bytes);
        out.push(Buffer.alloc((512 - (bytes.length % 512)) % 512));
      }
    }
  };
  await walk("");
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

/** Lenient reader: the host's workspace tar need not list parent directories. */
async function extract(tarPath: string, dest: string) {
  const bytes = await readFile(tarPath);
  let offset = 0;
  let pax: Record<string, string> = {};
  while (offset + 512 <= bytes.length && bytes[offset] !== 0) {
    const head = bytes.subarray(offset, offset + 512);
    const text = (from: number, to: number) =>
      head.subarray(from, to).toString("utf8").replace(/\0.*$/s, "");
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
    const name = (pax.path ?? text(0, 100)).replace(/\/$/, "");
    const link = pax.linkpath ?? text(157, 257);
    pax = {};
    const path = join(dest, name);
    if (type === "5") await mkdir(path, { recursive: true });
    else if (type === "2") {
      await mkdir(dirname(path), { recursive: true });
      await symlink(link, path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await chmod(path, Number.parseInt(text(100, 108), 8) & 0o777);
    }
  }
}

type Edit = (dir: string) => Promise<void>;

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  tree: object,
  reviews: string[] = ['{"review":"pass"}'],
  message?: Uint8Array,
  workerHostServices?: readonly {
    ip: string;
    port: number;
    loopbackPort: number;
  }[],
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "bootstrap-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo.git");
  const journalDir = join(root, "events");
  const stagingRoot = join(root, "staging");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(journalDir, { mode: 0o700 });
  const base = seed(repository);
  const integration = new LocalGitIntegration({
    binary: "/usr/bin/git",
    repository,
    stagingRoot,
    branch: "main",
  });
  const audit = new SqliteAudit(join(root, "audit.sqlite"));
  t.after(async () => audit.close());
  const edits: Edit[] = [];
  const specs: SandboxSpec[] = [];
  const seen: Record<string, string[]>[] = [];
  const extracted = new Map<string, string>();
  const policies: EgressPolicy[] = [];
  let workerOutcome = 0;
  const digest = "a".repeat(64);
  const create = async (spec: SandboxSpec, id: string = randomUUID()) => {
    specs.push(spec);
    if (spec.repository) {
      const dir = join(root, `vm-${id}`);
      await mkdir(dir);
      await extract(spec.repository.tree, dir);
      extracted.set(id, dir);
      // The git directory is a host-prepared object store with a base ref.
      assert.ok((await lstat(spec.repository.gitDir)).isDirectory());
    }
    return { id };
  };
  const runtime: SandboxRuntime = {
    create: (spec) => create(spec),
    async createBound(spec, id) {
      return { ...(await create(spec, id)), netRuleDigest: digest };
    },
    netRuleDigest: () => digest,
    async exec(handle, command) {
      const entry = command.argv[0];
      const dir = extracted.get(handle.id);
      if (entry === "worker") {
        const edit = edits.shift();
        assert.ok(dir && edit);
        const files: Record<string, string[]> = {};
        seen.push(files);
        files.before = await listing(dir);
        await edit(dir);
        return {
          status: "exited" as const,
          exitCode: workerOutcome,
          stdout: Buffer.from('{"tool":"collect"}'),
          stderr: new Uint8Array(),
        };
      }
      const text = entry === "reviewer" ? reviews.shift() : '{"review":"pass"}';
      return {
        status: "exited" as const,
        exitCode: 0,
        stdout: Buffer.from(text ?? '{"review":"pass"}'),
        stderr: new Uint8Array(),
      };
    },
    async collect(handle) {
      const dir = extracted.get(handle.id);
      assert.ok(dir);
      return {
        files: [],
        tree: await tarOf(dir),
        ...(message ? { message } : {}),
      };
    },
    async destroy() {},
  };
  const journal = new IntegrationJournal(journalDir, randomUUID());
  const flow = new ReviewedIntegration(
    integration,
    new TrustedHost(
      audit,
      runtime,
      profiles,
      workerHostServices
        ? {
            config: {
              audit: { mode: "required" },
              telemetry: {
                enabled: false,
                resourceSamplingIntervalMs: 1000,
                traceSamplingRatio: 1,
              },
            },
            async gatewayFactory(options) {
              policies.push(options.policy);
              return fakeGateway([]).open(options);
            },
          }
        : undefined,
    ),
    journal,
    {
      tree,
      worker: { argv: ["worker"], timeoutMs: 123 },
      reviewer: { argv: ["reviewer"], timeoutMs: 123 },
      ...(workerHostServices ? { workerHostServices } : {}),
      verification: {
        command: { argv: ["verify"], timeoutMs: 123 },
        suite: [{ path: "t.test.ts", bytes: Buffer.from("test") }],
      },
    },
  );
  const leftovers = async () =>
    (await readdir(stagingRoot).catch(() => [])).length;
  return {
    flow,
    integration,
    repository,
    base,
    journal,
    edits,
    specs,
    policies,
    seen,
    leftovers,
    fail: () => (workerOutcome = 1),
  };
}

async function listing(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    if ((await lstat(join(dir, path))).isDirectory())
      out.push(...(await listing(dir, path)));
    else out.push(path);
  }
  return out;
}

const show = (repository: string, rev: string, path: string) =>
  git(repository, [`--git-dir=${repository}`, "show", `${rev}:${path}`]);
const tree = (repository: string, rev: string) =>
  git(repository, [
    `--git-dir=${repository}`,
    "ls-tree",
    "-r",
    "--name-only",
    rev,
  ]).split("\n");

test("a multi-file candidate (add, modify, delete, mode change) is reviewed, verified and integrated", async (t) => {
  const service = { ip: "192.0.2.20", port: 8080, loopbackPort: 8081 };
  const f = await fixture(
    t,
    { protectedPaths: ["run.sh", "docs/"] },
    undefined,
    undefined,
    [service],
  );
  f.edits.push(async (dir) => {
    await writeFile(join(dir, "README.md"), "readme 2\n");
    await mkdir(join(dir, "src/new/deep"), { recursive: true });
    await writeFile(join(dir, "src/new/deep/n.ts"), "n\n");
    await rm(join(dir, "src/a.ts"));
    await chmod(join(dir, "run.sh"), 0o644);
  });
  const pin = await f.flow.prepare();
  assert.equal(pin.review, "pass");
  const diff = Buffer.from(await f.integration.diff(pin.base, pin.candidate));
  assert.match(diff.toString(), /\+readme 2/);
  assert.match(
    diff.toString(),
    /new file mode 100644[^]*src\/new\/deep\/n\.ts/,
  );
  assert.match(diff.toString(), /deleted file mode 100644[^]*src\/a\.ts/);
  assert.match(diff.toString(), /old mode 100755\nnew mode 100644/);
  assert.equal(
    git(f.repository, [
      `--git-dir=${f.repository}`,
      "rev-parse",
      `${pin.candidate}^`,
    ]),
    f.base,
  );
  assert.deepEqual(tree(f.repository, pin.candidate), [
    "README.md",
    "docs/d.md",
    "link",
    "run.sh",
    "src/lib/x.ts",
    "src/new/deep/n.ts",
  ]);
  const created = (await f.journal.read()).find(
    (event) => event.kind === "candidate.created",
  );
  // run.sh is protected; docs/ is untouched.
  assert.equal(created?.protectedCount, 1);
  // Worker got the repository and no loose files; Reviewer got the diff and message.
  assert.ok(f.specs[0]?.repository);
  assert.equal(f.specs[0]?.files, undefined);
  assert.deepEqual(
    f.specs[0]?.readOnlyFiles?.map((file) => file.path),
    ["suite/t.test.ts"],
  );
  assert.deepEqual(
    f.specs[1]?.readOnlyFiles?.map((file) => file.path),
    ["candidate.diff", "candidate.message"],
  );
  await f.flow.decide(pin, "approve", { acknowledgeProtected: ["run.sh"] });
  assert.equal(await f.flow.integrate(), "completed");
  assert.equal(await f.integration.head(), pin.candidate);
  // Verification got the whole candidate tree plus diff and suite.
  const verify = f.specs[2];
  assert.ok(verify?.repository);
  assert.ok(f.specs[0]?.egressGateway);
  assert.equal(f.specs[1]?.egressGateway, undefined);
  assert.equal(verify.egressGateway, undefined);
  assert.deepEqual(
    f.policies.map((policy) => policy.hostServices),
    [[service]],
  );
  assert.deepEqual(
    verify.readOnlyFiles?.map((file) => file.path),
    ["candidate.diff", "suite/t.test.ts"],
  );
  assert.equal(await f.leftovers(), 0);
});

test("tree commits and reviews use the same bounded, sanitized Worker message", async (t) => {
  const emoji = "😀";
  const data = Buffer.from(
    ` \n ` +
      emoji.repeat(73) +
      `\n\nAgent-Bootstrap-Worker-Run: forged\naGeNt-\u200bBoOtStRaP-Other: forged\n` +
      `Bo\u202edy\ttext\0\r\u001b\u0085\u2066\u2067\u2068\u2069\u200d\u2028\u2029 ${"界".repeat(1000)}\n`,
  );
  const f = await fixture(t, {}, undefined, data);
  f.edits.push((dir) => writeFile(join(dir, "README.md"), "changed\n"));
  const run = randomUUID();
  const pin = await f.flow.prepareCandidate(run);
  const subjectAndBody = `${emoji.repeat(72)}\n\nBody\ttext `;
  const trailer = `\n\nAgent-Bootstrap-Worker-Run: ${run}\n`;
  const bodyLength = Math.floor(
    (2048 - Buffer.byteLength(subjectAndBody + trailer)) / 3,
  );
  const expected = subjectAndBody + "界".repeat(bodyLength) + trailer;
  const message = await f.flow.candidateMessage(pin);
  assert.deepEqual(Buffer.from(message), Buffer.from(expected));
  assert.equal(
    git(f.repository, ["log", "-1", "--format=%B", pin.candidate]),
    expected.trimEnd(),
  );
  await f.flow.reviewCandidate();
  assert.equal(
    f.specs[1]?.readOnlyFiles
      ?.find((file) => file.path === "candidate.message")
      ?.bytes.toString(),
    expected,
  );
  const events = await f.journal.read();
  const created = events.find((event) => event.kind === "candidate.created");
  assert.equal(
    created?.messageDigest,
    createHash("sha256").update(expected).digest("hex"),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /Body|Agent-Bootstrap-Worker-Run/,
  );
  await assert.rejects(
    f.flow.candidateMessage({ ...pin, digest: "0".repeat(64) }),
    /durable pin/,
  );
});

test("missing, invalid UTF-8, empty and oversized Worker proposals get a host subject", async (t) => {
  // Shapes are checked on the message builder directly; one end-to-end run
  // below shows the collected proposal reaches the candidate commit.
  for (const data of [
    undefined,
    Buffer.from([0xff]),
    Buffer.from(" \t\n\0"),
    Buffer.from("  aGeNt-\u200bBoOtStRaP-Worker-Run: forged"),
  ]) {
    const run = randomUUID();
    assert.equal(
      workerCommitMessage(run, data),
      `Candidate from Worker run ${run}\n\nAgent-Bootstrap-Worker-Run: ${run}\n`,
      String(data?.byteLength),
    );
  }
  // An oversized proposal is dropped before the builder, by the collection
  // size check, so this case goes through the whole flow.
  const f = await fixture(t, {}, undefined, Buffer.alloc(4097, "a"));
  f.edits.push((dir) => writeFile(join(dir, "README.md"), "changed\n"));
  const run = randomUUID();
  const pin = await f.flow.prepareCandidate(run);
  assert.equal(
    Buffer.from(await f.flow.candidateMessage(pin)).toString(),
    `Candidate from Worker run ${run}\n\nAgent-Bootstrap-Worker-Run: ${run}\n`,
  );
});

test("the journal accepts only a lowercase SHA-256 candidate message digest", async (t) => {
  const { journal } = await fixture(t, {});
  const event = {
    kind: "candidate.created" as const,
    candidate: "a".repeat(40),
    digest: "b".repeat(64),
    protectedCount: 1,
  };
  for (const messageDigest of ["d".repeat(63), "D".repeat(64), "message"]) {
    await assert.rejects(
      journal.append(0, { ...event, messageDigest }),
      /Invalid integration event fields/,
    );
  }
  await journal.append(0, { ...event, messageDigest: "d".repeat(64) });
  assert.equal((await journal.read())[0]?.kind, "candidate.created");
});

test("the journal rejects inconsistent missing-environment verification events", async (t) => {
  const { journal } = await fixture(t, {});
  const event = {
    kind: "verification.finished" as const,
    run: randomUUID(),
    digest: "a".repeat(64),
  };
  for (const details of [
    { review: "revise", failure: "env-missing" },
    {
      review: "failed",
      failure: "env-missing",
      tests: { passed: 0, failed: 0 },
    },
    { review: "failed" },
  ] as const) {
    await assert.rejects(
      journal.append(0, { ...event, ...details }),
      /Invalid integration event fields/,
    );
  }
  assert.deepEqual(await journal.read(), []);
});

test("a change outside the scope is denied, and nothing is left behind", async (t) => {
  const f = await fixture(t, { scope: ["SRC/"] });
  f.edits.push(async (dir) => {
    await writeFile(join(dir, "src/a.ts"), "ok\n");
    await writeFile(join(dir, "README.md"), "nope\n");
  });
  await assert.rejects(f.flow.prepareCandidate(), /eligible change/);
  const events = await f.journal.read();
  assert.equal(events.at(-1)?.kind, "denied");
  assert.equal(await f.integration.head(), f.base);
  assert.equal(await f.leftovers(), 0);
});

test("a run with no change, or a failed run, is denied and cleaned up", async (t) => {
  const f = await fixture(t, {});
  f.edits.push(async () => {});
  await assert.rejects(f.flow.prepareCandidate(), /eligible change/);
  assert.equal(await f.leftovers(), 0);
  const g = await fixture(t, {});
  g.fail();
  g.edits.push(async (dir) => writeFile(join(dir, "README.md"), "x\n"));
  await assert.rejects(g.flow.prepareCandidate(), /eligible change/);
  assert.equal(await g.leftovers(), 0);
});

test("sparse scope: files outside it are absent in the VM but are not deletions", async (t) => {
  const f = await fixture(t, { scope: ["src/"] });
  f.edits.push(async (dir) => {
    await writeFile(join(dir, "src/a.ts"), "a2\n");
  });
  const pin = await f.flow.prepareCandidate();
  // Cone mode keeps top-level files; other directories are absent.
  assert.deepEqual(f.seen[0]?.before, [
    "README.md",
    "link",
    "run.sh",
    "src/a.ts",
    "src/lib/x.ts",
  ]);
  assert.deepEqual(tree(f.repository, pin.candidate), [
    "README.md",
    "docs/d.md",
    "link",
    "run.sh",
    "src/a.ts",
    "src/lib/x.ts",
  ]);
  assert.equal(show(f.repository, pin.candidate, "src/a.ts"), "a2");
  assert.equal(await f.leftovers(), 0);
});

test("tree approval requires acknowledgement of the pinned protected paths", async (t) => {
  const f = await fixture(t, { protectedPaths: ["DOCS/", "readme.md"] });
  f.edits.push(async (dir) => {
    await writeFile(join(dir, "docs/d.md"), "d2\n");
    await writeFile(join(dir, "README.md"), "r2\n");
    await writeFile(join(dir, "src/a.ts"), "a2\n");
    await rm(join(dir, "link"));
    await symlink("docs/d.md", join(dir, "link"));
    await symlink("../README.md", join(dir, "src/new-link"));
  });
  const pin = await f.flow.prepareCandidate();
  const paths = ["README.md", "docs/d.md", "link", "src/new-link"];
  assert.deepEqual(await f.flow.protectedPaths(pin), paths);
  await assert.rejects(
    f.flow.protectedPaths({ ...pin, digest: "a".repeat(64) }),
    /durable pin/,
  );
  await f.flow.reviewCandidate();
  const created = (await f.journal.read()).find(
    (event) => event.kind === "candidate.created",
  );
  assert.equal(created?.protectedCount, paths.length);
  const message = /Human decision does not match an eligible review/;
  await assert.rejects(f.flow.decide(pin, "approve"), message);
  await assert.rejects(
    f.flow.decide(pin, "approve", { acknowledgeProtected: paths.slice(1) }),
    message,
  );
  await assert.rejects(
    f.flow.decide(pin, "approve", {
      acknowledgeProtected: [...paths, "src/a.ts"],
    }),
    message,
  );
  assert.equal((await f.journal.read()).at(-1)?.kind, "review.submitted");
  await f.flow.decide(pin, "approve", {
    acknowledgeProtected: [...paths].reverse(),
  });
  assert.equal(await f.flow.integrate(), "completed");
});

test("a protected tree candidate can be rejected without acknowledgement", async (t) => {
  const f = await fixture(t, { protectedPaths: ["README.md"] });
  f.edits.push((dir) => writeFile(join(dir, "README.md"), "changed\n"));
  const pin = await f.flow.prepare();
  await f.flow.decide(pin, "reject");
  assert.equal(await f.flow.integrate(), "denied");
  assert.equal(await f.integration.head(), f.base);
});

test("a pre-existing approval without acknowledgement cannot integrate protected changes", async (t) => {
  const f = await fixture(t, { protectedPaths: ["README.md"] });
  f.edits.push((dir) => writeFile(join(dir, "README.md"), "changed\n"));
  const { review: _, ...pin } = await f.flow.prepare();
  await f.journal.append((await f.journal.read()).length, {
    kind: "human.decided",
    ...pin,
    decision: "approve",
  });
  assert.equal(await f.flow.integrate(), "denied");
  assert.equal(await f.integration.head(), f.base);
});

test("a revision starts from the previous candidate tree and stays relative to base", async (t) => {
  const f = await fixture(t, {}, [
    JSON.stringify({ review: "revise", notes: "please add b" }),
    '{"review":"pass"}',
  ]);
  f.edits.push(async (dir) => writeFile(join(dir, "README.md"), "first\n"));
  const first = await f.flow.prepareCandidate();
  assert.equal((await f.flow.reviewCandidate()).review, "revise");
  f.edits.push(async (dir) => {
    assert.equal(await readFile(join(dir, "README.md"), "utf8"), "first\n");
    await writeFile(join(dir, "b.txt"), "b\n");
  });
  const second = await f.flow.revise();
  assert.equal(second.base, first.base);
  assert.notEqual(second.candidate, first.candidate);
  assert.equal(
    git(f.repository, [
      `--git-dir=${f.repository}`,
      "rev-parse",
      `${second.candidate}^`,
    ]),
    f.base,
  );
  assert.deepEqual(
    tree(f.repository, second.candidate).includes("b.txt"),
    true,
  );
  assert.equal(show(f.repository, second.candidate, "README.md"), "first");
  const notes = f.specs[2]?.readOnlyFiles?.map((file) => file.path);
  assert.deepEqual(notes, ["review-notes.txt", "suite/t.test.ts"]);
  assert.equal((await f.flow.reviewCandidate()).review, "pass");
  await f.flow.decide(second, "approve");
  assert.equal(await f.flow.integrate(), "completed");
  assert.equal(await f.leftovers(), 0);
});

test("plans need exactly one mode and a valid tree", async (t) => {
  const f = await fixture(t, {});
  const base = {
    worker: { argv: ["w"], timeoutMs: 1 },
    reviewer: { argv: ["r"], timeoutMs: 1 },
    verification: { command: { argv: ["v"], timeoutMs: 1 } },
  };
  const make = (extra: object) => () =>
    new ReviewedIntegration(
      f.integration,
      undefined as never,
      undefined as never,
      { ...base, ...extra } as never,
    );
  assert.throws(make({}), /exactly one/);
  assert.throws(make({ path: "a", tree: {} }), /exactly one/);
  assert.throws(make({ tree: { scope: [] } }), /Invalid tree plan/);
  assert.throws(make({ tree: { scope: ["../x"] } }), /Invalid tree plan/);
  assert.throws(
    make({ tree: { protectedPaths: ["/x"] } }),
    /Invalid tree plan/,
  );
  assert.throws(
    make({
      tree: { protectedPaths: Array.from({ length: 101 }, (_, i) => `p${i}`) },
    }),
    /Invalid tree plan/,
  );
  make({
    tree: { scope: ["src/", "README.md"], protectedPaths: ["run.sh"] },
  })();
});
