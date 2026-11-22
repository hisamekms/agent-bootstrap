import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const FILE_NAME = /^(\d{4}-\d{2}-\d{2})-(\d{4})\.jsonl(\.partial)?$/u;
// Skip escaped backslashes and reject line breaks even inside JSON strings.
const NEWLINE = /[\r\n]|(?:^|[^\\])(?:\\\\)*\\(?:[nr]|u000[ad])/iu;
const CREATE =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;
const READ =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

type JsonlFs = Pick<
  typeof fs,
  | "closeSync"
  | "fstatSync"
  | "fsyncSync"
  | "lstatSync"
  | "mkdirSync"
  | "openSync"
  | "readSync"
  | "readdirSync"
  | "renameSync"
  | "unlinkSync"
> & {
  writeSync(fd: number, data: Buffer): number;
};

export type JsonlWriterOptions = {
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly fs?: JsonlFs;
};

type JsonlErrorCode =
  | "closed"
  | "disk-full"
  | "invalid-record"
  | "record-too-large"
  | "unsafe-directory"
  | "writer-locked"
  | "stale-lock"
  | "write-failed";

export class JsonlFileError extends Error {
  readonly code: JsonlErrorCode;
  readonly pid: number | undefined;

  constructor(code: JsonlErrorCode, pid?: number) {
    super(pid === undefined ? `JSONL: ${code}` : `JSONL: ${code} (PID ${pid})`);
    this.name = "JsonlFileError";
    this.code = code;
    this.pid = pid;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function writeError(error: unknown): JsonlFileError {
  if (error instanceof JsonlFileError) return error;
  return new JsonlFileError(
    hasCode(error, "ENOSPC") ? "disk-full" : "write-failed",
  );
}

function checkDirectories(io: JsonlFs, dir: string, create: boolean): void {
  const path: string[] = [];
  for (let entry = dir; ; entry = dirname(entry)) {
    path.push(entry);
    if (dirname(entry) === entry) break;
  }
  const uid = process.geteuid?.();
  for (const entry of path.reverse()) {
    let stat = io.lstatSync(entry, { throwIfNoEntry: false });
    if (!stat && create) {
      try {
        io.mkdirSync(entry, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      stat = io.lstatSync(entry);
    }
    // Under a trusted sticky ancestor such as /tmp, other users cannot
    // replace entries owned by a trusted user. Check every child in turn.
    const trustedStickyAncestor =
      stat && entry !== dir && (stat.mode & 0o1000) !== 0;
    if (
      !stat?.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && !trustedStickyAncestor)
    ) {
      throw new JsonlFileError("unsafe-directory");
    }
  }
}

function lockError(io: JsonlFs, path: string): JsonlFileError {
  let pid: number;
  try {
    const fd = io.openSync(path, READ);
    try {
      const data = Buffer.alloc(16);
      if (!io.fstatSync(fd).isFile())
        return new JsonlFileError("writer-locked");
      const length = io.readSync(fd, data, 0, data.length, 0);
      const value = data.toString("utf8", 0, length);
      if (!/^[1-9]\d{0,9}\n?$/u.test(value))
        return new JsonlFileError("writer-locked");
      pid = Number(value);
      if (pid > 0x7fff_ffff) return new JsonlFileError("writer-locked");
    } finally {
      io.closeSync(fd);
    }
  } catch {
    return new JsonlFileError("writer-locked");
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) return new JsonlFileError("stale-lock", pid);
  }
  return new JsonlFileError("writer-locked", pid);
}

function writeLine(io: JsonlFs, fd: number, line: Buffer): void {
  if (io.writeSync(fd, line) !== line.length)
    throw new JsonlFileError("write-failed");
}

function acquireLock(io: JsonlFs, path: string): void {
  let fd: number;
  try {
    fd = io.openSync(path, CREATE, 0o600);
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw lockError(io, path);
    throw error;
  }
  try {
    try {
      writeLine(io, fd, Buffer.from(`${process.pid}\n`));
    } finally {
      io.closeSync(fd);
    }
  } catch (error) {
    try {
      io.unlinkSync(path);
    } catch {
      // An incomplete lock still blocks future writers.
    }
    throw error;
  }
}

function encodeRecord(record: object): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(record);
  } catch {
    throw new JsonlFileError("invalid-record");
  }
  if (!json?.startsWith("{") || NEWLINE.test(json)) {
    throw new JsonlFileError("invalid-record");
  }
  return Buffer.from(`${json}\n`, "utf8");
}

