import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  executableIdentity,
  HOST_CHECK_PATH,
} from "../src/local-orchestrator/host-checks.ts";
import {
  hostCheckHash,
  LocalHostCheckRunner,
} from "../src/local-orchestrator/host-check-run.ts";
import { writeWorkspaceTar, type TarEntryView } from "../src/oci-image.ts";

const bytes = (value: string) => Buffer.from(value);
const entry = (
  path: string,
  type: TarEntryView["type"],
  data = "",
  linkname = "",
) => ({
  path,
  type,
  data: bytes(data),
  linkname,
  mode: type === "directory" ? 0o755 : 0o644,
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "host-check-process-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    executable: await executableIdentity("/bin/sh", false),
    check: {
      name: "test",
      argv: ["/bin/sh", "-c", "exit 0"] as const,
      timeoutMs: 400,
      vmCount: 0,
    },
    pack: (path: string) =>
      writeFile(
        path,
        writeWorkspaceTar([entry("pinned.txt", "file", "pinned")]),
      ),
    archiveDigest: null,
    archive: async () => null,
  };
  return { root, input };
}

test("the runner uses a clean environment, masks encodings, hashes raw streams and cleans up", async (t) => {
  const { root, input } = await fixture(t);
  const secret = "fake:key?123";
  const encoded = [
    secret,
    bytes(secret).toString("base64"),
    bytes(secret).toString("hex"),
  ];
  const options = {
    tempRoot: root,
    excludedRoots: [],
    readKeychain: async (service: string) => {
      assert.equal(service, "fixture");
      return bytes(secret);
    },
  };
  const expectedOut = `pinned|${HOST_CHECK_PATH}|ok|${encoded.join("|")}`;
  const outcome = await new LocalHostCheckRunner(options).run({
    ...input,
    check: {
      ...input.check,
      keychain: [{ env: "FIXTURE_KEY", service: "fixture" }],
      env: { FEATURE: "ok" },
      argv: [
        "/bin/sh",
        "-c",
        'test -d "$HOME" && test -d "$TMPDIR" && test -z "$USER" || exit 6\n' +
          'printf "%s|%s|%s|%s|%s|%s" "$(cat pinned.txt)" "$PATH" "$FEATURE" "$FIXTURE_KEY" "$1" "$2"\n' +
          'printf "stderr" >&2\nexit 7',
        "fixture",
        encoded[1]!,
        encoded[2]!,
      ],
    },
  });
  assert.equal(outcome.exitStatus, 7);
  assert.equal(outcome.stdoutDigest, hostCheckHash(expectedOut));
  assert.equal(outcome.stderrDigest, hostCheckHash("stderr"));
  assert.match(outcome.tail, /pinned.*\[REDACTED\]/);
  assert.match(outcome.tail, /stderr/);
  for (const value of encoded) assert.ok(!outcome.tail.includes(value));
  assert.deepEqual(await readdir(root), []);
});

test("redaction retains each stream's lookbehind across a burst from the other stream", async (t) => {
  const { root, input } = await fixture(t);
  const result = await new LocalHostCheckRunner({
    tempRoot: root,
    excludedRoots: [],
    readKeychain: async () => bytes("fixturePrefix/fakeSuffix"),
  }).run({
    ...input,
    check: {
      ...input.check,
      keychain: [{ service: "fixture", env: "FIXTURE_KEY" }],
      argv: [
        "/bin/sh",
        "-c",
        'printf "%s/" "${FIXTURE_KEY%/*}"; sleep 0.05; printf "%40000s" " " >&2; sleep 0.05; printf "%s" "${FIXTURE_KEY#*/}"',
      ],
    },
  });
  assert.equal(result.exitStatus, 0);
  assert.ok(result.tail.endsWith("[REDACTED]"));
  assert.ok(!result.tail.includes("fakeSuffix"));
  assert.equal(Buffer.byteLength(result.tail), 16 * 1024);
});

test("redaction masks embedded and wrapped base64 and wrapped hex", async (t) => {
  const { root, input } = await fixture(t);
  const secret = "fixture-token+/".repeat(14);
  const wrap = (value: string) => value.match(/.{1,76}/g)!.join("\r\n");
  const redactions = [
    bytes("user:" + secret).toString("base64"),
    bytes(JSON.stringify({ token: secret })).toString("base64"),
    wrap(bytes(secret).toString("base64")),
    wrap(bytes(secret).toString("hex").toUpperCase()),
  ];
  const output = redactions.map((value, index) => `line ${index}: ${value}`);
  const result = await new LocalHostCheckRunner({
    tempRoot: root,
    excludedRoots: [],
    readKeychain: async () => bytes(secret),
  }).run({
    ...input,
    check: {
      ...input.check,
      keychain: [{ service: "fixture", env: "FIXTURE_KEY" }],
      argv: [
        "/bin/sh",
        "-c",
        'printf "%s\\n" "$@"',
        "fixture",
        "Authorization: Basic " + output[0]!.slice("line 0: ".length),
        ...output.slice(1),
      ],
    },
  });
  assert.equal(result.exitStatus, 0);
  assert.match(result.tail, /Authorization: Basic .{0,12}\[REDACTED\]/);
  for (const index of [1, 2, 3])
    assert.match(
      result.tail,
      new RegExp(`line ${index}: .{0,16}\\[REDACTED\\]`),
    );
  for (const encoded of redactions)
    for (const line of encoded.split("\r\n"))
      assert.ok(!result.tail.includes(line));
});

