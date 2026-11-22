import { createHash } from "node:crypto";

/**
 * Host-side OCI image assembly: deterministic tar normalization and OCI Image
 * Layout construction. Pure functions over bytes; no I/O.
 */

const BLOCK = 512;
const MAX_INPUT_BYTES = 1024 ** 3;
const MAX_ENTRIES = 200_000;

type EntryType = "0" | "1" | "2" | "3" | "4" | "5" | "6";

interface TarEntry {
  /** Normalized path: no leading "./" or "/", no trailing "/". */
  path: string;
  type: EntryType;
  mode: number;
  uid: number;
  gid: number;
  linkname: string;
  devmajor: number;
  devminor: number;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function fail(message: string): never {
  throw new Error(message);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cstr(block: Uint8Array, off: number, len: number): Uint8Array {
  let end = off;
  const limit = off + len;
  while (end < limit && block[end] !== 0) end++;
  return block.subarray(off, end);
}

function parseNumber(block: Uint8Array, off: number, len: number): number {
  if ((block[off]! & 0x80) !== 0) {
    // GNU base-256 (positive only).
    let value = block[off]! & 0x7f;
    for (let i = 1; i < len; i++) {
      value = value * 256 + block[off + i]!;
      if (!Number.isSafeInteger(value)) fail("tar: numeric field too large");
    }
    return value;
  }
  const text = dec
    .decode(cstr(block, off, len))
    .replace(/[ \0]+$/g, "")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) fail("tar: malformed numeric field");
  return Number.parseInt(text, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const b of block) if (b !== 0) return false;
  return true;
}

function checksumOf(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  return sum;
}

const PAX_USED = new Set(["path", "linkpath", "size", "uid", "gid"]);

/**
 * Parse PAX records bytewise. Values are decoded (UTF-8, fatal) only for keys
 * this module uses; other records (e.g. binary xattr values) are ignored.
 */
function parsePax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    let sp = pos;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = Number(dec.decode(data.subarray(pos, sp)));
    if (
      !Number.isInteger(len) ||
      len <= sp - pos + 1 ||
      pos + len > data.length
    ) {
      fail("tar: malformed PAX record");
    }
    const end = pos + len - 1;
    if (data[end] !== 0x0a) fail("tar: malformed PAX record");
    let eq = sp + 1;
    while (eq < end && data[eq] !== 0x3d) eq++;
    if (eq >= end) fail("tar: malformed PAX record");
    const key = dec.decode(data.subarray(sp + 1, eq));
    if (PAX_USED.has(key)) out.set(key, dec.decode(data.subarray(eq + 1, end)));
    pos += len;
  }
  return out;
}

function normalizePath(raw: string): string {
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "..") fail("tar: path contains '..'");
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  return parts.join("/");
}

function parseTar(tar: Uint8Array): TarEntry[] {
  if (tar.length > MAX_INPUT_BYTES) fail("tar: input too large");
  const entries: TarEntry[] = [];
  let pos = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Map<string, string> | undefined;
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (isZeroBlock(header)) break;
    if (parseNumber(header, 148, 8) !== checksumOf(header)) {
      fail("tar: bad header checksum");
    }
    let size = parseNumber(header, 124, 12);
    const flag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const paxSize = pax?.get("size");
    if (paxSize !== undefined && flag !== "x" && flag !== "g") {
      size = Number(paxSize);
      if (!Number.isSafeInteger(size) || size < 0) fail("tar: bad PAX size");
    }
    const start = pos + BLOCK;
    if (start + size > tar.length) fail("tar: truncated archive");
    const data = tar.subarray(start, start + size);
    pos = start + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === "L") {
      longName = dec.decode(cstr(data, 0, data.length));
      continue;
    }
    if (flag === "K") {
      longLink = dec.decode(cstr(data, 0, data.length));
      continue;
    }
    if (flag === "x") {
      pax = parsePax(data);
      continue;
    }
    if (flag === "g") {
      parsePax(data); // validated, otherwise ignored
      continue;
    }

    let type: EntryType;
    if (flag === "0" || flag === "7") type = "0";
    else if ("123456".includes(flag)) type = flag as EntryType;
    else fail("tar: unsupported entry type");

    let name = dec.decode(cstr(header, 0, 100));
    const prefix = dec.decode(cstr(header, 345, 155));
    if (prefix !== "") name = `${prefix}/${name}`;
    let linkname = dec.decode(cstr(header, 157, 100));
    name = pax?.get("path") ?? longName ?? name;
    linkname = pax?.get("linkpath") ?? longLink ?? linkname;
    const uid = pax?.has("uid")
      ? Number(pax.get("uid"))
      : parseNumber(header, 108, 8);
    const gid = pax?.has("gid")
      ? Number(pax.get("gid"))
      : parseNumber(header, 116, 8);
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
      fail("tar: bad PAX ids");
    }
    longName = longLink = pax = undefined;

    const path = normalizePath(name);
    if (path === "") {
      // Root directory entry: not representable, dropped.
      if (type === "5") continue;
      fail("tar: empty path");
    }
    if (entries.length >= MAX_ENTRIES) fail("tar: too many entries");
    const isLink = type === "1";
    entries.push({
      path,
      type,
      mode: parseNumber(header, 100, 8) & 0o7777,
      uid,
      gid,
      linkname: isLink ? normalizePath(linkname) : linkname,
      devmajor: type === "3" || type === "4" ? parseNumber(header, 329, 8) : 0,
      devminor: type === "3" || type === "4" ? parseNumber(header, 337, 8) : 0,
      data: type === "0" ? data : new Uint8Array(0),
    });
  }
  return entries;
}

