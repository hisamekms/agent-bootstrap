import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  privatePath,
  projectName,
  type VolumeDefinition,
} from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
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
  readonly next: string;
  readonly subject: string;
  readonly reason: string;

  constructor(
    code: VolumeError["code"],
    subject: string,
    reason: string,
    next: string,
  ) {
    super(`${subject}: ${reason}`);
    this.code = code;
    this.next = next;
    this.subject = subject;
    this.reason = reason;
  }
}

export type LeaseMode = "ro" | "rw";
export type LeaseHolder =
  "operator shell" | "Concierge" | "Planner" | "Executor" | "Reviewer";

export class MountBusy extends VolumeError {
  constructor(subject: string, holder?: LeaseHolder) {
    super(
      "mount-busy",
      subject,
      "The mount is busy.",
      holder === "operator shell"
        ? "Wait for the operator shell to exit, then retry."
        : holder === "Concierge" ||
            holder === "Planner" ||
            holder === "Executor" ||
            holder === "Reviewer"
          ? `Wait for the ${holder} run to finish, then retry.`
          : "Wait for the volume operation to finish, then retry.",
    );
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

export function privateDirectory(
  path: string,
  subject = "Private state directory",
) {
  if (!lstatSync(path, { throwIfNoEntry: false }))
    mkdirSync(path, { recursive: true, mode: 0o700 });
  if (checkMountDirectory(path, subject) !== path)
    throw new VolumeError(
      "config-invalid",
      subject,
      "A parent directory is a symbolic link.",
      "Use a state directory with no symbolic links and retry.",
    );
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
type VolumeState = { mounted: boolean; stale: boolean; active: number };
type DiskEntity = { "mount-point"?: string; "dev-entry"?: string };
type DiskImage = {
  "image-path"?: string;
  "system-entities"?: DiskEntity[];
};

function diskImages(run: VolumeCommand): DiskImage[] {
  const unavailable = () =>
    new VolumeError(
      "volume-detached",
      "Volume attachments",
      "macOS could not report the disk image attachments.",
      "Check Disk Utility for disk image errors, then retry.",
    );
  const result = run(disk, ["info", "-plist"]);
  if (result.status !== 0) throw unavailable();
  // DiskImages may include aliases and timestamps, which JSON cannot represent.
  const plist = result.stdout
    .toString()
    .replace(/<data>[\s\S]*?<\/data>|<date>[^<]*<\/date>/g, "<string/>");
  const json = run(
    plutil,
    ["-convert", "json", "-o", "-", "-"],
    Buffer.from(plist),
  );
  if (json.status !== 0) throw unavailable();
  try {
    const { images } = JSON.parse(json.stdout.toString()) as {
      images: DiskImage[];
    };
    if (Array.isArray(images)) return images;
  } catch {}
  throw unavailable();
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
    throw new VolumeError(
      "volume-detached",
      "Volume migration",
      "A volume is still attached.",
      "Detach all volumes involved in the migration and retry.",
    );
}

function realpathSyncIfPresent(path: string) {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
}

type MountIdentity = Pick<Stats, "dev" | "uid" | "isDirectory">;
interface VolumeMountIo {
  deviceNumber(path: string): number | undefined;
  rootStat(fd: number): MountIdentity;
}

const systemMountIo: VolumeMountIo = {
  deviceNumber(path) {
    const info = statSync(path, { throwIfNoEntry: false });
    return info?.isBlockDevice() ? info.rdev : undefined;
  },
  rootStat: fstatSync,
};

export class Volume {
  readonly #config: VolumeDefinition;
  readonly #run: VolumeCommand;
  readonly #root: string;
  readonly #state: string;
  readonly #account: string;
  readonly #volumeName: string | undefined;
  readonly #subject: string;
  readonly #mountIo: VolumeMountIo;
  readonly mount: string;

  constructor(
    config: VolumeDefinition,
    state: string,
    run = systemCommand,
    options: { volume?: string; mount?: string; mountIo?: VolumeMountIo } = {},
  ) {
    const account = userInfo().username;
    this.#mountIo = options.mountIo ?? systemMountIo;
    this.#config = { ...config };
    this.#state = state;
    this.#run = run;
    this.#account = account;
    this.#volumeName =
      options.volume && projectName.test(options.volume)
        ? options.volume
        : undefined;
    this.#subject =
      options.mount && projectName.test(options.mount)
        ? `Mount "${options.mount}"`
        : this.#volumeName
          ? `Volume "${this.#volumeName}"`
          : "Volume";
    if (
      !validKeychainService(account) ||
      !validKeychainService(config.keychainService)
    )
      throw this.#error(
        "config-invalid",
        "The Keychain account or service name is invalid.",
        "Check the volume's Keychain configuration.",
      );
    this.#root = join(state, "volumes", sha256(config.image).slice(0, 24));
    this.mount = join(this.#root, "volume");
    if (/[\0:=,\r\n]/.test(this.mount))
      throw this.#error(
        "config-invalid",
        "The state location contains characters unsupported by the mount backend.",
        "Choose a different state directory and retry.",
      );
  }

  #error(code: VolumeError["code"], reason: string, next: string) {
    return new VolumeError(code, this.#subject, reason, next);
  }

  #recoverAttachment() {
    const name = this.#volumeName ?? "<volume>";
    return `Run agent-bootstrap volume status ${name}. If state is stale, confirm no VM is running before using agent-bootstrap volume detach ${name} --force.`;
  }

  #detached(reason: string) {
    return this.#error("volume-detached", reason, this.#recoverAttachment());
  }

