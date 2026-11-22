import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
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
  | "directory-budget"
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

function directoryChain(dir: string): string[] {
  const path: string[] = [];
  for (let entry = dir; ; entry = dirname(entry)) {
    path.push(entry);
    if (dirname(entry) === entry) return path.reverse();
  }
}

function checkDirectory(stat: fs.Stats | undefined, stickyAllowed: boolean) {
  // Under a trusted sticky ancestor such as /tmp, other users cannot
  // replace entries owned by a trusted user. Check every child in turn.
  if (
    !stat?.isDirectory() ||
    (stat.uid !== 0 && stat.uid !== process.geteuid?.()) ||
    ((stat.mode & 0o022) !== 0 &&
      !(stickyAllowed && (stat.mode & 0o1000) !== 0))
  ) {
    throw new JsonlFileError("unsafe-directory");
  }
}

function checkDirectories(io: JsonlFs, dir: string, create: boolean): void {
  for (const entry of directoryChain(dir)) {
    let stat = io.lstatSync(entry, { throwIfNoEntry: false });
    if (!stat && create) {
      try {
        io.mkdirSync(entry, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      stat = io.lstatSync(entry);
    }
    checkDirectory(stat, entry !== dir);
  }
}

function describeLock(value: string): JsonlFileError {
  if (!/^[1-9]\d{0,9}\n?$/u.test(value))
    return new JsonlFileError("writer-locked");
  const pid = Number(value);
  if (pid > 0x7fff_ffff) return new JsonlFileError("writer-locked");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) return new JsonlFileError("stale-lock", pid);
  }
  return new JsonlFileError("writer-locked", pid);
}