test("a check keeps the declared argv0 when it executes the resolved file", async (t) => {
  const { root, input } = await fixture(t);
  const alias = join(root, "multicall-name");
  await symlink("/bin/sh", alias);
  const result = await new LocalHostCheckRunner({
    tempRoot: root,
    excludedRoots: [],
  }).run({
    ...input,
    check: { ...input.check, argv: [alias, "-c", 'printf "%s" "$0"'] },
  });
  assert.equal(result.exitStatus, 0);
  assert.equal(result.tail, alias);
});

test("a non-executable interpreter fails at spawn without waiting for the timeout", async (t) => {
  const { root, input } = await fixture(t);
  const interpreter = join(root, "no-exec");
  const executable = join(root, "check");
  await writeFile(interpreter, "#!/bin/sh\n", { mode: 0o600 });
  await writeFile(executable, `#!${interpreter}\n`, { mode: 0o700 });
  const result = await new LocalHostCheckRunner({
    tempRoot: root,
    excludedRoots: [],
  }).run({
    ...input,
    executable: await executableIdentity(executable),
    check: { ...input.check, argv: [executable], timeoutMs: 30_000 },
  });
  assert.equal(result.failure, "spawn");
  assert.equal(result.timedOut, false);
  assert.equal(result.exitStatus, null);
  assert.ok(result.durationMs < 2_000);
});

test("a successful check kills its background process group", async (t) => {
  const { root, input } = await fixture(t);
  const pidFile = join(root, "group.pid");
  const result = await new LocalHostCheckRunner({
    tempRoot: root,
    excludedRoots: [],
  }).run({
    ...input,
    check: {
      ...input.check,
      argv: [
        "/bin/sh",
        "-c",
        'sleep 30 & printf "%s" "$$" >"$1"; exit 0',
        "fixture",
        pidFile,
      ],
      timeoutMs: 2_000,
    },
  });
  const group = -Number(await readFile(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(group, "SIGKILL");
    } catch {}
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitStatus, 0);
  // The OS can retain a killed descendant briefly while its parent reaps it.
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(group, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await delay(10);
  }
  assert.fail("process group survived a successful check");
});

test("a timeout escalates against the process group even if the child ignores TERM", async (t) => {
  const { root, input } = await fixture(t);
  const pidFile = join(root, "child.pid");
  const result = await new LocalHostCheckRunner({
    tempRoot: root,
    excludedRoots: [],
  }).run({
    ...input,
    check: {
      ...input.check,
      argv: [
        "/bin/sh",
        "-c",
        'trap "" TERM; sleep 30 & child=$!; printf "%s" "$child" >"$1"; wait "$child"',
        "fixture",
        pidFile,
      ],
      timeoutMs: 250,
    },
  });
  const child = Number(await readFile(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(child, "SIGKILL");
    } catch {}
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitStatus, null);
  assert.ok(result.durationMs < 2000);
  // A concurrently killed descendant can briefly be a zombie until reaped.
  const { execFileSync } = await import("node:child_process");
  let status = "";
  try {
    process.kill(child, 0);
    status = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(child)], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ESRCH" &&
      (error as { status?: number }).status !== 1
    )
      throw error;
  }
  assert.match(status, /^(?:Z.*)?$/);
});

test("a missing Keychain item and an executable swap both fail before spawn", async (t) => {
  const { root, input } = await fixture(t);
  const executable = join(root, "check");
  const spawned = join(root, "spawned");
  await writeFile(executable, '#!/bin/sh\ntouch "$1"\n', { mode: 0o700 });
  const check = {
    ...input.check,
    argv: [executable, spawned] as const,
    keychain: [{ env: "FIXTURE_KEY", service: "fixture" }],
  };
  const pinned = await executableIdentity(executable);
  const options = { tempRoot: root, excludedRoots: [] };
  const missing = await new LocalHostCheckRunner({
    ...options,
    readKeychain: async () => undefined,
  }).run({
    ...input,
    executable: pinned,
    check,
  });
  assert.equal(missing.failure, "keychain");

  const swapped = await new LocalHostCheckRunner({
    ...options,
    readKeychain: async () => {
      await writeFile(executable, '#!/bin/sh\ntouch "$1"\n# replacement\n');
      return bytes("fixture");
    },
  }).run({ ...input, executable: pinned, check });
  assert.equal(swapped.failure, "executable-changed");
  await assert.rejects(lstat(spawned), { code: "ENOENT" });
});

for (const kind of [
  "symlinked output",
  "escaping link",
  "escaping path",
  "changed archive",
  "safe archive",
] as const) {
  test(`environment unpack handles ${kind}`, async (t) => {
    const { root, input } = await fixture(t);
    const runner = new LocalHostCheckRunner({
      tempRoot: root,
      excludedRoots: [],
    });
    const archive = writeWorkspaceTar([
      entry("node_modules", "directory"),
      kind === "escaping link"
        ? entry("node_modules/package", "symlink", "", "../../outside")
        : kind === "escaping path"
          ? entry("../outside", "file", "outside")
          : entry("node_modules/package", "file", "cached"),
    ]);
    const result = await runner.run({
      ...input,
      check: {
        ...input.check,
        argv: ["/bin/sh", "-c", "cat node_modules/package"],
      },
      ...(kind === "symlinked output" && {
        pack: (path: string) =>
          writeFile(
            path,
            writeWorkspaceTar([
              entry("node_modules", "symlink", "", "source"),
              entry("source/file", "file"),
            ]),
          ),
      }),
      archiveDigest:
        kind === "changed archive" ? "0".repeat(64) : hostCheckHash(archive),
      archive: async () => ({
        bytes: archive,
        outputs: ["node_modules"],
        linkTargets: [],
      }),
    });
    if (kind === "safe archive") assert.equal(result.tail, "cached");
    else
      assert.equal(
        result.failure,
        kind === "changed archive" ? "archive-changed" : "setup",
      );
    assert.deepEqual(await readdir(root), []);
  });
}
