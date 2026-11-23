import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSocketPath,
  bounded,
  createArgs,
  jobId,
  parseCli,
  profileForCheck,
  Resources,
  secretObservation,
  ttyOutcome,
  ttySize,
  vsockOutcome,
  type CommandResult,
} from "../spike/local-orchestrator/front-poc.ts";
import {
  lockEntry,
  parseProfileLock,
  profileCatalog,
} from "../src/profile-lock.ts";

const image = "localhost/fixture@sha256:" + "a".repeat(64);
const success: CommandResult = {
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
};
const failure: CommandResult = {
  ...success,
  code: 1,
  stderr: "fixture rejected command",
};

test("the plan is the default and subsets retain the serial check order", () => {
  assert.equal(parseCli([]).run, false);
  assert.deepEqual(parseCli(["--only", "tty,vsock,tty", "--run"]), {
    run: true,
    selected: ["vsock", "tty"],
  });
  assert.throws(() => parseCli(["--only", "unknown"]), /Invalid --only/);
  assert.throws(() => parseCli(["--only"]), /Invalid --only/);
  assert.throws(() => parseCli(["--typo"]), /Usage/);
});

test("only the vsock check selects concierge when the image is locked", () => {
  const baseOnly = profileCatalog(image);
  const entry = lockEntry("concierge", "b".repeat(64));
  const lock = parseProfileLock(
    JSON.stringify({ version: 1, profiles: { concierge: entry } }),
  );
  const catalog = profileCatalog(image, lock);
  const check = profileForCheck("vsock", catalog);
  assert.equal(profileForCheck("vsock", baseOnly), "base");
  assert.equal(check, "concierge");
  assert.deepEqual(catalog.get(check), {
    image: entry.image,
    memoryMiB: 1024,
    cpus: 2,
  });
  for (const name of parseCli([]).selected.filter((name) => name !== "vsock"))
    assert.equal(profileForCheck(name, catalog), "base");
});

test("create uses the pinned image, no pulls, no network rules and profile resources", () => {
  assert.deepEqual(
    createArgs("fpoc-aabbccdd", { image, memoryMiB: 512, cpus: 2 }, [
      "--vsock",
      "/private/tmp/h.sock:5000",
    ]),
    [
      "create",
      "--name",
      "fpoc-aabbccdd",
      "--label",
      "front-poc=fpoc-aabbccdd",
      "--pull",
      "never",
      "--no-net",
      "--max-duration",
      "5m",
      "--memory",
      "512M",
      "--cpus",
      "2",
      "--vsock",
      "/private/tmp/h.sock:5000",
      image,
    ],
  );
});

test("socket paths and outputs are limited in bytes", () => {
  assert.doesNotThrow(() => assertSocketPath("x".repeat(99)));
  assert.throws(() => assertSocketPath("é".repeat(50)), /under 100 bytes/);
  const line = bounded("x" + "é".repeat(1500));
  assert.equal(Buffer.byteLength(line), 2047);
  assert.equal(line.endsWith("é"), true);
});

test("vsock requires a complete ack line, success and exactly one connection", () => {
  assert.equal(vsockOutcome("warning\r\nack:ping\r\n", 1, true, true), "pass");
  assert.equal(vsockOutcome("not ack:ping\n", 1, true, true), "fail");
  assert.equal(vsockOutcome("ack:ping\n", 2, true, true), "fail");
  assert.equal(vsockOutcome("ack:ping\n", 1, true, false), "fail");
  assert.equal(vsockOutcome("", 0, false, true), "blocked");
});

test("job ID parsing rejects extra tokens and option-like values", () => {
  assert.equal(
    jobId("83a4c8b9-0df7-4ea4-a6d6-b4efb85233f3\n"),
    "83a4c8b9-0df7-4ea4-a6d6-b4efb85233f3",
  );
  assert.equal(jobId("Job ID: job_42\r\n"), "job_42");
  assert.equal(jobId("job_42\njob_43\n"), undefined);
  assert.equal(jobId("--bad"), undefined);
  assert.equal(jobId("unknown output"), undefined);
});

