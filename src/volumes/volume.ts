import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { privatePath, type VolumeDefinition } from "../config/layers.ts";
import { validKeychainService } from "../credentials.ts";

type Binding = string | number | null;
interface Connection {
  run(sql: string, args?: Binding[]): { changes: number };
  query<T>(sql: string): { get(...args: Binding[]): T | null; all(): T[] };
  transaction<T>(effect: () => T): { immediate(): T };
  close(): void;
}
const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as {
  Database: new (filename: string, options: { strict: boolean }) => Connection;
};

export class VolumeError extends Error {
  readonly code: "config-invalid" | "volume-detached" | "mount-busy";
  constructor(code: VolumeError["code"]) {
    super(code);
    this.code = code;
  }
}

export type LeaseMode = "ro" | "rw";
export type LeaseHolder =
  "operator shell" | "Concierge" | "Planner" | "Executor" | "Reviewer";

export class MountBusy extends VolumeError {
  readonly next: string;
  constructor(holder?: LeaseHolder) {
    super("mount-busy");
    this.next =
      holder === "operator shell"
        ? "Wait for the operator shell to exit, then retry."
        : holder
          ? `Wait for the ${holder} run to finish, then retry.`
          : "Wait for the volume operation to finish, then retry.";
  }
}

interface Result {
  status: number | null;
  stdout: Buffer;
}
export type VolumeCommand = (
  file: string,
  args: string[],
  input?: Buffer,
) => Result;

