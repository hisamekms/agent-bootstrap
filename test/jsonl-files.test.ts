import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlFileError, JsonlWriter, scan } from "../src/jsonl-files.ts";

const day = "2026-11-23";
const now = () => new Date(`${day}T00:00:00Z`);
const first = `${day}-0001.jsonl`;
const second = `${day}-0002.jsonl`;
const partial = `${first}.partial`;
let root: string;
let dir: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "jsonl-files-")));
  dir = join(root, "exports");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function expectCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error) => error instanceof JsonlFileError && error.code === code,
  );
}

test("rotates at midnight UTC and publishes after fsync", () => {
  let date = new Date("2026-11-23T08:59:59.999+09:00");
  const events: string[] = [];
  const writer = new JsonlWriter(dir, {
    now: () => date,
    fs: {
      ...fs,
      fsyncSync(fd) {
        fs.fsyncSync(fd);
        events.push("fsync");
      },
      renameSync(from, to) {
        fs.renameSync(from, to);
        events.push("rename");
      },
    },
  });
  writer.write({ sequence: 1 });
  assert.deepEqual(scan(dir), {
    partialFiles: ["2026-11-22-0001.jsonl.partial"],
    truncatedFiles: [],
  });
  date = new Date("2026-11-23T09:00:00.000+09:00");
  writer.write({ sequence: 2 });
  assert.equal(
    fs.readFileSync(join(dir, "2026-11-22-0001.jsonl"), "utf8"),
    '{"sequence":1}\n',
  );
  assert.equal(fs.existsSync(join(dir, partial)), true);
  writer.close();
  writer.close();
  assert.deepEqual(events, ["fsync", "rename", "fsync", "rename"]);
  assert.equal(fs.readFileSync(join(dir, first), "utf8"), '{"sequence":2}\n');
  assert.equal(fs.existsSync(join(dir, "writer.lock")), false);
  expectCode(() => writer.write({}), "closed");
});

test("counts UTF-8 bytes and resumes after existing final and partial files", () => {
  const line = '{"text":"é"}\n';
  const writer = new JsonlWriter(dir, {
    now,
    maxBytes: 2 * Buffer.byteLength(line),
  });
  writer.write({ text: "é" });
  writer.write({ text: "é" });
  assert.equal(fs.existsSync(join(dir, first)), false);
  writer.write({ text: "é" });
  assert.equal(fs.readFileSync(join(dir, first), "utf8"), line.repeat(2));
  writer.close();
  assert.equal(fs.readFileSync(join(dir, second), "utf8"), line);

  const leftover = `${day}-0003.jsonl.partial`;
  fs.writeFileSync(join(dir, leftover), '{"interrupted":');
  const next = new JsonlWriter(dir, { now });
  next.write({ resumed: true });
  next.close();
  assert.equal(
    fs.readFileSync(join(dir, `${day}-0004.jsonl`), "utf8"),
    '{"resumed":true}\n',
  );
  assert.equal(fs.readFileSync(join(dir, leftover), "utf8"), '{"interrupted":');
});

test("rejects invalid and oversized records before opening a data file", () => {
  const writer = new JsonlWriter(dir, { now, maxBytes: 32 });
  const cyclic: { self?: object } = {};
  cyclic.self = cyclic;
  for (const record of [
    [],
    new Date(),
    { toJSON: () => null },
    cyclic,
    { text: "first\nsecond" },
    { "first\rsecond": true },
  ]) {
    expectCode(() => writer.write(record), "invalid-record");
  }
  expectCode(() => writer.write({ text: "a".repeat(32) }), "record-too-large");
  assert.deepEqual(scan(dir), { partialFiles: [], truncatedFiles: [] });
  writer.write({ text: String.raw`first\nsecond` });
  writer.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, first), "utf8")), {
    text: String.raw`first\nsecond`,
  });
});

test("takes an exclusive PID lock and releases it on close", () => {
  const writer = new JsonlWriter(dir, { now });
  assert.equal(
    fs.readFileSync(join(dir, "writer.lock"), "utf8"),
    `${process.pid}\n`,
  );
  expectCode(() => new JsonlWriter(dir, { now }), "writer-locked");
  writer.close();
  new JsonlWriter(dir, { now }).close();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("keeps the partial file and PID lock when a writer exits without closing", () => {
  const modulePath = fileURLToPath(
    new URL("../src/jsonl-files.ts", import.meta.url),
  );
  const script = `
    import { JsonlWriter } from ${JSON.stringify(modulePath)};
    const writer = new JsonlWriter(${JSON.stringify(dir)}, { now: () => new Date(${JSON.stringify(now().toISOString())}) });
    writer.write({ kept: true });
    console.log(process.pid);
  `;
  const pid = execFileSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
  }).trim();
  assert.deepEqual(scan(dir), { partialFiles: [partial], truncatedFiles: [] });
  expectCode(() => new JsonlWriter(dir, { now }), "stale-lock");
  assert.equal(fs.readFileSync(join(dir, "writer.lock"), "utf8"), `${pid}\n`);
  assert.equal(fs.readFileSync(join(dir, partial), "utf8"), '{"kept":true}\n');
});

