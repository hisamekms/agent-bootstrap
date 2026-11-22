import { createHash } from "node:crypto";
import { readTar } from "./oci-image.ts";

/**
 * Pure host-side comparison of a Worker workspace tar against a base tree.
 * The base listing comes from `git ls-tree -r -z --full-tree <commit>`
 * (mode, type, oid, path). No I/O.
 */

export type FileMode = "100644" | "100755" | "120000";

export interface TreeEntry {
  mode: FileMode;
  oid: string;
}

export interface WorkspaceFile {
  mode: FileMode;
  bytes: Uint8Array;
}

export interface Change {
  path: string;
  mode: FileMode;
  bytes: Uint8Array;
}

export interface DiffLimits {
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export interface WorkspaceDiff {
  changes: Change[];
  deletions: string[];
  protected: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const MAX_PATH_BYTES = 4096;
const DEFAULT_LIMITS = {
  maxFiles: 10_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
};

function fail(message: string): never {
  throw new Error(message);
}

/** Git blob object id: SHA-1 of `blob <len>\0` + bytes, lowercase hex. */
export function gitBlobOid(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * Strict parser for `git ls-tree -r -z --full-tree` output:
 * `<mode> SP <type> SP <oid> TAB <path> NUL`. Only regular blobs and
 * symlinks are accepted; submodules and anything else are rejected.
 */
export function parseLsTree(output: Uint8Array): Map<string, TreeEntry> {
  const result = new Map<string, TreeEntry>();
  let pos = 0;
  while (pos < output.length) {
    let end = output.indexOf(0, pos);
    if (end < 0) fail("Malformed ls-tree output");
    const record = output.subarray(pos, end);
    pos = end + 1;
    const tab = record.indexOf(9);
    if (tab < 0) fail("Malformed ls-tree output");
    let meta: string;
    let path: string;
    try {
      meta = dec.decode(record.subarray(0, tab));
      path = dec.decode(record.subarray(tab + 1));
    } catch {
      fail("Malformed ls-tree output");
    }
    const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40})$/.exec(meta);
    if (m === null || path === "") fail("Malformed ls-tree output");
    const [, mode, type, oid] = m as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (type !== "blob") fail("Unsupported tree entry");
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      fail("Unsupported tree entry");
    }
    if (result.has(path)) fail("Malformed ls-tree output");
    result.set(path, { mode, oid });
  }
  return result;
}

/**
 * Files in a workspace tar (strictly read). Directories are ignored.
 * Regular files get 100755 when any execute bit is set, else 100644.
 * A hardlink takes its target's data and mode (same inode). Symlinks become
 * 120000 with the UTF-8 link name as content. Devices and fifos are rejected.
 */
export function workspaceFiles(tar: Uint8Array): Map<string, WorkspaceFile> {
  const entries = readTar(tar);
  const regular = new Map<string, WorkspaceFile>();
  for (const e of entries) {
    if (e.type === "file") {
      regular.set(e.path, {
        mode: e.mode & 0o111 ? "100755" : "100644",
        bytes: e.data,
      });
    }
  }
  const out = new Map<string, WorkspaceFile>();
  for (const e of entries) {
    if (e.type === "file") out.set(e.path, regular.get(e.path)!);
    else if (e.type === "hardlink") {
      const target = regular.get(e.linkname);
      if (target === undefined) fail("Hardlink target missing");
      out.set(e.path, target);
    } else if (e.type === "symlink") {
      out.set(e.path, { mode: "120000", bytes: enc.encode(e.linkname) });
    } else if (e.type !== "directory") {
      fail("Special files are not allowed");
    }
  }
  return out;
}

function inList(path: string, list: readonly string[]): boolean {
  return list.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

function checkPath(path: string): void {
  if (enc.encode(path).length > MAX_PATH_BYTES) fail("Path is too long");
  if (path.includes("\0")) fail("Invalid path");
  for (const part of path.split("/")) {
    if (part.toLowerCase() === ".git") fail("Path contains .git");
  }
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function byPath<T>(key: (v: T) => string) {
  return (a: T, b: T) =>
    Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b)));
}

export function diffWorkspace(input: {
  base: ReadonlyMap<string, TreeEntry>;
  workspace: ReadonlyMap<string, WorkspaceFile>;
  scope?: readonly string[];
  protectedPaths?: readonly string[];
  limits?: DiffLimits;
}): WorkspaceDiff {
  const { base, workspace, scope, protectedPaths = [] } = input;
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const inScope = (p: string) => scope === undefined || inList(p, scope);

  const changes: Change[] = [];
  const deletions: string[] = [];
  const resulting = new Map<string, string>();
  const claim = (path: string) => {
    const key = collisionKey(path);
    if (resulting.has(key))
      fail("Paths collide on a case-insensitive checkout");
    resulting.set(key, path);
  };

  for (const [path, file] of workspace) {
    checkPath(path);
    claim(path);
    const old = base.get(path);
    if (
      old !== undefined &&
      old.mode === file.mode &&
      old.oid === gitBlobOid(file.bytes)
    ) {
      continue;
    }
    if (!inScope(path)) fail("Change outside the allowed paths");
    if (file.bytes.length > limits.maxFileBytes) fail("File is too large");
    changes.push({ path, mode: file.mode, bytes: file.bytes });
  }
  for (const path of base.keys()) {
    if (workspace.has(path)) continue;
    if (inScope(path)) deletions.push(path);
    else claim(path); // sparse checkout: stays in the resulting tree
  }

  // A path that is a file must not also be a directory prefix of another.
  const all = new Set<string>(workspace.keys());
  for (const path of base.keys())
    if (!inScope(path) && !workspace.has(path)) all.add(path);
  for (const path of all) {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
      if (all.has(path.slice(0, i)))
        fail("Path is both a file and a directory");
    }
  }

  if (changes.length + deletions.length > limits.maxFiles) {
    fail("Too many changed files");
  }
  let total = 0;
  for (const c of changes) total += c.bytes.length;
  if (total > limits.maxTotalBytes) fail("Changes are too large");

  changes.sort(byPath((c: Change) => c.path));
  deletions.sort(byPath((p: string) => p));
  const flagged = [...changes.map((c) => c.path), ...deletions]
    .filter((p) => inList(p, protectedPaths))
    .sort(byPath((p: string) => p));
  return { changes, deletions, protected: flagged };
}
