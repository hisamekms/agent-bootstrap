import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { CLAUDE_CODE } from "../claude-code.ts";
import {
  validService,
  type ClaudeDirectoryConfig,
  type ClaudeFailureCode,
} from "./claude-config.ts";

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

function openedPath(fd: number) {
  if (process.platform === "linux") return readlinkSync(`/proc/self/fd/${fd}`);
  if (process.platform === "darwin") {
    const { dlopen, ptr } = require("bun:ffi") as {
      ptr(buffer: Buffer): number;
      dlopen(
        path: string,
        symbols: { fgetattrlist: { args: string[]; returns: string } },
      ): {
        symbols: {
          fgetattrlist(
            fd: number,
            attrs: number,
            result: number,
            size: number,
            flags: number,
          ): number;
        };
        close(): void;
      };
    };
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      fgetattrlist: {
        args: ["int", "ptr", "ptr", "usize", "usize"],
        returns: "int",
      },
    });
    try {
      const attrs = Buffer.alloc(24);
      attrs.writeUInt16LE(5); // ATTR_BIT_MAP_COUNT
      attrs.writeUInt32LE(0x08000000, 4); // ATTR_CMN_FULLPATH
      const result = Buffer.alloc(4096);
      if (
        lib.symbols.fgetattrlist(
          fd,
          ptr(attrs),
          ptr(result),
          result.length,
          0,
        ) === 0
      ) {
        // The path follows an attrreference_t indexed from byte 4.
        const offset = 4 + result.readInt32LE(4);
        const end = offset + result.readUInt32LE(8);
        if (offset >= 12 && end <= result.length && result[end - 1] === 0)
          return result.toString("utf8", offset, end - 1);
      }
    } finally {
      lib.close();
    }
  }
  throw new ClaudeRunError("config-tampered");
}

export class ClaudeRunError extends Error {
  readonly code: ClaudeFailureCode;
  constructor(code: ClaudeFailureCode) {
    super(code);
    this.code = code;
  }
}

export class ClaudeVolumeBusy extends ClaudeRunError {
  constructor() {
    super("credentials-detached");
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
    throw new ClaudeRunError("config-invalid");
}

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const mutableFile =
  /^(?:\.credentials\.json|\.claude\.json(?:\..*)?|.*\.lock(?:\.owner)?)$/;
const mutableDirectories = new Set([
  "backups",
  "projects",
  "sessions",
  "todos",
  "statsig",
  "shell-snapshots",
]);

function integritySnapshot(path: string) {
  const entries: [string, number, string][] = [];
  let total = 0;
  let visited = 0;
  function walk(dir: string, prefix: string, mutable = false) {
    if (realpathSync(dir) !== dir) throw new ClaudeRunError("config-tampered");
    for (const name of readdirSync(dir).sort()) {
      if (++visited > 16384 || prefix.length + name.length > 1024)
        throw new ClaudeRunError("config-tampered");
      const relative = prefix + name;
      const file = join(dir, name);
      const info = lstatSync(file);
      if (info.isDirectory()) {
        const skip = mutable || (!prefix && mutableDirectories.has(name));
        if (!skip) entries.push([relative, info.mode, "directory"]);
        walk(file, relative + "/", skip);
      } else if (info.isFile() && info.nlink === 1) {
        if (mutable || (!prefix && mutableFile.test(name))) continue;
        const fd = openSync(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = fstatSync(fd);
          if (
            opened.dev !== info.dev ||
            opened.ino !== info.ino ||
            opened.nlink !== 1 ||
            openedPath(fd) !== file ||
            opened.size > 1024 * 1024
          )
            throw new ClaudeRunError("config-tampered");
          total += opened.size;
          if (total > 16 * 1024 * 1024)
            throw new ClaudeRunError("config-tampered");
          const bytes = Buffer.alloc(opened.size + 1);
          const count = readSync(fd, bytes);
          if (count !== opened.size)
            throw new ClaudeRunError("config-tampered");
          entries.push([
            relative,
            opened.mode,
            sha256(bytes.subarray(0, count)),
          ]);
        } finally {
          closeSync(fd);
        }
      } else throw new ClaudeRunError("config-tampered");
    }
  }
  walk(path, "");
  return entries;
}

type VolumeState = { mounted: boolean; stale: boolean; active: number };
type DiskImage = {
  "image-path"?: string;
  "system-entities"?: { "mount-point"?: string }[];
};

export class CredentialsVolume {
  readonly #config: ClaudeDirectoryConfig;
  readonly #run: VolumeCommand;
  readonly #root: string;
  readonly #account: string;
  readonly mount: string;

