import assert from "node:assert/strict";
import test from "node:test";
import {
  diffWorkspace,
  gitBlobOid,
  parseLsTree,
  workspaceFiles,
  type TreeEntry,
} from "../src/workspace-tree.ts";

const enc = new TextEncoder();

interface In {
  name: string;
  type?: string;
  mode?: number;
  link?: string;
  data?: string;
}

function oct(v: number, len: number): string {
  return v.toString(8).padStart(len - 1, "0") + "\0";
}

function hdr(e: In, size: number, type: string): Uint8Array {
  const b = new Uint8Array(512);
  b.set(enc.encode(e.name).subarray(0, 100), 0);
  b.set(enc.encode(oct(e.mode ?? 0o644, 8)), 100);
  b.set(enc.encode(oct(0, 8)), 108);
  b.set(enc.encode(oct(0, 8)), 116);
  b.set(enc.encode(oct(size, 12)), 124);
  b.set(enc.encode(oct(0, 12)), 136);
  b[156] = type.charCodeAt(0);
  b.set(enc.encode(e.link ?? "").subarray(0, 100), 157);
  b.set(enc.encode("ustar\0" + "00"), 257);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i]!;
  b.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return b;
}

function tar(entries: In[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const type = e.type ?? "0";
    const data = enc.encode(e.data ?? "");
    parts.push(hdr(e, type === "0" ? data.length : 0, type));
    if (type === "0" && data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const dir = (name: string): In => ({
  name: `${name}/`,
  type: "5",
  mode: 0o755,
});
const file = (name: string, data: string, mode = 0o644): In => ({
  name,
  data,
  mode,
});

function base(
  files: Record<string, string>,
  modes: Record<string, TreeEntry["mode"]> = {},
) {
  return new Map<string, TreeEntry>(
    Object.entries(files).map(([p, d]) => [
      p,
      { mode: modes[p] ?? "100644", oid: gitBlobOid(enc.encode(d)) },
    ]),
  );
}

function diff(
  entries: In[],
  b: Map<string, TreeEntry>,
  extra: Partial<Parameters<typeof diffWorkspace>[0]> = {},
) {
  return diffWorkspace({
    base: b,
    workspace: workspaceFiles(tar(entries)),
    ...extra,
  });
}

test("gitBlobOid matches git", () => {
  assert.equal(
    gitBlobOid(new Uint8Array(0)),
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  );
  assert.equal(
    gitBlobOid(enc.encode("hello\n")),
    "ce013625030ba8dba906f756967f9e9ca394464a",
  );
});

test("parseLsTree handles odd names and rejects submodules", () => {
  const oid = "ce013625030ba8dba906f756967f9e9ca394464a";
  const out = enc.encode(
    `100644 blob ${oid}\ta b/日本 語.txt\x00120000 blob ${oid}\tlink\x00100755 blob ${oid}\trun.sh\x00`,
  );
  const m = parseLsTree(out);
  assert.deepEqual([...m.keys()], ["a b/日本 語.txt", "link", "run.sh"]);
  assert.equal(m.get("link")?.mode, "120000");
  assert.equal(parseLsTree(new Uint8Array(0)).size, 0);
  assert.throws(
    () => parseLsTree(enc.encode(`160000 commit ${oid}\tsub\0`)),
    /Unsupported tree entry/,
  );
  assert.throws(
    () => parseLsTree(enc.encode(`100644 blob ${oid}\tx`)),
    /Malformed/,
  );
  assert.throws(
    () => parseLsTree(enc.encode(`100644 blob xyz\tx\0`)),
    /Malformed/,
  );
  assert.throws(
    () => parseLsTree(enc.encode(`100664 blob ${oid}\tx\0`)),
    /Unsupported/,
  );
});

test("add, modify, delete, mode change, symlink", () => {
  const b = base({ "a.txt": "a", "b.txt": "b", "c.sh": "c", "gone.txt": "g" });
  const d = diff(
    [
      file("a.txt", "a"),
      file("b.txt", "b2"),
      file("c.sh", "c", 0o755),
      file("new.txt", "n"),
      { name: "ln", type: "2", link: "a.txt" },
    ],
    b,
  );
  assert.deepEqual(
    d.changes.map((c) => [c.path, c.mode]),
    [
      ["b.txt", "100644"],
      ["c.sh", "100755"],
      ["ln", "120000"],
      ["new.txt", "100644"],
    ],
  );
  assert.equal(new TextDecoder().decode(d.changes[2]!.bytes), "a.txt");
  assert.deepEqual(d.deletions, ["gone.txt"]);
});

test("hardlinks take the target's data", () => {
  const f = workspaceFiles(
    tar([file("x", "data", 0o755), { name: "y", type: "1", link: "x" }]),
  );
  assert.equal(f.get("y")?.mode, "100755");
  assert.equal(new TextDecoder().decode(f.get("y")!.bytes), "data");
});

test("sparse scope semantics", () => {
  const b = base({ "in/a": "a", "in/del": "d", "out/x": "x" });
  const ok = diff([dir("in"), file("in/a", "a2")], b, { scope: ["in/"] });
  assert.deepEqual(
    ok.changes.map((c) => c.path),
    ["in/a"],
  );
  assert.deepEqual(ok.deletions, ["in/del"]);
  const same = diff(
    [dir("in"), file("in/a", "a"), dir("out"), file("out/x", "x")],
    b,
    {
      scope: ["in/"],
    },
  );
  assert.equal(same.changes.length, 0);
  assert.throws(
    () => diff([dir("out"), file("out/x", "changed")], b, { scope: ["in/"] }),
    /Change outside the allowed paths/,
  );
  assert.throws(
    () => diff([file("new", "n")], b, { scope: ["in/", "exact"] }),
    /Change outside the allowed paths/,
  );
  assert.equal(
    diff([file("exact", "n")], b, { scope: ["exact"] }).changes.length,
    1,
  );
});

test(".git variants are rejected", () => {
  for (const p of [".git", ".GIT", ".Git"]) {
    assert.throws(
      () => diff([dir(p), file(`${p}/config`, "x")], base({})),
      /\.git/,
    );
    assert.throws(() => diff([file(p, "x")], base({})), /\.git/);
  }
  assert.throws(
    () =>
      diff([dir("sub"), dir("sub/.git"), file("sub/.git/x", "x")], base({})),
    /\.git/,
  );
  assert.equal(diff([file(".gitignore", "x")], base({})).changes.length, 1);
});

test("case-insensitive collisions are rejected", () => {
  assert.throws(
    () => diff([file("Readme", "a"), file("README", "b")], base({})),
    /collide/,
  );
  assert.throws(
    () =>
      diff([file("readme", "a")], base({ README: "x" }), { scope: ["readme"] }),
    /collide/,
  );
});

test("protected paths are reported", () => {
  const b = base({ "package.json": "p", "src/a": "a", ".github/w.yml": "w" });
  const d = diff(
    [
      dir("src"),
      file("src/a", "a2"),
      file("package.json", "p2"),
      file("bun.lock", "l"),
    ],
    b,
    { protectedPaths: [".github/", "bun.lock", "package.json"] },
  );
  assert.deepEqual(d.protected, [".github/w.yml", "bun.lock", "package.json"]);
});

test("limits", () => {
  const files = [file("a", "aaaa"), file("b", "bbbb")];
  assert.throws(
    () => diff(files, base({}), { limits: { maxFiles: 1 } }),
    /Too many/,
  );
  assert.throws(
    () => diff(files, base({}), { limits: { maxTotalBytes: 7 } }),
    /too large/,
  );
  assert.throws(
    () => diff(files, base({}), { limits: { maxFileBytes: 3 } }),
    /too large/,
  );
  assert.equal(
    diff(files, base({}), { limits: { maxFileBytes: 4 } }).changes.length,
    2,
  );
});

test("device files and bad trees are rejected", () => {
  assert.throws(
    () => workspaceFiles(tar([{ name: "d", type: "3" }])),
    /Special/,
  );
  assert.throws(
    () => workspaceFiles(tar([{ name: "p", type: "6" }])),
    /Special/,
  );
  assert.throws(() => workspaceFiles(tar([file("a/b", "x")])), /parent/);
  assert.throws(
    () =>
      diffWorkspace({
        base: base({}),
        workspace: new Map([
          [
            "a/".repeat(2100) + "z",
            { mode: "100644", bytes: new Uint8Array(0) },
          ],
        ]),
      }),
    /too long/,
  );
});
