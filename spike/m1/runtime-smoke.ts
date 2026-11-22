import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import type { SandboxHandle } from "../../src/sandbox-runtime.ts";

const binary = process.argv[2];
const home = process.env.MSB_HOME;
assert.ok(binary && binary.startsWith("/"), "Pass the absolute msb executable");
assert.ok(home && home.startsWith("/"), "Set an absolute, dedicated MSB_HOME");
const extended = process.argv[3] === "--extended";

async function settlePair<T>(first: Promise<T>, second: Promise<T>) {
  const [left, right] = await Promise.allSettled([first, second]);
  if (left.status === "rejected") throw left.reason;
  if (right.status === "rejected") throw right.reason;
  return [left.value, right.value] as const;
}

async function extendedSmoke(
  runtime: MicrosandboxRuntime,
  runMsb: (args: string[]) => Promise<{ stdout: string }>,
): Promise<void> {
  const handles: SandboxHandle[] = [];
  const create = async (fixture: string) => {
    const handle = await runtime.create({
      files: [{ path: "input.txt", bytes: new TextEncoder().encode(fixture) }],
    });
    handles.push(handle);
    return handle;
  };
  async function assertListed(expected: boolean, ...guests: SandboxHandle[]) {
    const { stdout } = await runMsb(["list", "--format", "json"]);
    const active = JSON.parse(stdout) as { name: string }[];
    for (const handle of guests) {
      assert.equal(
        active.some(({ name }) => name === handle.id),
        expected,
      );
    }
  }

  try {
    const [first, second] = await settlePair(create("first"), create("second"));
    await assertListed(true, first, second);
    const [changed, isolated] = await settlePair(
      runtime.exec(first, {
        argv: [
          "/bin/sh",
          "-ec",
          'test "$(cat input.txt)" = first; printf changed > input.txt; printf fixture > /root/fixture-auth-state',
        ],
        timeoutMs: 5_000,
      }),
      runtime.exec(second, {
        argv: ["/bin/sh", "-ec", 'test "$(cat input.txt)" = second'],
        timeoutMs: 5_000,
      }),
    );
    assert.equal(changed.exitCode, 0);
    assert.equal(isolated.exitCode, 0);
    const separated = await runtime.exec(second, {
      argv: [
        "/bin/sh",
        "-ec",
        'test "$(cat input.txt)" = second; test ! -e /root/fixture-auth-state',
      ],
      timeoutMs: 5_000,
    });
    assert.equal(separated.exitCode, 0);

    const timedOut = await runtime.exec(first, {
      argv: ["/bin/sh", "-ec", "sleep 30"],
      timeoutMs: 500,
    });
    assert.equal(timedOut.status, "timed-out");
    await assertListed(false, first);

    const controller = new AbortController();
    const pending = runtime.exec(second, {
      argv: ["/bin/sh", "-ec", "touch /workspace/started; sleep 30"],
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    try {
      // The harness observes the start via its trusted CLI. The adapter rejects
      // concurrent operations on this handle while the command is active.
      const deadline = performance.now() + 3_000;
      for (;;) {
        const { stdout } = await runMsb([
          "exec",
          "--no-stdin",
          "--no-tty",
          "--timeout",
          "1s",
          second.id,
          "--",
          "/bin/sh",
          "-c",
          "if test -f /workspace/started; then echo started; fi",
        ]);
        if (stdout.trim() === "started") break;
        assert.ok(performance.now() < deadline, "Guest command did not start");
        await delay(30);
      }
    } finally {
      controller.abort();
      assert.equal((await pending).status, "cancelled");
    }
    await assertListed(false, second);
    console.log(
      "Two live VM workspaces were isolated; timeout and active cancellation removed their VMs.",
    );
  } finally {
    const results = await Promise.allSettled(
      handles.map((handle) => runtime.destroy(handle)),
    );
    assert.ok(
      results.every((result) => result.status === "fulfilled"),
      "VM cleanup failed",
    );
  }
}

const fixtureRoot = resolve(".local", "runtime-smoke");
await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
const stagingRoot = await mkdtemp(join(fixtureRoot, "run-"));
try {
  const canary = join(stagingRoot, "host-only-canary");
  await writeFile(canary, "host-only fixture", { mode: 0o600 });
  const runtime = new MicrosandboxRuntime({
    binary,
    home,
    stagingRoot,
    image:
      "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd",
  });
  const worker = await runtime.create({
    files: [{ path: "input.txt", bytes: new TextEncoder().encode("fixture") }],
  });
  try {
    const result = await runtime.exec(worker, {
      argv: [
        "/bin/sh",
        "-ec",
        'test ! -e "$1"; test "$PWD" = /workspace; cat input.txt > output.txt; printf " checked" >> output.txt',
        "smoke",
        canary,
      ],
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    const { files } = await runtime.collect(worker, { paths: ["output.txt"] });
    assert.equal(files.length, 1);
    assert.equal(new TextDecoder().decode(files[0]?.bytes), "fixture checked");
  } finally {
    await runtime.destroy(worker);
  }
  console.log("Microsandbox create, exec, collect, and destroy passed.");
  if (extended) {
    const exec = promisify(execFile);
    await extendedSmoke(runtime, (args) =>
      exec(binary, args, {
        env: { PATH: "/usr/bin:/bin", MSB_HOME: home, MSB_BACKEND: "local" },
        cwd: home,
        timeout: 2_000,
        killSignal: "SIGKILL",
      }),
    );
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