  constructor(
    config: ClaudeDirectoryConfig,
    state: string,
    run = systemCommand,
    account = userInfo().username,
  ) {
    this.#config = config;
    this.#run = run;
    this.#account = account;
    if (!validService(account)) throw new ClaudeRunError("config-invalid");
    this.#root = join(
      state,
      "credentials",
      sha256(config.volume.image).slice(0, 24),
    );
    this.mount = join(this.#root, "volume");
    if (/[\0:=,\r\n]/.test(this.mount))
      throw new ClaudeRunError("config-invalid");
  }

  #locked<T>(effect: (db: Connection) => T): T {
    privateDirectory(this.#root);
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
      throw new ClaudeRunError("config-invalid");
    const db = new Database(lock, { strict: true });
    try {
      db.run("PRAGMA busy_timeout = 45000");
      db.run(
        "CREATE TABLE IF NOT EXISTS lease (id TEXT PRIMARY KEY, pid INTEGER NOT NULL)",
      );
      db.run(
        "CREATE TABLE IF NOT EXISTS baseline (name TEXT PRIMARY KEY, digest TEXT NOT NULL, hold INTEGER NOT NULL DEFAULT 0, version TEXT)",
      );
      return db
        .transaction(() => {
          if (
            !db
              .query<{ name: string }>("PRAGMA table_info(lease)")
              .all()
              .some(({ name }) => name === "group_name")
          )
            db.run("ALTER TABLE lease ADD COLUMN group_name TEXT");
          db.run(
            "CREATE TABLE IF NOT EXISTS integrity_audit (at TEXT NOT NULL, group_name TEXT NOT NULL, event TEXT NOT NULL, evidence TEXT)",
          );
          return effect(db);
        })
        .immediate();
    } finally {
      db.close();
    }
  }

  #mounted(): boolean {
    const result = this.#run(disk, ["info", "-plist"]);
    if (result.status !== 0) throw new ClaudeRunError("credentials-detached");
    // DiskImages may include aliases and timestamps, which JSON cannot represent.
    const plist = result.stdout
      .toString()
      .replace(/<data>[\s\S]*?<\/data>|<date>[^<]*<\/date>/g, "<string/>");
    const json = this.#run(
      plutil,
      ["-convert", "json", "-o", "-", "-"],
      Buffer.from(plist),
    );
    if (json.status !== 0) throw new ClaudeRunError("credentials-detached");
    const { images } = JSON.parse(json.stdout.toString()) as {
      images: DiskImage[];
    };
    if (!Array.isArray(images))
      throw new ClaudeRunError("credentials-detached");
    let mounted = false;
    for (const image of images) {
      for (const entity of image["system-entities"] ?? []) {
        if (entity["mount-point"] === this.mount) {
          if (image["image-path"] !== this.#config.volume.image)
            throw new ClaudeRunError("credentials-detached");
          mounted = true;
        }
      }
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
    const { image, keychainService } = this.#config.volume;
    const info = lstatSync(image, { throwIfNoEntry: false });
    if (
      !info?.isFile() ||
      info.uid !== process.getuid?.() ||
      realpathSync(image) !== image
    )
      throw new ClaudeRunError("credentials-detached");
    const encrypted = this.#run(disk, ["isencrypted", image]);
    if (
      encrypted.status !== 0 ||
      !/^encrypted:\s*YES\s*$/im.test(encrypted.stdout.toString())
    )
      throw new ClaudeRunError("config-invalid");
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
        throw new ClaudeRunError("credentials-detached");
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
        throw new ClaudeRunError("credentials-detached");
    } finally {
      key.stdout.fill(0);
      input?.fill(0);
    }
  }

  #detach() {
    if (this.#run(disk, ["detach", this.mount]).status !== 0)
      throw new ClaudeRunError("credentials-detached");
  }