function lockError(io: JsonlFs, path: string): JsonlFileError {
  try {
    const fd = io.openSync(path, READ);
    try {
      const data = Buffer.alloc(16);
      if (!io.fstatSync(fd).isFile())
        return new JsonlFileError("writer-locked");
      const length = io.readSync(fd, data, 0, data.length, 0);
      return describeLock(data.toString("utf8", 0, length));
    } finally {
      io.closeSync(fd);
    }
  } catch {
    return new JsonlFileError("writer-locked");
  }
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

function nextFile(names: string[], dir: string, date: string): string {
  let last = 0;
  for (const name of names) {
    const match = FILE_NAME.exec(name);
    if (match?.[1] === date) last = Math.max(last, Number(match[2]));
  }
  if (last >= 9999) throw new JsonlFileError("write-failed");
  return join(
    dir,
    `${date}-${String(last + 1).padStart(4, "0")}.jsonl.partial`,
  );
}

type ActiveFile = {
  readonly fd: number;
  readonly date: string;
  readonly path: string;
  bytes: number;
};

/**
 * Use a canonical output path. Close the writer to release its lock.
 * Audit export uses this uncapped writer and can share a volume with telemetry.
 */
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
    const path = nextFile(this.#io.readdirSync(this.#dir), this.#dir, date);
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

type AsyncJsonlFs = Pick<
  typeof asyncFs,
  "lstat" | "mkdir" | "open" | "readdir" | "rename" | "unlink"
>;

export type TelemetryJsonlOptions = {
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly fs?: AsyncJsonlFs;
};

const telemetrySignals = ["traces", "metrics", "logs"] as const;
export type TelemetrySignal = (typeof telemetrySignals)[number];

type AsyncActiveFile = Omit<ActiveFile, "fd"> & {
  readonly handle: asyncFs.FileHandle;
};

async function lstatIfPresent(io: AsyncJsonlFs, path: string) {
  try {
    return await io.lstat(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return undefined;
  }
}

async function makeSafeDirectory(io: AsyncJsonlFs, dir: string) {
  for (const entry of directoryChain(dir)) {
    let stat = await lstatIfPresent(io, entry);
    if (!stat) {
      try {
        await io.mkdir(entry, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      stat = await io.lstat(entry);
    }
    checkDirectory(stat, entry !== dir);
  }
}

async function asyncLockError(io: AsyncJsonlFs, path: string) {
  try {
    const handle = await io.open(path, READ);
    try {
      if (!(await handle.stat()).isFile())
        return new JsonlFileError("writer-locked");
      const data = Buffer.alloc(16);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      return describeLock(data.toString("utf8", 0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return new JsonlFileError("writer-locked");
  }
}

/** Calls must be serialized. The root lock covers the shared signal budget. */
export class TelemetryJsonlDirectory {
  readonly #io: AsyncJsonlFs;
  readonly #dir: string;
  readonly #lock: string;
  readonly #maxTotalBytes: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #openSignals = new Set<TelemetrySignal>();
  readonly #active = new Map<TelemetrySignal, AsyncActiveFile>();
  #totalBytes = 0;

  constructor(
    dir: string,
    maxTotalBytes: number,
    options: TelemetryJsonlOptions = {},
  ) {
    this.#io = options.fs ?? asyncFs;
    this.#dir = resolve(dir);
    this.#lock = join(this.#dir, "writer.lock");
    this.#maxTotalBytes = maxTotalBytes;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
    for (const limit of [this.#maxTotalBytes, this.#maxBytes]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new RangeError(
          "JSONL byte limits must be positive safe integers",
        );
    }
  }

  async #acquireBudget() {
    const io = this.#io;
    await makeSafeDirectory(io, this.#dir);
    let lock: asyncFs.FileHandle;
    try {
      lock = await io.open(this.#lock, CREATE, 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw await asyncLockError(io, this.#lock);
      throw error;
    }
    try {
      try {
        await lock.writeFile(`${process.pid}\n`);
      } finally {
        await lock.close();
      }
      this.#totalBytes = 0;
      for (const signal of telemetrySignals) {
        const dir = join(this.#dir, signal);
        const stat = await lstatIfPresent(io, dir);
        if (!stat?.isDirectory()) continue;
        for (const name of await io.readdir(dir)) {
          if (!FILE_NAME.test(name)) continue;
          const file = await lstatIfPresent(io, join(dir, name));
          if (file?.isFile()) this.#totalBytes += file.size;
        }
      }
    } catch (error) {
      await io.unlink(this.#lock);
      throw error;
    }
  }

  async write(signal: TelemetrySignal, record: object): Promise<void> {
    const line = encodeRecord(record);
    if (line.length > this.#maxBytes)
      throw new JsonlFileError("record-too-large");
    try {
      const dir = join(this.#dir, signal);
      if (!this.#openSignals.has(signal)) {
        await makeSafeDirectory(this.#io, dir);
        if (!this.#openSignals.size) await this.#acquireBudget();
        this.#openSignals.add(signal);
      }
      if (line.length > this.#maxTotalBytes - this.#totalBytes)
        throw new JsonlFileError("directory-budget");
      const date = this.#now().toISOString().split("T")[0];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date))
        throw new JsonlFileError("write-failed");
      let active = this.#active.get(signal);
      if (
        active &&
        (active.date !== date || active.bytes + line.length > this.#maxBytes)
      ) {
        await this.#finish(signal);
        active = undefined;
      }
      if (!active) {
        const path = nextFile(await this.#io.readdir(dir), dir, date);
        const handle = await this.#io.open(path, CREATE, 0o600);
        active = { path, date, handle, bytes: 0 };
        this.#active.set(signal, active);
      }
      // Reserve the whole line until the write or a post-failure stat tells us
      // how much space was consumed.
      this.#totalBytes += line.length;
      try {
        const { bytesWritten } = await active.handle.write(line);
        if (bytesWritten !== line.length)
          throw new JsonlFileError("write-failed");
      } catch (error) {
        this.#active.delete(signal);
        const stat = await active.handle.stat().catch(() => undefined);
        if (stat) this.#totalBytes += stat.size - active.bytes - line.length;
        await active.handle.close().catch(() => {});
        throw error;
      }
      active.bytes += line.length;
    } catch (error) {
      throw writeError(error);
    }
  }

  async close(signal: TelemetrySignal): Promise<void> {
    if (!this.#openSignals.delete(signal)) return;
    try {
      try {
        await this.#finish(signal);
      } finally {
        if (!this.#openSignals.size) await this.#io.unlink(this.#lock);
      }
    } catch (error) {
      throw writeError(error);
    }
  }

  async #finish(signal: TelemetrySignal): Promise<void> {
    const active = this.#active.get(signal);
    if (!active) return;
    this.#active.delete(signal);
    try {
      await active.handle.sync();
    } finally {
      await active.handle.close();
    }
    const finalPath = active.path.slice(0, -".partial".length);
    if (await lstatIfPresent(this.#io, finalPath))
      throw new JsonlFileError("write-failed");
    await this.#io.rename(active.path, finalPath);
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
