import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  layoutTar,
  normalizeLayer,
  ociImage,
  readOciLayout,
} from "../src/oci-image.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface In {
  name?: string;
  type?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  link?: string;
  data?: string;
  mtime?: number;
  uname?: string;
  major?: number;
  minor?: number;
  pax?: Record<string, string>;
  gnuLong?: boolean;
}

function oct(v: number, len: number): string {
  return v.toString(8).padStart(len - 1, "0") + "\0";
}

function hdr(
  name: string,
  o: In,
  size: number,
  type: string,
  link = "",
): Uint8Array {
  const b = new Uint8Array(512);
  b.set(enc.encode(name).subarray(0, 100), 0);
  b.set(enc.encode(oct(o.mode ?? 0o644, 8)), 100);
  b.set(enc.encode(oct(o.uid ?? 0, 8)), 108);
  b.set(enc.encode(oct(o.gid ?? 0, 8)), 116);
  b.set(enc.encode(oct(size, 12)), 124);
  b.set(enc.encode(oct(o.mtime ?? 0, 12)), 136);
  b[156] = type.charCodeAt(0);
  b.set(enc.encode(link).subarray(0, 100), 157);
  b.set(enc.encode("ustar\0" + "00"), 257);
  b.set(enc.encode(o.uname ?? ""), 265);
  b.set(enc.encode(o.uname ?? ""), 297);
  b.set(enc.encode(oct(o.major ?? 0, 8)), 329);
  b.set(enc.encode(oct(o.minor ?? 0, 8)), 337);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i]!;
  b.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return b;
}

function pad(d: Uint8Array): Uint8Array[] {
  return d.length % 512 === 0
    ? [d]
    : [d, new Uint8Array(512 - (d.length % 512))];
}