test("reports ENOSPC and retries in a fresh file", () => {
  let fail = false;
  const writer = new JsonlWriter(dir, {
    now,
    fs: {
      ...fs,
      writeSync(fd, data) {
        if (fail)
          throw Object.assign(new Error("test disk full"), { code: "ENOSPC" });
        return fs.writeSync(fd, data);
      },
    },
  });
  writer.write({ kept: true });
  fail = true;
  expectCode(() => writer.write({ unavailable: true }), "disk-full");
  expectCode(() => new JsonlWriter(dir, { now }), "writer-locked");
  fail = false;
  writer.write({ recovered: true });
  writer.close();
  assert.deepEqual(scan(dir), { partialFiles: [partial], truncatedFiles: [] });
  assert.equal(fs.readFileSync(join(dir, partial), "utf8"), '{"kept":true}\n');
  assert.equal(
    fs.readFileSync(join(dir, second), "utf8"),
    '{"recovered":true}\n',
  );
});

test("reports a short write and detects last lines missing their terminator", () => {
  let short = false;
  const writer = new JsonlWriter(dir, {
    now,
    fs: {
      ...fs,
      writeSync(fd, data) {
        return fs.writeSync(
          fd,
          short ? data.subarray(0, data.length - 1) : data,
        );
      },
    },
  });
  writer.write({ kept: true });
  short = true;
  expectCode(() => writer.write({ interrupted: true }), "write-failed");
  writer.close();
  fs.writeFileSync(join(dir, second), '{"legacy":');
  fs.writeFileSync(join(dir, "unrelated.partial"), "{");
  assert.deepEqual(scan(dir), {
    partialFiles: [partial],
    truncatedFiles: [partial, second],
  });
  assert.equal(
    fs.readFileSync(join(dir, partial), "utf8"),
    '{"kept":true}\n{"interrupted":true}',
  );
});

test("preserves a partial file when finalization fails", () => {
  const writer = new JsonlWriter(dir, {
    now,
    fs: {
      ...fs,
      fsyncSync() {
        throw Object.assign(new Error("test disk full"), { code: "ENOSPC" });
      },
    },
  });
  writer.write({ kept: true });
  expectCode(() => writer.close(), "disk-full");
  assert.deepEqual(scan(dir), { partialFiles: [partial], truncatedFiles: [] });
  assert.equal(fs.existsSync(join(dir, first)), false);
  new JsonlWriter(dir, { now }).close();
});

test("uses private modes for created directories, data files and locks", () => {
  const parent = join(root, "observability");
  dir = join(parent, "exports");
  const writer = new JsonlWriter(dir, { now });
  writer.write({ sequence: 1 });
  for (const path of [parent, dir])
    assert.equal(fs.statSync(path).mode & 0o777, 0o700);
  for (const name of [partial, "writer.lock"])
    assert.equal(fs.statSync(join(dir, name)).mode & 0o777, 0o600);
  writer.close();
  assert.equal(fs.statSync(join(dir, first)).mode & 0o777, 0o600);
});

test("refuses symlink and group- or world-writable output directories", () => {
  const target = join(root, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, dir);
  expectCode(() => new JsonlWriter(dir + "/", { now }), "unsafe-directory");
  expectCode(() => scan(dir), "unsafe-directory");
  assert.deepEqual(fs.readdirSync(target), []);
  for (const mode of [0o720, 0o702]) {
    fs.chmodSync(target, mode);
    expectCode(() => new JsonlWriter(target, { now }), "unsafe-directory");
    expectCode(() => scan(target), "unsafe-directory");
  }
});

test("refuses unsafe ancestors before creating an output directory", () => {
  const parent = join(root, "parent");
  const link = join(root, "link");
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.symlinkSync(parent, link);
  expectCode(
    () => new JsonlWriter(join(link, "exports"), { now }),
    "unsafe-directory",
  );
  assert.deepEqual(fs.readdirSync(parent), []);

  fs.chmodSync(parent, 0o720);
  expectCode(
    () => new JsonlWriter(join(parent, "exports"), { now }),
    "unsafe-directory",
  );
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("accepts a trusted sticky ancestor and creates a private child", () => {
  fs.chmodSync(root, 0o1777);
  const writer = new JsonlWriter(dir, { now });
  writer.write({ sequence: 1 });
  assert.deepEqual(scan(dir), { partialFiles: [partial], truncatedFiles: [] });
  writer.close();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test("leaves an unexpected final destination and the active partial intact", () => {
  const writer = new JsonlWriter(dir, { now });
  writer.write({ kept: true });
  fs.writeFileSync(join(dir, first), '{"existing":true}\n');
  expectCode(() => writer.close(), "write-failed");
  assert.equal(
    fs.readFileSync(join(dir, first), "utf8"),
    '{"existing":true}\n',
  );
  assert.equal(fs.readFileSync(join(dir, partial), "utf8"), '{"kept":true}\n');
});