test("TTY outcome requires initial size and Ctrl-C exit within three seconds", () => {
  assert.equal(ttyOutcome("ctrl-c-exit-ms=3000\n40 120\r\n^C"), "pass");
  assert.equal(ttyOutcome("ctrl-c-exit-ms=3001\n40 120\r\n"), "fail");
  assert.equal(ttyOutcome("ctrl-c-exit-ms=none\n40 120\r\n"), "fail");
  assert.equal(ttyOutcome("ctrl-c-exit-ms=30\n50 100\r\n"), "fail");
  assert.equal(ttySize("40 120\r\n 50\t100 \r\n", 50, 100), true);
  assert.equal(ttySize("150 100\r\n", 50, 100), false);
});

test("secret output accepts only unset or a hash", () => {
  assert.equal(secretObservation("unset\n"), "unset");
  const hash = "a".repeat(64);
  assert.equal(secretObservation(`set ${hash}\n`), hash);
  assert.equal(secretObservation("raw fixture value"), undefined);
  assert.equal(secretObservation(`set ${hash}\nextra output`), undefined);
});

test("named volume stays until the second VM is stopped and removed", async () => {
  const calls: string[][] = [];
  const ids = ["12345678", "aabbccdd", "11223344"];
  const resources = new Resources(
    async (args) => {
      calls.push(args);
      return success;
    },
    { image },
    [],
    () => ids.shift()!,
  );
  try {
    const volume = await resources.createVolume();
    assert.equal(volume, "fpoc-vol-12345678");
    const mount = ["--mount-named", `${volume}:/state`];
    await resources.create(mount);
    await assert.rejects(resources.create(mount), /previous VM/);
    assert.equal(await resources.removeVM(), true);
    await resources.create(mount);
  } finally {
    assert.equal(await resources.cleanup(), true);
  }
  assert.deepEqual(calls, [
    ["volume", "create", "fpoc-vol-12345678"],
    createArgs("fpoc-aabbccdd", { image }, [
      "--mount-named",
      "fpoc-vol-12345678:/state",
    ]),
    ["stop", "fpoc-aabbccdd"],
    ["rm", "--force", "--label", "front-poc=fpoc-aabbccdd"],
    createArgs("fpoc-11223344", { image }, [
      "--mount-named",
      "fpoc-vol-12345678:/state",
    ]),
    ["stop", "fpoc-11223344"],
    ["rm", "--force", "--label", "front-poc=fpoc-11223344"],
    ["volume", "remove", "fpoc-vol-12345678"],
  ]);
});

test("cleanup removes an ambiguous create by label, then removes its volume", async () => {
  const calls: string[][] = [];
  const evidence: string[] = [];
  const resources = new Resources(
    async (args) => {
      calls.push(args);
      if (args[0] === "create")
        return { ...failure, code: null, timedOut: true };
      if (args[1] === "remove") return failure;
      return success;
    },
    { image },
    evidence,
    () => "aabbccdd",
  );
  try {
    await resources.createVolume();
    await assert.rejects(resources.create(), /blocked/);
  } finally {
    assert.equal(await resources.cleanup(), false);
  }
  assert.deepEqual(calls.slice(2), [
    ["rm", "--force", "--label", "front-poc=fpoc-aabbccdd"],
    ["volume", "remove", "fpoc-vol-aabbccdd"],
  ]);
  assert.match(
    evidence.join("\n"),
    /cleanup volume remove fpoc-vol-aabbccdd stderr/,
  );
});

test("a stop failure still attempts forced removal and volume cleanup", async () => {
  const calls: string[][] = [];
  const evidence: string[] = [];
  const resources = new Resources(
    async (args) => {
      calls.push(args);
      return args[0] === "stop" ? failure : success;
    },
    { image },
    evidence,
    () => "aabbccdd",
  );
  await resources.createVolume();
  await resources.create();
  assert.equal(await resources.cleanup(), false);
  assert.deepEqual(
    calls.map(([command, subcommand]) => [command, subcommand]),
    [
      ["volume", "create"],
      ["create", "--name"],
      ["stop", "fpoc-aabbccdd"],
      ["rm", "--force"],
      ["volume", "remove"],
    ],
  );
  assert.match(evidence.join("\n"), /cleanup stop fpoc-aabbccdd stderr/);
});