type ActiveFile = {
  readonly fd: number;
  readonly date: string;
  readonly path: string;
  bytes: number;
};

/** Use a canonical output path. Close the writer to release its lock. */
export class JsonlWriter {
  readonly #io: JsonlFs;
  readonly #dir: string;
  readonly #lockPath: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #active: ActiveFile | undefined;
  #closed = false;

  constructor(dir: string, options: JsonlWriterOptions = {}) {
    this.#io = options.fs ?? fs;
    this.#dir = resolve(dir);
    this.#lockPath = join(this.#dir, "writer.lock");
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
    try {
      checkDirectories(this.#io, this.#dir, true);
      acquireLock(this.#io, this.#lockPath);
    } catch (error) {
      throw writeError(error);
    }
  }

  write(record: object): void {
    if (this.#closed) throw new JsonlFileError("closed");
    const line = encodeRecord(record);
    if (line.length > this.#maxBytes)
      throw new JsonlFileError("record-too-large");

    try {
      // Serialization and the injected clock may call user code.
      const date = this.#now().toISOString().split("T")[0];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date))
        throw new JsonlFileError("write-failed");
      if (this.#closed) throw new JsonlFileError("closed");
      if (
        this.#active &&
        (this.#active.date !== date ||
          this.#active.bytes + line.length > this.#maxBytes)
      ) {
        this.#finishActive();
      }
      const active = (this.#active ??= this.#openActive(date));
      try {
        writeLine(this.#io, active.fd, line);
      } catch (error) {
        // Keep this file for inspection and start a fresh one on the next write.
        this.#active = undefined;
        try {
          this.#io.closeSync(active.fd);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
      active.bytes += line.length;
    } catch (error) {
      throw writeError(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      try {
        this.#finishActive();
      } finally {
        this.#io.unlinkSync(this.#lockPath);
      }
    } catch (error) {
      throw writeError(error);
    }
  }

  #openActive(date: string): ActiveFile {
    let last = 0;
    for (const name of this.#io.readdirSync(this.#dir)) {
      const match = FILE_NAME.exec(name);
      if (match?.[1] === date) last = Math.max(last, Number(match[2]));
    }
    if (last >= 9999) throw new JsonlFileError("write-failed");
    const path = join(
      this.#dir,
      `${date}-${String(last + 1).padStart(4, "0")}.jsonl.partial`,
    );
    const fd = this.#io.openSync(path, CREATE, 0o600);
    return { fd, date, path, bytes: 0 };
  }

  #finishActive(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = undefined;
    try {
      this.#io.fsyncSync(active.fd);
    } finally {
      this.#io.closeSync(active.fd);
    }
    const finalPath = active.path.slice(0, -".partial".length);
    // Check while holding writer.lock, since rename can replace a destination.
    if (this.#io.lstatSync(finalPath, { throwIfNoEntry: false })) {
      throw new JsonlFileError("write-failed");
    }
    this.#io.renameSync(active.path, finalPath);
  }
}

export type JsonlScan = {
  readonly partialFiles: readonly string[];
  readonly truncatedFiles: readonly string[];
};

/** Scan a canonical output path and report matching basenames in filename order. */
export function scan(dir: string): JsonlScan {
  const directory = resolve(dir);
  checkDirectories(fs, directory, false);
  const partialFiles: string[] = [];
  const truncatedFiles: string[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(name);
    if (!match) continue;
    let fd: number;
    try {
      fd = fs.openSync(join(directory, name), READ);
    } catch (error) {
      // Rotation can rename an entry between readdir and open.
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("JSONL: expected a regular file");
      if (match[3]) partialFiles.push(name);
      if (stat.size === 0) continue;
      // The writer emits LF only as the final byte of a complete record.
      const last = Buffer.alloc(1);
      if (
        fs.readSync(fd, last, 0, 1, stat.size - 1) !== 1 ||
        last[0] !== 0x0a
      ) {
        truncatedFiles.push(name);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return { partialFiles, truncatedFiles };
}