const security = "/usr/bin/security";
const disk = "/usr/bin/hdiutil";
const plutil = "/usr/bin/plutil";
const systemCommand: VolumeCommand = (file, args, input) =>
  spawnSync(file, args, {
    ...(input ? { input } : {}),
    stdio: [input ? "pipe" : "ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o7777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw new VolumeError("config-invalid");
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
type VolumeState = { mounted: boolean; stale: boolean; active: number };
type DiskImage = {
  "image-path"?: string;
  "system-entities"?: { "mount-point"?: string }[];
};

function diskImages(run: VolumeCommand): DiskImage[] {
  const result = run(disk, ["info", "-plist"]);
  if (result.status !== 0) throw new VolumeError("volume-detached");
  // DiskImages may include aliases and timestamps, which JSON cannot represent.
  const plist = result.stdout
    .toString()
    .replace(/<data>[\s\S]*?<\/data>|<date>[^<]*<\/date>/g, "<string/>");
  const json = run(
    plutil,
    ["-convert", "json", "-o", "-", "-"],
    Buffer.from(plist),
  );
  if (json.status !== 0) throw new VolumeError("volume-detached");
  const { images } = JSON.parse(json.stdout.toString()) as {
    images: DiskImage[];
  };
  if (!Array.isArray(images)) throw new VolumeError("volume-detached");
  return images;
}

export function assertDetachedImages(
  paths: readonly string[],
  run = systemCommand,
) {
  if (
    paths.length &&
    process.platform === "darwin" &&
    diskImages(run).some(
      (image) =>
        image["image-path"] !== undefined &&
        (paths.includes(image["image-path"]) ||
          paths.includes(realpathSyncIfPresent(image["image-path"]))),
    )
  )
    throw new VolumeError("volume-detached");
}

function realpathSyncIfPresent(path: string) {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
}

export class Volume {
  readonly #config: VolumeDefinition;
  readonly #run: VolumeCommand;
  readonly #root: string;
  readonly #state: string;
  readonly #account: string;
  readonly mount: string;

  constructor(
    config: VolumeDefinition,
    state: string,
    run = systemCommand,
    account = userInfo().username,
  ) {
    this.#config = { ...config };
    this.#state = state;
    this.#run = run;
    this.#account = account;
    if (
      !validKeychainService(account) ||
      !validKeychainService(config.keychainService)
    )
      throw new VolumeError("config-invalid");
    this.#root = join(state, "volumes", sha256(config.image).slice(0, 24));
    this.mount = join(this.#root, "volume");
    if (/[\0:=,\r\n]/.test(this.mount)) throw new VolumeError("config-invalid");
  }

  #locked<T>(effect: (db: Connection) => T, busyTimeout = 45_000): T {
    privatePath(this.#root, this.#state, true);
    const lock = join(this.#root, "lock.sqlite");
    closeSync(
      openSync(
        lock,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      ),
    );
    const info = lstatSync(lock);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600
    )
      throw new VolumeError("config-invalid");
    const db = new Database(lock, { strict: true });
    try {
      db.run(`PRAGMA busy_timeout = ${busyTimeout}`);
      return db
        .transaction(() => {
          db.run(
            "CREATE TABLE IF NOT EXISTS lease (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, dir TEXT, mode TEXT, holder TEXT)",
          );
          return effect(db);
        })
        .immediate();
    } finally {
      db.close();
    }
  }

  #mounted(): boolean {
    const images = diskImages(this.#run);
    let mounted = false;
    for (const image of images) {
      const entities = image["system-entities"] ?? [];
      const matchesMount = entities.some(
        (entity) => entity["mount-point"] === this.mount,
      );
      const imagePath = image["image-path"];
      const matchesImage =
        imagePath === this.#config.image ||
        (matchesMount &&
          imagePath !== undefined &&
          realpathSyncIfPresent(imagePath) === this.#config.image);
      if (matchesMount !== matchesImage)
        throw new VolumeError("volume-detached");
      mounted ||= matchesMount;
    }
    return mounted;
  }

  #leases(db: Connection) {
    const leases = db
      .query<{ id: string; pid: number }>("SELECT id, pid FROM lease")
      .all();
    const dead = leases.filter(({ pid }) => {
      if (pid === 0) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    return {
      dead,
      active: leases.length - dead.length,
      manual: leases.some(({ pid }) => pid === 0),
      quarantined: leases.some(({ id }) => id.startsWith("orphan-")),
      pending: leases.some(({ id }) => id.startsWith("pending-")),
    };
  }

  status(): VolumeState {
    return this.#locked((db) => {
      const mounted = this.#mounted();
      const { dead, active, quarantined } = this.#leases(db);
      const expectedMounted = active > 0;
      return {
        mounted,
        active,
        stale: quarantined || dead.length > 0 || mounted !== expectedMounted,
      };
    });
  }

  #attach() {
    const { image, keychainService } = this.#config;
    const info = lstatSync(image, { throwIfNoEntry: false });
    if (
      !info?.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      realpathSync(image) !== image
    )
      throw new VolumeError("volume-detached");
    const encrypted = this.#run(disk, ["isencrypted", image]);
    if (
      encrypted.status !== 0 ||
      !/^encrypted:\s*YES\s*$/im.test(encrypted.stdout.toString())
    )
      throw new VolumeError("config-invalid");
    privateDirectory(this.mount);
    const key = this.#run(security, [
      "find-generic-password",
      "-a",
      this.#account,
      "-s",
      keychainService,
      "-w",
    ]);
    let input: Buffer | undefined;
    try {
      const passphrase = key.stdout.subarray(
        0,
        key.stdout.at(-1) === 10 ? -1 : undefined,
      );
      if (
        key.status !== 0 ||
        !passphrase.length ||
        passphrase.length > 1024 ||
        passphrase.includes(0) ||
        passphrase.includes(10) ||
        passphrase.includes(13)
      )
        throw new VolumeError("volume-detached");
      input = Buffer.concat([passphrase, Buffer.from([0])]);
      const result = this.#run(
        disk,
        [
          "attach",
          "-stdinpass",
          "-nobrowse",
          "-owners",
          "on",
          "-mountpoint",
          this.mount,
          image,
        ],
        input,
      );
      if (result.status !== 0 || !this.#mounted())
        throw new VolumeError("volume-detached");
    } finally {
      key.stdout.fill(0);
      input?.fill(0);
    }
  }

  #detach() {
    if (this.#run(disk, ["detach", this.mount]).status !== 0)
      throw new VolumeError("volume-detached");
  }

  attach() {
    this.#locked((db) => {
      const { dead, active, quarantined, pending } = this.#leases(db);
      const mounted = this.#mounted();
      const expectedMounted = active > 0;
      if (dead.length || quarantined || pending || mounted !== expectedMounted)
        throw new VolumeError("volume-detached");
      if (!mounted) this.#attach();
      db.run("INSERT OR IGNORE INTO lease (id, pid) VALUES ('manual', 0)");
    });
  }

  detach(force = false) {
    this.#locked((db) => {
      const { active, manual, dead, quarantined } = this.#leases(db);
      const liveRuns =
        active -
        Number(manual) -
        db
          .query<{ id: string }>(
            "SELECT id FROM lease WHERE id LIKE 'orphan-%'",
          )
          .all()
          .filter(({ id }) => !dead.some((lease) => lease.id === id)).length;
      const mounted = this.#mounted();
      const expectedMounted = active > 0;
      const stale = dead.length || quarantined || mounted !== expectedMounted;
      if (liveRuns || (stale && !force))
        throw new VolumeError("volume-detached");
      if (mounted) this.#detach();
      db.run("DELETE FROM lease");
    });
  }

  async acquire(
    dir: string,
    mode: LeaseMode,
    holder: LeaseHolder,
    ensureAudit: () => void,
    deadline = performance.now() + 30_000,
    ensureOwnership?: () => void,
  ) {
    const id = randomUUID();
    const pendingId = `pending-${id}`;
    let holderWaitingOn: LeaseHolder | undefined;
    let waited = false;
    const timeout = () => {
      throw new MountBusy(holderWaitingOn);
    };
    for (;;) {
      ensureAudit();
      if (waited && performance.now() >= deadline) timeout();
      try {
        const conflict = this.#locked(
          (db) => {
            const { dead, active, quarantined } = this.#leases(db);
            if (dead.length || quarantined)
              throw new VolumeError("volume-detached");
            const conflict = db
              .query<{ holder: LeaseHolder }>(
                "SELECT holder FROM lease WHERE dir = ? AND (mode = 'rw' OR ? = 'rw' OR id LIKE 'pending-%') LIMIT 1",
              )
              .get(dir, mode);
            if (conflict) return conflict;
            if (waited && performance.now() >= deadline) timeout();
            const mounted = this.#mounted();
            const expectedMounted = active > 0;
            if (mounted !== expectedMounted)
              throw new VolumeError("volume-detached");
            ensureOwnership?.();
            ensureAudit();
            if (!mounted) this.#attach();
            db.run(
              "INSERT INTO lease (id, pid, dir, mode, holder) VALUES (?, ?, ?, ?, ?)",
              [id, process.pid, dir, mode, holder],
            );
            db.run("DELETE FROM lease WHERE pid = 0");
            return null;
          },
          Math.max(0, Math.min(100, Math.floor(deadline - performance.now()))),
        );
        if (!conflict) break;
        holderWaitingOn = conflict.holder;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !String((error as NodeJS.ErrnoException).code).startsWith(
            "SQLITE_BUSY",
          )
        )
          throw error;
      }
      waited = true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) timeout();
      await delay(Math.min(100, remaining));
    }
    const update = (from: string, to: string) =>
      this.#locked((db) => {
        db.run("UPDATE lease SET id=? WHERE id=?", [to, from]);
      });
    return {
      prepare: () => update(id, pendingId),
      ready: () => update(pendingId, id),
      release: () => {
        const detachFailed = this.#locked((db) => {
          const removed = db.run("DELETE FROM lease WHERE id IN (?, ?)", [
            id,
            pendingId,
          ]).changes;
          const { active, dead, quarantined } = this.#leases(db);
          if (
            !removed ||
            active ||
            dead.length ||
            quarantined ||
            !this.#mounted()
          )
            return false;
          try {
            this.#detach();
            return false;
          } catch {
            return true;
          }
        });
        if (detachFailed) throw new VolumeError("volume-detached");
      },
      quarantine: () =>
        this.#locked((db) => {
          db.run("UPDATE lease SET id=? WHERE id IN (?, ?)", [
            `orphan-${id}`,
            id,
            pendingId,
          ]);
        }),
    };
  }

  init() {
    const { image, keychainService } = this.#config;
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    this.#locked(() => {
      if (
        uid === undefined ||
        gid === undefined ||
        lstatSync(image, { throwIfNoEntry: false }) ||
        realpathSync(dirname(image)) !== dirname(image)
      )
        throw new VolumeError("config-invalid");
      const probe = this.#run(security, [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        keychainService,
      ]);
      if (probe.status !== 44) throw new VolumeError("config-invalid");
      const passphrase = randomBytes(32).toString("hex");
      const command = Buffer.from(
        `add-generic-password -a ${this.#account} -s ${keychainService} -w ${passphrase}\n`,
      );
      const input = Buffer.from(passphrase + "\0");
      try {
        if (this.#run(security, ["-i"], command).status !== 0)
          throw new VolumeError("config-invalid");
        // The create command has no credential in its argv.
        if (
          this.#run(
            disk,
            [
              "create",
              "-size",
              "512m",
              "-fs",
              "APFS",
              "-uid",
              String(uid),
              "-gid",
              String(gid),
              "-mode",
              "0700",
              "-type",
              "SPARSE",
              "-volname",
              "agent-bootstrap",
              "-encryption",
              "AES-256",
              "-stdinpass",
              image,
            ],
            input,
          ).status !== 0
        ) {
          if (!lstatSync(image, { throwIfNoEntry: false }))
            this.#run(security, [
              "delete-generic-password",
              "-a",
              this.#account,
              "-s",
              keychainService,
            ]);
          throw new VolumeError("config-invalid");
        }
      } finally {
        input.fill(0);
        command.fill(0);
      }
    });
  }

  directory(dir: string, create = false): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(dir))
      throw new VolumeError("config-invalid");
    if (!this.#mounted()) throw new VolumeError("volume-detached");
    checkMountDirectory(this.mount);
    const path = join(this.mount, dir);
    if (create && !lstatSync(path, { throwIfNoEntry: false }))
      mkdirSync(path, { mode: 0o700 });
    return checkMountDirectory(path);
  }
}

export function checkMountDirectory(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (
    !info?.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o7777) !== 0o700
  )
    throw new VolumeError("config-invalid");
  return realpathSync(path);
}