function rec(k: string, v: string): string {
  const body = ` ${k}=${v}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len)
    len = String(len).length + body.length;
  return `${len}${body}`;
}

function tar(entries: In[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = enc.encode(e.data ?? "");
    const type = e.type ?? "0";
    if (e.pax) {
      const p = enc.encode(
        Object.entries(e.pax)
          .map(([k, v]) => rec(k, v))
          .join(""),
      );
      parts.push(hdr("PaxHeader", {}, p.length, "x"), ...pad(p));
    }
    let name = e.name ?? "";
    if (e.gnuLong) {
      const l = enc.encode(name + "\0");
      parts.push(hdr("././@LongLink", {}, l.length, "L"), ...pad(l));
      name = name.slice(0, 99);
    }
    parts.push(
      hdr(name, e, type === "0" ? data.length : 0, type, e.link),
      ...pad(data),
    );
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Minimal reader to inspect output.
function read(t: Uint8Array) {
  const out: {
    name: string;
    type: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    uname: string;
    link: string;
    major: number;
    minor: number;
    data: string;
    pax: string | undefined;
  }[] = [];
  let pos = 0;
  let pax: string | undefined;
  const num = (o: number, l: number) =>
    parseInt(
      dec
        .decode(t.subarray(pos + o, pos + o + l))
        .replace(/\0.*$/, "")
        .trim() || "0",
      8,
    );
  const str = (o: number, l: number) =>
    dec.decode(t.subarray(pos + o, pos + o + l)).replace(/\0.*$/, "");
  while (t.subarray(pos, pos + 512).some((x) => x !== 0)) {
    const size = num(124, 12);
    const type = str(156, 1);
    const data = dec.decode(t.subarray(pos + 512, pos + 512 + size));
    if (type === "x") pax = data;
    else {
      out.push({
        name: str(0, 100),
        type,
        mode: num(100, 8),
        uid: num(108, 8),
        gid: num(116, 8),
        mtime: num(136, 12),
        uname: str(265, 32) + str(297, 32),
        link: str(157, 100),
        major: num(329, 8),
        minor: num(337, 8),
        data,
        pax,
      });
      pax = undefined;
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const sample: In[] = [
  { name: "./etc/", type: "5", mode: 0o755, mtime: 99, uname: "root" },
  {
    name: "./etc/passwd",
    data: "root\n",
    mode: 0o600,
    uid: 5,
    gid: 6,
    mtime: 1234,
    uname: "bob",
  },
  { name: "./bin/sh", type: "2", link: "busybox", mode: 0o777 },
  { name: "./bin/busybox", data: "ELF", mode: 0o755 },
  { name: "./bin/ash", type: "1", link: "./bin/busybox", mode: 0o755 },
  { name: "./dev/null", type: "3", major: 1, minor: 3, mode: 0o666 },
  { name: "./dev/loop0", type: "4", major: 7, minor: 0, mode: 0o660 },
  { name: "./run/fifo", type: "6", mode: 0o600 },
];

test("normalization is deterministic regardless of entry order", () => {
  const a = normalizeLayer(tar(sample));
  const b = normalizeLayer(tar([...sample].reverse()));
  assert.deepEqual(a, b);
  assert.equal(a.length % 512, 0);
});

test("mtime and names are stripped, metadata preserved", () => {
  const out = read(normalizeLayer(tar(sample)));
  for (const e of out) {
    assert.equal(e.mtime, 0);
    assert.equal(e.uname, "");
  }
  const by = Object.fromEntries(out.map((e) => [e.name, e]));
  assert.equal(by["etc/"]!.type, "5");
  assert.equal(by["etc/passwd"]!.mode, 0o600);
  assert.equal(by["etc/passwd"]!.uid, 5);
  assert.equal(by["etc/passwd"]!.gid, 6);
  assert.equal(by["etc/passwd"]!.data, "root\n");
  assert.equal(by["bin/sh"]!.type, "2");
  assert.equal(by["bin/sh"]!.link, "busybox");
  assert.equal(by["bin/ash"]!.type, "1");
  assert.equal(by["bin/ash"]!.link, "bin/busybox");
  assert.equal(by["dev/null"]!.type, "3");
  assert.equal(by["dev/null"]!.major, 1);
  assert.equal(by["dev/null"]!.minor, 3);
  assert.equal(by["dev/loop0"]!.type, "4");
  assert.equal(by["run/fifo"]!.type, "6");
});

test("entries sorted and hardlinks follow their targets", () => {
  const names = read(normalizeLayer(tar(sample))).map((e) => e.name);
  assert.ok(names.indexOf("bin/busybox") < names.indexOf("bin/ash"));
  assert.equal(names.at(-1), "bin/ash");
  const rest = names.slice(0, -1);
  assert.deepEqual(rest, [...rest].sort());
});

test("long names round-trip via PAX, from PAX and GNU inputs", () => {
  const long = `./${"d".repeat(60)}/${"f".repeat(80)}`;
  const target = `${"t".repeat(150)}`;
  for (const mk of [
    (): In[] => [
      { name: "x", pax: { path: long, linkpath: target }, type: "2" },
    ],
    (): In[] => [{ name: long, gnuLong: true, data: "hi" }],
  ]) {
    const out = normalizeLayer(tar(mk()));
    const e = read(out);
    assert.equal(e.length, 1);
    assert.ok(e[0]!.pax?.includes(`path=${long.slice(2)}\n`));
    assert.ok(!e[0]!.pax?.includes("mtime"));
    // Re-normalizing is idempotent.
    assert.deepEqual(normalizeLayer(out), out);
  }
  const link = read(
    normalizeLayer(
      tar([{ name: "l", type: "2", link: target, pax: { linkpath: target } }]),
    ),
  );
  assert.ok(link[0]!.pax?.includes(`linkpath=${target}\n`));
});

test("binary PAX xattr values are ignored and dropped", () => {
  const key = enc.encode(" SCHILY.xattr.x=");
  const rawVal = new Uint8Array([0xff, 0x00, 0x80]);
  let len = key.length + rawVal.length + 2;
  while (String(len).length + key.length + rawVal.length + 1 !== len) {
    len = String(len).length + key.length + rawVal.length + 1;
  }
  const p = new Uint8Array(len);
  p.set(enc.encode(String(len)), 0);
  p.set(key, String(len).length);
  p.set(rawVal, String(len).length + key.length);
  p[len - 1] = 0x0a;
  const inner = tar([{ name: "f", data: "x" }]);
  const parts = [hdr("PaxHeader", {}, p.length, "x"), ...pad(p), inner];
  const raw = new Uint8Array(parts.reduce((n, q) => n + q.length, 0));
  let off = 0;
  for (const q of parts) {
    raw.set(q, off);
    off += q.length;
  }
  const out = read(normalizeLayer(raw));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "f");
  assert.equal(out[0]!.pax, undefined);
  assert.ok(!dec.decode(normalizeLayer(raw)).includes("xattr"));
});

test("duplicates, '..' and bad hardlinks are rejected", () => {
  assert.throws(
    () => normalizeLayer(tar([{ name: "a" }, { name: "./a" }])),
    /duplicate/,
  );
  assert.throws(() => normalizeLayer(tar([{ name: "a/../b" }])), /\.\./);
  assert.throws(
    () => normalizeLayer(tar([{ name: "h", type: "1", link: "nope" }])),
    /hardlink target/,
  );
  assert.throws(
    () =>
      normalizeLayer(
        tar([
          { name: "a" },
          { name: "b", type: "1", link: "a" },
          { name: "c", type: "1", link: "b" },
        ]),
      ),
    /hardlink to hardlink/,
  );
  const bad = tar([{ name: "a" }]);
  bad[0] = 0x41;
  assert.throws(() => normalizeLayer(bad), /checksum/);
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function build() {
  const layer = normalizeLayer(tar(sample));
  const baseConfig = {
    architecture: "arm64",
    os: "linux",
    author: "x",
    created: "2020-01-01T00:00:00Z",
    history: [{ created_by: "x" }],
    config: {
      Env: ["A=1"],
      Cmd: ["sh"],
      WorkingDir: "/",
      User: "0",
      Labels: { a: "b" },
      ExposedPorts: {},
    },
    rootfs: { type: "layers", diff_ids: ["sha256:" + "0".repeat(64)] },
  };
  return {
    layer,
    res: ociImage({
      baseConfig,
      layer,
      platform: { architecture: "arm64", os: "linux" },
    }),
  };
}

test("layout digests and sizes are consistent", () => {
  const { layer, res } = build();
  assert.equal(res.layerDigest, sha(layer));
  const manifest = res.files.get(`blobs/sha256/${res.manifestDigest}`)!;
  assert.equal(sha(manifest), res.manifestDigest);
  const m = JSON.parse(dec.decode(manifest));
  const cfgHex = m.config.digest.slice(7);
  const cfg = res.files.get(`blobs/sha256/${cfgHex}`)!;
  assert.equal(sha(cfg), cfgHex);
  assert.equal(m.config.size, cfg.length);
  assert.equal(m.layers.length, 1);
  assert.equal(m.layers[0].digest, `sha256:${res.layerDigest}`);
  assert.equal(m.layers[0].size, layer.length);
  assert.equal(m.layers[0].mediaType, "application/vnd.oci.image.layer.v1.tar");
  const idx = JSON.parse(dec.decode(res.files.get("index.json")!));
  assert.equal(idx.manifests[0].digest, `sha256:${res.manifestDigest}`);
  assert.equal(idx.manifests[0].size, manifest.length);
  assert.deepEqual(idx.manifests[0].platform, {
    architecture: "arm64",
    os: "linux",
  });
  assert.match(res.manifestDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    dec.decode(res.files.get("oci-layout")!),
    '{"imageLayoutVersion":"1.0.0"}',
  );
  assert.deepEqual(build().res.files, res.files);
});

test("config keeps only allowed keys", () => {
  const { res } = build();
  const m = JSON.parse(
    dec.decode(res.files.get(`blobs/sha256/${res.manifestDigest}`)!),
  );
  const cfg = JSON.parse(
    dec.decode(res.files.get(`blobs/sha256/${m.config.digest.slice(7)}`)!),
  );
  assert.deepEqual(cfg, {
    architecture: "arm64",
    config: { Env: ["A=1"], Cmd: ["sh"], WorkingDir: "/", User: "0" },
    created: "1970-01-01T00:00:00Z",
    os: "linux",
    rootfs: { diff_ids: [`sha256:${res.layerDigest}`], type: "layers" },
  });
  assert.throws(
    () =>
      ociImage({
        baseConfig: { architecture: "amd64", os: "linux" },
        layer: res.files.get("oci-layout")!,
        platform: { architecture: "arm64", os: "linux" },
      }),
    /platform/,
  );
});

test("readOciLayout round-trips layoutTar output", () => {
  const { res } = build();
  const t = layoutTar(res.files);
  assert.deepEqual(layoutTar(new Map([...res.files].reverse())), t);
  const names = read(t).map((e) => e.name);
  assert.equal(names[0], "blobs/");
  assert.equal(names[1], "blobs/sha256/");
  const { index, manifest, config } = readOciLayout(t);
  assert.equal(index.manifests[0]!.digest, `sha256:${res.manifestDigest}`);
  assert.equal(manifest.layers[0]!.digest, `sha256:${res.layerDigest}`);
  assert.equal(config.architecture, "arm64");
  assert.deepEqual(config.config, {
    Env: ["A=1"],
    Cmd: ["sh"],
    WorkingDir: "/",
    User: "0",
  });
  for (const e of read(t)) {
    assert.equal(e.mtime, 0);
    assert.equal(e.mode, e.type === "5" ? 0o755 : 0o644);
  }
});