  attach() {
    this.#locked((db) => {
      const { dead, active, quarantined, pending } = this.#leases(db);
      const mounted = this.#mounted();
      const expectedMounted = active > 0;
      if (dead.length || quarantined || pending || mounted !== expectedMounted)
        throw new ClaudeRunError("credentials-detached");
      if (!mounted) this.#attach();
      if (!active) db.run("INSERT INTO lease (id, pid) VALUES ('manual', 0)");
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
      if (liveRuns || ((dead.length || quarantined) && !force))
        throw new ClaudeRunError("credentials-detached");
      if (this.#mounted()) this.#detach();
      db.run("DELETE FROM lease");
    });
  }

  acquire(group?: string) {
    const id = randomUUID();
    const pendingId = `pending-${id}`;
    this.#locked((db) => {
      const { dead, active, quarantined, pending } = this.#leases(db);
      if (dead.length || quarantined)
        throw new ClaudeRunError("credentials-detached");
      if (
        pending ||
        db
          .query(
            "SELECT 1 FROM lease WHERE pid != 0 AND (? IS NULL OR group_name IS NULL OR group_name = ?) LIMIT 1",
          )
          .get(group ?? null, group ?? null)
      )
        throw new ClaudeVolumeBusy();
      const mounted = this.#mounted();
      const expectedMounted = active > 0;
      if (mounted !== expectedMounted)
        throw new ClaudeRunError("credentials-detached");
      if (!mounted) this.#attach();
      db.run("INSERT INTO lease (id, pid, group_name) VALUES (?, ?, ?)", [
        id,
        process.pid,
        group ?? null,
      ]);
      db.run("DELETE FROM lease WHERE pid = 0");
    });
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
        if (detachFailed) throw new ClaudeRunError("credentials-detached");
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
    const { image, keychainService } = this.#config.volume;
    this.#locked(() => {
      if (
        lstatSync(image, { throwIfNoEntry: false }) ||
        realpathSync(dirname(image)) !== dirname(image)
      )
        throw new ClaudeRunError("config-invalid");
      const probe = this.#run(security, [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        keychainService,
      ]);
      if (probe.status !== 44) throw new ClaudeRunError("config-invalid");
      const passphrase = randomBytes(32).toString("hex");
      const command = Buffer.from(
        `add-generic-password -a ${this.#account} -s ${keychainService} -w ${passphrase}\n`,
      );
      const input = Buffer.from(passphrase + "\0");
      try {
        if (this.#run(security, ["-i"], command).status !== 0)
          throw new ClaudeRunError("config-invalid");
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
          throw new ClaudeRunError("config-invalid");
        }
      } finally {
        input.fill(0);
        command.fill(0);
      }
    });
  }

  groupPath(name: string): string {
    if (!Object.hasOwn(this.#config.groups, name))
      throw new ClaudeRunError("config-invalid");
    if (!this.#mounted()) throw new ClaudeRunError("credentials-detached");
    const path = join(this.mount, name);
    privateDirectory(path);
    return path;
  }

  integrity(
    name: string,
    phase: "before" | "after" | "accept",
    note: (message: string) => void,
    succeeded = false,
  ) {
    const evidence = this.#locked((db) => {
      const { active, quarantined, dead } = this.#leases(db);
      if (dead.length || quarantined || (phase === "accept" && active !== 1))
        throw new ClaudeRunError("credentials-detached");
      let entries: ReturnType<typeof integritySnapshot> | undefined;
      try {
        entries = integritySnapshot(this.groupPath(name));
      } catch {}
      const digest = entries && sha256(JSON.stringify(entries));
      const baseline = db
        .query<{ digest: string; hold: number; version: string | null }>(
          "SELECT digest, hold, version FROM baseline WHERE name = ?",
        )
        .get(name);
      if (
        !digest ||
        (phase !== "accept" &&
          (baseline?.hold ||
            (baseline ? baseline.digest !== digest : entries!.length > 0)))
      ) {
        const evidence = join(this.#root, `integrity-${randomUUID()}.json`);
        writeFileSync(
          evidence,
          JSON.stringify(
            {
              group: name,
              phase,
              baseline: baseline?.digest ?? null,
              digest: digest ?? null,
            },
            null,
            2,
          ),
          { mode: 0o600, flag: "wx" },
        );
        db.run(
          "INSERT INTO baseline VALUES (?, ?, 1, NULL) ON CONFLICT(name) DO UPDATE SET hold=1",
          [name, baseline?.digest ?? ""],
        );
        db.run("INSERT INTO integrity_audit VALUES (?, ?, ?, ?)", [
          new Date().toISOString(),
          name,
          "integrity-hold",
          evidence,
        ]);
        return evidence;
      }
      if (phase === "accept")
        db.run("INSERT INTO integrity_audit VALUES (?, ?, ?, NULL)", [
          new Date().toISOString(),
          name,
          "integrity-accepted",
        ]);
      if (!baseline || phase === "accept")
        db.run(
          "INSERT INTO baseline VALUES (?, ?, 0, NULL) ON CONFLICT(name) DO UPDATE SET digest=excluded.digest, hold=0",
          [name, digest],
        );
      if (succeeded)
        db.run("UPDATE baseline SET version=? WHERE name=?", [
          CLAUDE_CODE.version,
          name,
        ]);
      else if (
        phase === "after" &&
        baseline?.version &&
        baseline.version !== CLAUDE_CODE.version
      )
        note(
          "The Claude Code version changed since this group's last successful run and may be the cause.",
        );
      return undefined;
    });
    if (evidence) {
      note(`Claude configuration integrity evidence is in ${evidence}.`);
      throw new ClaudeRunError("config-tampered");
    }
  }
}