function writeOctal(
  block: Uint8Array,
  off: number,
  len: number,
  value: number,
) {
  const max = 8 ** (len - 1) - 1;
  if (value > max) {
    // GNU base-256.
    let v = value;
    for (let i = len - 1; i >= 1; i--) {
      block[off + i] = v % 256;
      v = Math.floor(v / 256);
    }
    block[off] = 0x80 | (v & 0x7f);
    return;
  }
  block.set(enc.encode(value.toString(8).padStart(len - 1, "0")), off);
}

function header(f: {
  name: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  type: string;
  linkname: string;
  devmajor: number;
  devminor: number;
}): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(enc.encode(f.name).subarray(0, 100), 0);
  writeOctal(block, 100, 8, f.mode);
  writeOctal(block, 108, 8, f.uid);
  writeOctal(block, 116, 8, f.gid);
  writeOctal(block, 124, 12, f.size);
  writeOctal(block, 136, 12, 0);
  block[156] = f.type.charCodeAt(0);
  block.set(enc.encode(f.linkname).subarray(0, 100), 157);
  block.set(enc.encode("ustar\0" + "00"), 257);
  writeOctal(block, 329, 8, f.devmajor);
  writeOctal(block, 337, 8, f.devminor);
  const sum = checksumOf(block);
  block.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return block;
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = enc.encode(` ${key}=${value}\n`);
  let len = body.length + 1;
  while (String(len).length + body.length !== len)
    len = String(len).length + body.length;
  return concat([enc.encode(String(len)), body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function padded(data: Uint8Array): Uint8Array[] {
  const rem = data.length % BLOCK;
  return rem === 0 ? [data] : [data, new Uint8Array(BLOCK - rem)];
}

function writeTar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const name = e.type === "5" ? `${e.path}/` : e.path;
    const records: Uint8Array[] = [];
    if (enc.encode(name).length > 100) records.push(paxRecord("path", name));
    if (enc.encode(e.linkname).length > 100) {
      records.push(paxRecord("linkpath", e.linkname));
    }
    if (records.length > 0) {
      const data = concat(records);
      parts.push(
        header({
          name: "PaxHeader",
          mode: 0o644,
          uid: 0,
          gid: 0,
          size: data.length,
          type: "x",
          linkname: "",
          devmajor: 0,
          devminor: 0,
        }),
        ...padded(data),
      );
    }
    parts.push(
      header({
        name,
        mode: e.mode,
        uid: e.uid,
        gid: e.gid,
        size: e.data.length,
        type: e.type,
        linkname: e.linkname,
        devmajor: e.devmajor,
        devminor: e.devminor,
      }),
      ...padded(e.data),
    );
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
}

function byPath(a: TarEntry, b: TarEntry): number {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

/**
 * Rewrite a tar deterministically. Entries are sorted by normalized path
 * (bytewise); non-hardlink entries come first, then all hardlinks (sorted), so
 * every hardlink follows its target. Hardlinks to hardlinks are rejected.
 * In each hardlink group the bytewise-smallest path becomes the file, so the
 * output does not depend on which member the archiver saw first.
 * The root directory entry is dropped. mtime, uname and gname are cleared.
 * PAX extended attributes (xattrs, e.g. file capabilities) are dropped.
 */
export function normalizeLayer(tar: Uint8Array): Uint8Array {
  const entries = parseTar(tar);
  const byName = new Map<string, TarEntry>();
  for (const e of entries) {
    if (byName.has(e.path)) fail("tar: duplicate path");
    byName.set(e.path, e);
  }
  for (const e of entries) {
    if (e.type !== "1") continue;
    const target = byName.get(e.linkname);
    if (target === undefined) fail("tar: hardlink target missing");
    if (target.type === "1") fail("tar: hardlink to hardlink");
  }
  // Which member of a hardlink group the archiver wrote as the file depends
  // on its traversal order. Canonicalize: the bytewise-smallest path holds
  // the data and every other member links to it.
  const groups = new Map<string, TarEntry[]>();
  for (const e of entries)
    if (e.type === "1") {
      const group = groups.get(e.linkname) ?? [byName.get(e.linkname)!];
      group.push(e);
      groups.set(e.linkname, group);
    }
  const rewritten = new Map<string, TarEntry>();
  for (const group of groups.values()) {
    const file = group.find((e) => e.type !== "1")!;
    const members = [...group].sort(byPath);
    const owner = members[0]!;
    rewritten.set(owner.path, { ...file, path: owner.path });
    for (const member of members.slice(1))
      rewritten.set(member.path, {
        ...file,
        path: member.path,
        type: "1",
        linkname: owner.path,
        data: new Uint8Array(0),
      });
  }
  const all = entries.map((e) => rewritten.get(e.path) ?? e);
  const regular = all.filter((e) => e.type !== "1").sort(byPath);
  const links = all.filter((e) => e.type === "1").sort(byPath);
  return writeTar([...regular, ...links]);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(canonical(value)));
}

const CONFIG_KEYS = ["Env", "Cmd", "Entrypoint", "WorkingDir", "User"] as const;

export interface OciImageInput {
  baseConfig: object;
  layer: Uint8Array;
  platform: { architecture: string; os: string };
}

export interface OciImageResult {
  files: Map<string, Uint8Array>;
  manifestDigest: string;
  layerDigest: string;
}

/** Build an OCI Image Layout with one uncompressed layer. */
export function ociImage(input: OciImageInput): OciImageResult {
  const base = input.baseConfig as Record<string, unknown>;
  const baseRuntime = (base["config"] ?? {}) as Record<string, unknown>;
  const runtime: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    if (baseRuntime[key] !== undefined && baseRuntime[key] !== null) {
      runtime[key] = baseRuntime[key];
    }
  }
  const architecture = (base["architecture"] ??
    input.platform.architecture) as string;
  const os = (base["os"] ?? input.platform.os) as string;
  if (
    architecture !== input.platform.architecture ||
    os !== input.platform.os
  ) {
    fail("oci: base config platform differs from requested platform");
  }
  const layerHex = sha256Hex(input.layer);
  const config = canonicalJson({
    architecture,
    config: runtime,
    created: "1970-01-01T00:00:00Z",
    os,
    rootfs: { diff_ids: [`sha256:${layerHex}`], type: "layers" },
  });
  const configHex = sha256Hex(config);
  const manifest = canonicalJson({
    config: {
      digest: `sha256:${configHex}`,
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: config.length,
    },
    layers: [
      {
        digest: `sha256:${layerHex}`,
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        size: input.layer.length,
      },
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const manifestHex = sha256Hex(manifest);
  const index = canonicalJson({
    manifests: [
      {
        digest: `sha256:${manifestHex}`,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { architecture, os },
        size: manifest.length,
      },
    ],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  });
  const files = new Map<string, Uint8Array>([
    ["oci-layout", canonicalJson({ imageLayoutVersion: "1.0.0" })],
    ["index.json", index],
    [`blobs/sha256/${configHex}`, config],
    [`blobs/sha256/${manifestHex}`, manifest],
    [`blobs/sha256/${layerHex}`, input.layer],
  ]);
  return { files, manifestDigest: manifestHex, layerDigest: layerHex };
}

/** Deterministic tar of an OCI layout (sorted; mode 0644/0755; uid/gid 0). */
export function layoutTar(files: Map<string, Uint8Array>): Uint8Array {
  const entries = new Map<string, TarEntry>();
  const base = {
    uid: 0,
    gid: 0,
    linkname: "",
    devmajor: 0,
    devminor: 0,
  };
  for (const [raw, data] of files) {
    const path = normalizePath(raw);
    if (path === "" || entries.has(path)) fail("layout: bad or duplicate path");
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!entries.has(dir)) {
        entries.set(dir, {
          ...base,
          path: dir,
          type: "5",
          mode: 0o755,
          data: new Uint8Array(0),
        });
      }
    }
    entries.set(path, { ...base, path, type: "0", mode: 0o644, data });
  }
  return writeTar([...entries.values()].sort(byPath));
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { architecture: string; os: string };
}
export interface OciIndex {
  schemaVersion: number;
  manifests: OciDescriptor[];
}
export interface OciManifest {
  schemaVersion: number;
  config: OciDescriptor;
  layers: OciDescriptor[];
}
export interface OciConfig {
  architecture?: string;
  os?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Parse a single-manifest OCI layout tar (e.g. `msb save --format oci`). */
export function readOciLayout(tar: Uint8Array): {
  index: OciIndex;
  manifest: OciManifest;
  config: OciConfig;
} {
  const files = new Map<string, Uint8Array>();
  for (const e of parseTar(tar)) if (e.type === "0") files.set(e.path, e.data);
  const json = <T>(path: string): T => {
    const data = files.get(path);
    if (data === undefined) fail("oci: missing layout file");
    return JSON.parse(dec.decode(data)) as T;
  };
  const blob = <T>(descriptor: OciDescriptor): T => {
    const m = /^sha256:([0-9a-f]{64})$/.exec(descriptor.digest);
    if (m === null) fail("oci: unsupported digest");
    const data = files.get(`blobs/sha256/${m[1]}`);
    if (data === undefined) fail("oci: missing blob");
    if (sha256Hex(data) !== m[1] || data.length !== descriptor.size) {
      fail("oci: blob digest mismatch");
    }
    return JSON.parse(dec.decode(data)) as T;
  };
  const index = json<OciIndex>("index.json");
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    fail("oci: expected exactly one manifest");
  }
  const manifest = blob<OciManifest>(index.manifests[0]!);
  const config = blob<OciConfig>(manifest.config);
  return { index, manifest, config };
}
