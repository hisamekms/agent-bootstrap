import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  fstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  missing,
  syncDirectory,
  userStateDirectory,
} from "../config/layers.ts";
import { publishPrivateFile, uuidPattern } from "../private-journal.ts";
import { privateDirectory } from "../volumes/volume.ts";
import { digestPattern, EnvironmentError } from "./adapter.ts";
import { environmentArchiveLimit } from "./archive.ts";
import { maxEnvironmentPackages, validPackage } from "./lock.ts";

export interface EnvironmentManifest {
  readonly key: string;
  readonly adapter: string;
  readonly profileDigest: string;
  readonly createdAt: string;
  readonly size: number;
  readonly packages: readonly string[];
  readonly hasLock: boolean;
}

export interface PruneOptions {
  readonly keep?: number;
  readonly maxAgeMs?: number;
  readonly now?: number;
}

// Leave time for active work and bound recovery even if a PID has been reused.
const abandonedAfterMs = 24 * 60 * 60 * 1000;

function writeMarker(path: string) {
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), {
    flag: "wx",
    mode: 0o600,
  });
}

// A hold whose process is alive never expires (ADR E5): a running Task may
// hold an entry for longer than the age bound. A pruning marker keeps the
// age bound so that a reused pid cannot block pruning forever.
function activeMarker(path: string, now: number, holdLike = false): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return false;
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    return true;
  let at = info.mtimeMs;
  let pid: number | undefined;
  if (info.size && info.size <= 128) {
    try {
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const marker = JSON.parse(readFileSync(fd, "utf8"));
        if (Number.isSafeInteger(marker?.at) && marker.at >= 0) at = marker.at;
        if (
          Number.isInteger(marker?.pid) &&
          marker.pid > 0 &&
          marker.pid <= 0x7fffffff
        )
          pid = marker.pid;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (missing(error)) return false;
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const alive = () => {
    if (pid === undefined) return undefined;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  if (holdLike && alive()) return true;
  if (now - at < abandonedAfterMs && alive() !== false) return true;
  rmSync(path, { force: true });
  return false;
}

function pruningMarker(name: string) {
  return name === ".pruning" || name.startsWith(".pruning-");
}

function invocationJournal(name: string) {
  const end = name.indexOf(".");
  return (
    end > 0 &&
    uuidPattern.test(name.slice(0, end)) &&
    [".environment.started.json", ".environment.finished.json"].includes(
      name.slice(end),
    )
  );
}

function sweep(
  parent: string,
  now: number,
  isDirectory: (name: string) => boolean,
  isFile: (name: string) => boolean = () => false,
) {
  let removed = false;
  for (const name of readdirSync(parent)) {
    const directory = isDirectory(name);
    if (!directory && !isFile(name)) continue;
    const path = join(parent, name);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (
      !info ||
      now - info.mtimeMs < abandonedAfterMs ||
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.getuid && info.uid !== process.getuid())
    )
      continue;
    try {
      if (directory && realpathSync(path) !== path) continue;
      rmSync(path, { recursive: directory, force: true });
      removed = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  if (removed) syncDirectory(parent);
}

function privateEntry(path: string, directory: boolean) {
  const file = lstatSync(path);
  if (
    (directory
      ? !file.isDirectory() || realpathSync(path) !== path
      : !file.isFile()) ||
    (file.mode & 0o077) !== 0 ||
    (process.getuid && file.uid !== process.getuid())
  )
    throw new EnvironmentError();
  return file;
}

function manifest(value: unknown): EnvironmentManifest {
  const entry = value as EnvironmentManifest;
  if (
    !entry ||
    !digestPattern.test(entry.key) ||
    !digestPattern.test(entry.profileDigest) ||
    typeof entry.adapter !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(entry.adapter) ||
    typeof entry.createdAt !== "string" ||
    new Date(entry.createdAt).toISOString() !== entry.createdAt ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    typeof entry.hasLock !== "boolean" ||
    !Array.isArray(entry.packages) ||
    entry.packages.length > maxEnvironmentPackages ||
    !entry.packages.every(validPackage)
  )
    throw new EnvironmentError();
  return entry;
}

export class EnvironmentStore {
  readonly directory: string;
  readonly #state: string;
  readonly #root: string;
  readonly #entries: string;

  constructor(targetId: string, env = process.env) {
    if (!/^[a-f0-9]{12}$/.test(targetId)) throw new EnvironmentError();
    this.#state = userStateDirectory(env);
    this.#root = join(this.#state, "environments");
    this.directory = join(this.#root, targetId);
    this.#entries = join(this.directory, "entries");
  }

  prepare() {
    for (const path of [this.#state, this.#root, this.directory, this.#entries])
      privateDirectory(path);
  }

  /** Reserve the target through Provisioner teardown, regardless of cache key. */
  tryLockBuild(): (() => void) | undefined {
    this.prepare();
    const name = `.build-${randomUUID()}`;
    const path = join(this.directory, name);
    writeMarker(path);
    const release = () => rmSync(path, { force: true });
    let acquired = false;
    try {
      const now = Date.now();
      // Publish before checking for contenders. Unique names let concurrent
      // stale-marker cleanup leave new claims alone.
      acquired = !readdirSync(this.directory).some(
        (other) =>
          other !== name &&
          other.startsWith(".build-") &&
          activeMarker(join(this.directory, other), now, true),
      );
      if (acquired) return release;
    } finally {
      if (!acquired) release();
    }
  }

  #entry(key: string) {
    if (!digestPattern.test(key)) throw new EnvironmentError();
    return join(this.#entries, key);
  }

  get(key: string): EnvironmentManifest | undefined {
    const entry = this.#entry(key);
    try {
      privateEntry(entry, true);
    } catch (error) {
      if (missing(error)) return;
      throw new EnvironmentError();
    }
    try {
      for (const path of [
        this.#state,
        this.#root,
        this.directory,
        this.#entries,
      ])
        privateEntry(path, true);
      const path = join(entry, "manifest.json");
      if (privateEntry(path, false).size > 32 * 1024 * 1024)
        throw new EnvironmentError();
      const value = manifest(JSON.parse(readFileSync(path, "utf8")));
      if (
        value.key !== key ||
        privateEntry(join(entry, "outputs.tar"), false).size !== value.size
      )
        throw new EnvironmentError();
      return value;
    } catch (error) {
      if (missing(error) && !lstatSync(entry, { throwIfNoEntry: false }))
        return;
      throw new EnvironmentError();
    }
  }

  list(): EnvironmentManifest[] {
    let names: string[];
    try {
      names = readdirSync(this.#entries);
    } catch (error) {
      if (missing(error)) return [];
      throw new EnvironmentError();
    }
    return names
      .filter((key) => digestPattern.test(key))
      .flatMap((key) => {
        const value = this.get(key);
        return value ? [value] : [];
      })
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key),
      );
  }

  async publish(
    value: EnvironmentManifest,
    bytes: Uint8Array,
  ): Promise<EnvironmentManifest> {
    try {
      manifest(value);
      if (value.size !== bytes.length) throw new EnvironmentError();
      this.prepare();
      const current = this.get(value.key);
      if (current) return current;
      const stage = join(this.#entries, `.entry-${randomUUID()}`);
      mkdirSync(stage, { mode: 0o700 });
      try {
        await publishPrivateFile(stage, "outputs.tar", bytes);
        await publishPrivateFile(stage, "manifest.json", JSON.stringify(value));
        try {
          renameSync(stage, this.#entry(value.key));
        } catch {
          const winner = this.get(value.key);
          if (winner) return winner;
          throw new EnvironmentError();
        }
        syncDirectory(this.#entries);
        return value;
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    } catch {
      throw new EnvironmentError();
    }
  }

  /** Read under a hold. Callers validate these bytes against the current layout. */
  readArchive(key: string): Uint8Array {
    const manifest = this.get(key);
    if (!manifest || manifest.size > environmentArchiveLimit)
      throw new EnvironmentError();
    try {
      const fd = openSync(
        join(this.#entry(key), "outputs.tar"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          (process.getuid && info.uid !== process.getuid()) ||
          (info.mode & 0o777) !== 0o600 ||
          info.size !== manifest.size
        )
          throw new EnvironmentError();
        const bytes = Buffer.alloc(info.size);
        for (let offset = 0; offset < bytes.length;) {
          const length = readSync(
            fd,
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!length) throw new EnvironmentError();
          offset += length;
        }
        if (fstatSync(fd).size !== info.size) throw new EnvironmentError();
        return bytes;
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new EnvironmentError();
    }
  }

  hold(key: string): () => void {
    if (!this.get(key)) throw new EnvironmentError();
    const entry = this.#entry(key);
    const hold = join(entry, `hold-${randomUUID()}`);
    try {
      writeMarker(hold);
      try {
        const now = Date.now();
        if (
          readdirSync(entry).some(
            (name) =>
              pruningMarker(name) && activeMarker(join(entry, name), now),
          ) ||
          !lstatSync(hold, { throwIfNoEntry: false })
        )
          throw new EnvironmentError();
      } catch (error) {
        rmSync(hold, { force: true });
        throw error;
      }
    } catch {
      throw new EnvironmentError();
    }
    return () => rmSync(hold, { force: true });
  }

  prune({ keep, maxAgeMs, now = Date.now() }: PruneOptions = {}): string[] {
    if (
      (keep !== undefined && (!Number.isSafeInteger(keep) || keep < 0)) ||
      (maxAgeMs !== undefined &&
        (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0))
    )
      throw new EnvironmentError();
    const removed: string[] = [];
    try {
      for (const path of [this.#state, this.#root, this.directory])
        privateEntry(path, true);
      sweep(
        this.directory,
        now,
        (name) => name.startsWith(".provision-"),
        invocationJournal,
      );
      privateEntry(this.#entries, true);
    } catch (error) {
      if (missing(error)) return removed;
      throw new EnvironmentError();
    }
    sweep(
      this.#entries,
      now,
      (name) => name.startsWith(".entry-") || name.startsWith(".discard-"),
    );
    const entries = this.list();
    for (const [index, value] of entries.entries()) {
      const old =
        maxAgeMs !== undefined && now - Date.parse(value.createdAt) >= maxAgeMs;
      const excess = index >= (keep ?? (maxAgeMs === undefined ? 3 : Infinity));
      if (!old && !excess) continue;
      const entry = this.#entry(value.key);
      // Unique names let stale markers be removed without deleting a
      // replacement claimed by a concurrent prune.
      const markerName = `.pruning-${randomUUID()}`;
      const marker = join(entry, markerName);
      try {
        writeMarker(marker);
      } catch (error) {
        if (
          missing(error) ||
          (error as NodeJS.ErrnoException).code === "EEXIST"
        )
          continue;
        throw new EnvironmentError();
      }
      // Hold and prune both publish before checking for concurrent claims.
      // Moving the entry hides it from concurrent readers before deletion.
      let moved = false;
      try {
        if (
          readdirSync(entry).some(
            (name) =>
              name !== markerName &&
              (name.startsWith("hold-") || pruningMarker(name)) &&
              activeMarker(join(entry, name), now, name.startsWith("hold-")),
          ) ||
          this.get(value.key)?.createdAt !== value.createdAt ||
          !lstatSync(marker, { throwIfNoEntry: false })
        )
          continue;
        const discarded = join(this.#entries, `.discard-${randomUUID()}`);
        renameSync(entry, discarded);
        moved = true;
        removed.push(value.key);
        rmSync(discarded, { recursive: true, force: true });
      } catch (error) {
        if (!missing(error)) throw new EnvironmentError();
      } finally {
        if (!moved) rmSync(marker, { force: true });
      }
    }
    if (removed.length) syncDirectory(this.#entries);
    return removed;
  }
}