  #locked<T>(effect: (db: Connection) => T, busyTimeout = 45_000): T {
    try {
      privatePath(this.#root, this.#state, true);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw this.#error(
        "config-invalid",
        "The volume state directory is unsafe.",
        "Check that the state directories are user-owned, have mode 0700, and contain no symbolic links.",
      );
    }
    const lock = join(this.#root, "lock.sqlite");
    const unsafeLock = () =>
      this.#error(
        "config-invalid",
        "The volume lock could not be opened as a private file owned by the current user.",
        "Check the volume state directory and restore a regular lock file with mode 0600, no symbolic link, and no additional hard links.",
      );
    try {
      closeSync(
        openSync(
          lock,
          constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        ),
      );
    } catch {
      throw unsafeLock();
    }
    const info = lstatSync(lock, { throwIfNoEntry: false });
    if (
      !info?.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o7777) !== 0o600
    )
      throw unsafeLock();
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

  #mounted(): DiskEntity | undefined {
    let images: DiskImage[];
    try {
      images = diskImages(this.#run);
    } catch (error) {
      if (!(error instanceof VolumeError)) throw error;
      throw this.#error(
        error.code,
        "macOS could not report the disk image attachments.",
        error.next,
      );
    }
    let mounted: DiskEntity | undefined;
    for (const image of images) {
      const entities = image["system-entities"] ?? [];
      const entity = entities.find(
        (entity) => entity["mount-point"] === this.mount,
      );
      const matchesMount = entity !== undefined;
      const imagePath = image["image-path"];
      const matchesImage =
        imagePath === this.#config.image ||
        (matchesMount &&
          imagePath !== undefined &&
          realpathSyncIfPresent(imagePath) === this.#config.image);
      if (matchesMount !== matchesImage)
        throw this.#detached(
          "The image and its expected mount point do not match the reported attachment.",
        );
      mounted ??= entity;
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
      const mounted = this.#mounted() !== undefined;
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
      throw this.#error(
        "volume-detached",
        "The image is missing or is not a private, user-owned image file.",
        `Check the image file or initialize a new volume with agent-bootstrap volume init ${this.#volumeName ?? "<volume>"}.`,
      );
    const encrypted = this.#run(disk, ["isencrypted", image]);
    if (
      encrypted.status !== 0 ||
      !/^encrypted:\s*YES\s*$/im.test(encrypted.stdout.toString())
    )
      throw this.#error(
        "config-invalid",
        "The disk image could not be verified as encrypted.",
        "Configure a user-owned encrypted APFS image and retry.",
      );
    privateDirectory(this.mount, `${this.#subject} mount point`);
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
        throw this.#error(
          "volume-detached",
          "The volume passphrase could not be read from Keychain.",
          "Unlock the login Keychain and check the volume's Keychain item.",
        );
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
      if (result.status !== 0)
        throw this.#detached(
          "macOS could not attach the encrypted disk image.",
        );
      const entity = this.#mounted();
      if (!entity) throw this.#detached("The disk image is detached.");
      const device = entity["dev-entry"];
      if (!device || !/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(device))
        throw this.#detached("macOS did not identify the mounted device.");
      try {
        this.#privatizeRoot(device);
      } catch (error) {
        // Detach by device so a replaced mount path cannot redirect cleanup.
        const cleanup = this.#run(disk, ["detach", device]);
        if (cleanup.status !== 0 && error instanceof VolumeError)
          throw new VolumeError(
            error.code,
            error.subject,
            `${error.reason} macOS could not detach the image after this failure.`,
            this.#recoverAttachment(),
          );
        throw error;
      }
    } finally {
      key.stdout.fill(0);
      input?.fill(0);
    }
  }

  #privatizeRoot(device: string) {
    const subject = `${this.#subject} root`;
    const permissions =
      "Check the mounted root on the host. Restore ownership to the current user and run chmod 700 on the root directory.";
    let fd: number | undefined;
    try {
      fd = openSync(
        this.mount,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const info = this.#mountIo.rootStat(fd);
      if (!info.isDirectory())
        throw new VolumeError(
          "config-invalid",
          subject,
          "The root is not a directory.",
          "Restore the volume mount point as a directory and retry.",
        );
      if (info.uid !== process.getuid?.())
        throw new VolumeError(
          "config-invalid",
          subject,
          "The directory is not owned by the current user.",
          permissions,
        );
      if (info.dev !== this.#mountIo.deviceNumber(device))
        throw this.#detached("The root is not on the expected mounted device.");
      fchmodSync(fd, 0o700);
    } catch (error) {
      if (error instanceof VolumeError) throw error;
      // Diagnose a refused open without following or changing a link.
      if (fd === undefined)
        checkDirectoryIdentity(
          lstatSync(this.mount, { throwIfNoEntry: false }),
          subject,
        );
      throw new VolumeError(
        "config-invalid",
        subject,
        "The directory could not be opened or made private.",
        permissions,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  #detach() {
    if (this.#run(disk, ["detach", this.mount]).status !== 0)
      throw this.#detached("macOS could not detach the disk image.");
  }

  attach() {
    this.#locked((db) => {
      const { dead, active, quarantined, pending } = this.#leases(db);
      const mounted = this.#mounted() !== undefined;
      const expectedMounted = active > 0;
      if (dead.length || quarantined || pending || mounted !== expectedMounted)
        throw this.#detached("The volume has a stale attachment or lease.");
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
      const mounted = this.#mounted() !== undefined;
      const expectedMounted = active > 0;
      const stale = dead.length || quarantined || mounted !== expectedMounted;
      if (liveRuns)
        throw this.#error(
          "volume-detached",
          "A run still holds a volume lease.",
          "Wait for active runs and operator shells to exit before detaching.",
        );
      if (stale && !force)
        throw this.#detached("The volume has a stale attachment or lease.");
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
      throw new MountBusy(this.#subject, holderWaitingOn);
    };
    for (;;) {
      ensureAudit();
      if (waited && performance.now() >= deadline) timeout();
      try {
        const conflict = this.#locked(
          (db) => {
            const { dead, active, quarantined } = this.#leases(db);
            if (dead.length || quarantined)
              throw this.#detached(
                "The volume has a stale attachment or lease.",
              );
            const conflict = db
              .query<{ holder: LeaseHolder }>(
                "SELECT holder FROM lease WHERE dir = ? AND (mode = 'rw' OR ? = 'rw' OR id LIKE 'pending-%') LIMIT 1",
              )
              .get(dir, mode);
            if (conflict) return conflict;
            if (waited && performance.now() >= deadline) timeout();
            const mounted = this.#mounted() !== undefined;
            const expectedMounted = active > 0;
            if (mounted !== expectedMounted)
              throw this.#detached(
                "The volume has a stale attachment or lease.",
              );
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
        if (detachFailed)
          throw this.#detached(
            "macOS could not detach the disk image after the last lease ended.",
          );
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
    this.#locked((db) => {
      const leases = this.#leases(db);
      if (leases.active || leases.dead.length)
        throw this.#detached("The volume already has a lease.");
      if (this.#mounted())
        throw this.#detached("The disk image is already attached.");
      if (
        uid === undefined ||
        gid === undefined ||
        lstatSync(image, { throwIfNoEntry: false }) ||
        !lstatSync(dirname(image), { throwIfNoEntry: false })?.isDirectory() ||
        realpathSync(dirname(image)) !== dirname(image)
      )
        throw this.#error(
          "config-invalid",
          "The image already exists or its parent is unavailable.",
          "Choose an unused image location in an existing directory.",
        );
      const probe = this.#run(security, [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        keychainService,
      ]);
      if (probe.status !== 44)
        throw this.#error(
          "config-invalid",
          "The Keychain item already exists or Keychain could not be checked.",
          "Unlock the login Keychain and choose an unused volume Keychain item.",
        );
      const passphrase = randomBytes(32).toString("hex");
      const command = Buffer.from(
        `add-generic-password -a ${this.#account} -s ${keychainService} -w ${passphrase}\n`,
      );
      const input = Buffer.from(passphrase + "\0");
      try {
        if (this.#run(security, ["-i"], command).status !== 0)
          throw this.#error(
            "config-invalid",
            "The passphrase could not be saved in Keychain.",
            "Unlock the login Keychain and retry.",
          );
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
          throw this.#error(
            "config-invalid",
            "macOS could not create the encrypted APFS image.",
            "Check available disk space and directory permissions, then retry.",
          );
        }
      } finally {
        input.fill(0);
        command.fill(0);
      }
      this.#attach();
      this.#detach();
    });
  }

  directory(dir: string, create = false): string {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(dir))
      throw this.#error(
        "config-invalid",
        "The mount directory name is invalid.",
        "Check the mount directory declaration and retry.",
      );
    if (!this.#mounted()) throw this.#detached("The disk image is detached.");
    checkMountDirectory(this.mount, `${this.#subject} root`);
    const path = join(this.mount, dir);
    if (create && !lstatSync(path, { throwIfNoEntry: false }))
      mkdirSync(path, { mode: 0o700 });
    return checkMountDirectory(path, `${this.#subject} directory`);
  }
}

function checkDirectoryIdentity(info: Stats | undefined, subject: string) {
  if (info?.isSymbolicLink())
    throw new VolumeError(
      "config-invalid",
      subject,
      "The directory is a symbolic link.",
      "Replace the link with a real directory and retry.",
    );
  if (!info?.isDirectory())
    throw new VolumeError(
      "config-invalid",
      subject,
      "The directory is missing or is not a directory.",
      "Create a directory with mode 0700 at the configured location and retry.",
    );
  if (info.uid !== process.getuid?.())
    throw new VolumeError(
      "config-invalid",
      subject,
      "The directory is not owned by the current user.",
      "Restore ownership of the directory to the current user on the host and retry.",
    );
  return info;
}

export function checkMountDirectory(path: string, subject = "Mount directory") {
  const info = checkDirectoryIdentity(
    lstatSync(path, { throwIfNoEntry: false }),
    subject,
  );
  if ((info.mode & 0o7777) !== 0o700)
    throw new VolumeError(
      "config-invalid",
      subject,
      "The directory must have mode 0700.",
      "Run chmod 700 on the directory on the host, then retry.",
    );
  return realpathSync(path);
}
