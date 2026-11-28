import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkEnvironmentTree,
  environmentArchiveLimit,
  validateEnvironmentArchive,
} from "../environments/archive.ts";
import { readTar, type TarEntryView } from "../oci-image.ts";
import { readKeychainSecret } from "../secret-file.ts";
import { foldTreePath } from "../workspace-tree.ts";
import { maskCredentials, type CredentialScanner } from "./credential-scan.ts";
import {
  executableIdentity,
  HOST_CHECK_PATH,
  validateHostCheckHome,
  type HostCheckDeclaration,
} from "./host-checks.ts";

export const HOST_CHECK_TAIL_BYTES = 16 * 1024;
export const hostCheckHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export interface HostCheckOutcome {
  exitStatus: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutDigest: string;
  stderrDigest: string;
  tail: string;
  cleanupFailed?: true;
  failure?:
    | "setup"
    | "keychain"
    | "executable-changed"
    | "archive-changed"
    | "archive-missing"
    | "spawn";
}

interface HostCheckArchive {
  bytes: Uint8Array;
  outputs: readonly string[];
  linkTargets: readonly string[];
}

interface HostCheckRunInput {
  check: HostCheckDeclaration;
  executable: Awaited<ReturnType<typeof executableIdentity>>;
  pack(path: string): Promise<void>;
  archiveDigest: string | null;
  archive(): Promise<HostCheckArchive | null>;
}

export interface HostCheckRunner {
  run(input: HostCheckRunInput): Promise<HostCheckOutcome>;
}

export function emptyHostCheckOutcome(
  failure: NonNullable<HostCheckOutcome["failure"]>,
): HostCheckOutcome {
  return {
    failure,
    exitStatus: null,
    durationMs: 0,
    timedOut: false,
    stdoutDigest: hostCheckHash(""),
    stderrDigest: hostCheckHash(""),
    tail: "",
  };
}

function inside(root: string, path: string) {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(".." + sep))
  );
}

async function resolveRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    return resolve(
      await resolveRoot(dirname(path)),
      relative(dirname(path), path),
    );
  }
}

async function extract(directory: string, entries: readonly TarEntryView[]) {
  // Create links last, so extraction never traverses an archive-created link.
  for (const entry of entries) {
    const path = join(directory, entry.path);
    if (entry.type === "directory") await mkdir(path, { recursive: true });
    else if (entry.type === "file") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.data, {
        flag: "wx",
        mode: entry.mode & 0o111 ? 0o755 : 0o644,
      });
    } else if (entry.type === "symlink" || entry.type === "hardlink")
      await mkdir(dirname(path), { recursive: true });
    else throw new Error("Unsupported archive entry");
  }
  for (const entry of entries) {
    const path = join(directory, entry.path);
    if (entry.type === "hardlink") {
      const target = join(directory, entry.linkname);
      if (!(await lstat(target)).isFile()) throw new Error("Invalid hardlink");
      await link(target, path);
    } else if (entry.type === "symlink") await symlink(entry.linkname, path);
  }
}

function entryAt(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function unpackHostCheckEnvironment(
  directory: string,
  archive: HostCheckArchive,
  tree: readonly TarEntryView[],
) {
  checkEnvironmentTree(
    archive.outputs,
    tree.map((entry) => ({
      path: entry.path,
      directory: entry.type === "directory",
    })),
  );
  // Validate the bytes to be unpacked and reject source-tree link aliases.
  validateEnvironmentArchive(
    archive.bytes,
    archive.outputs,
    undefined,
    archive.linkTargets,
  );
  // Validate existing parents from the root down using filesystem identity.
  for (const output of archive.outputs) {
    const parts = output.split("/");
    let path = directory;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      const info = await entryAt(path);
      if (!info) break;
      if (!info.isDirectory() || index === parts.length - 1)
        throw new Error("Environment output collides with the candidate");
    }
  }
  for (const target of archive.linkTargets) {
    const path = join(directory, target);
    if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
      throw new Error("Unsafe environment link target");
  }
  const entries = readTar(archive.bytes, environmentArchiveLimit, true);
  await extract(directory, entries);
  for (const entry of entries) {
    if (
      entry.type === "symlink" &&
      !inside(directory, await realpath(join(directory, entry.path)))
    )
      throw new Error("Environment link escapes the check directory");
  }
}

export async function hashHostCheckFile(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return null;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Invalid host-check input file");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await file.stat({ bigint: true });
    if (before.ctimeNs !== after.ctimeNs || before.size !== after.size)
      throw new Error("Host-check input changed while hashing");
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

const marker = "[REDACTED]";

async function runProcess(
  check: HostCheckDeclaration,
  executable: string,
  cwd: string,
  env: Record<string, string>,
  secrets: readonly string[],
  scan?: CredentialScanner,
): Promise<HostCheckOutcome> {
  const started = performance.now();
  const hashes = [createHash("sha256"), createHash("sha256")];
  const literals = [...new Set(secrets)].map((value) => Buffer.from(value));
  const encodings = [
    ...new Set(
      secrets.flatMap((value) => {
        const bytes = Buffer.from(value);
        const hex = bytes.toString("hex");
        return [
          bytes.toString("base64"),
          bytes.toString("base64url"),
          hex,
          hex.toUpperCase(),
          ...[0, 1, 2].flatMap((prefix) => {
            // Only sextets made entirely of secret bits are independent of
            // the bytes before and after the secret.
            const prefixed = Buffer.concat([Buffer.alloc(prefix), bytes]);
            const start = Math.ceil((prefix * 8) / 6);
            const end = Math.floor((prefixed.length * 8) / 6);
            return (["base64", "base64url"] as const).map((encoding) =>
              prefixed.toString(encoding).slice(start, end),
            );
          }),
        ];
      }),
    ),
  ]
    .filter(Boolean)
    .map((value) => Buffer.from(value));
  // Preserve lookbehind for a match crossing the visible tail, even with
  // CRLF between encoded characters.
  const limit =
    HOST_CHECK_TAIL_BYTES +
    Math.max(
      0,
      ...literals.map((value) => value.length),
      ...encodings.map((value) => 3 * value.length),
    );
  // exec is path based. A same-user replacement between the last hash and
  // spawn (or a replacement of a script's interpreter) can still win.
  const child = spawn(executable, check.argv.slice(1), {
    argv0: check.argv[0],
    cwd,
    env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail: Buffer = Buffer.alloc(0);
  let received = 0;
  let timedOut = false;
  let escalation: Promise<void> | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let streams: (() => { bytes: Buffer; offsets: number[] })[];
  let spawnFailed = false;
  let exitStatus: number | null;
  try {
    streams = [child.stdout, child.stderr].map((stream, index) => {
      let bytes: Buffer = Buffer.alloc(0);
      let offsets: number[] = [];
      stream.on("data", (data: Buffer) => {
        hashes[index]!.update(data);
        received += data.length;
        const chunk = data.subarray(-limit);
        const keep = Math.max(0, limit - chunk.length);
        tail = Buffer.concat([
          keep ? tail.subarray(-keep) : Buffer.alloc(0),
          chunk,
        ]);
        bytes = Buffer.concat([
          keep ? bytes.subarray(-keep) : Buffer.alloc(0),
          chunk,
        ]);
        offsets = [
          ...(keep ? offsets.slice(-keep) : []),
          ...Array.from(
            { length: chunk.length },
            (_, i) => received - chunk.length + i,
          ),
        ];
      });
      return () => ({ bytes, offsets });
    });
    exitStatus = await new Promise<number | null>((done, reject) => {
      child.once("error", () => {
        spawnFailed = true;
        done(null);
      });
      child.once("exit", () => {
        // Descendants can hold the output pipes open after the leader exits.
        try {
          killGroup("SIGKILL");
        } catch (error) {
          reject(error);
        }
      });
      child.once("close", done);
      if (!child.pid) {
        spawnFailed = true;
        done(null);
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        escalation = (async () => {
          killGroup("SIGTERM");
          await delay(150);
          killGroup("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        })();
        void escalation.catch(reject);
      }, check.timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    try {
      await escalation;
    } finally {
      try {
        killGroup("SIGKILL");
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    }
  }

  const covered = new Uint8Array(tail.length);
  const tailOffset = received - tail.length;
  const mask = (
    bytes: Buffer,
    variants: readonly Buffer[],
    offsets?: readonly number[],
  ) => {
    for (const value of variants) {
      for (
        let from = bytes.indexOf(value);
        from >= 0;
        from = bytes.indexOf(value, from + 1)
      ) {
        if (!offsets) covered.fill(1, from, from + value.length);
        else {
          for (let i = from; i < from + value.length; i++) {
            const offset = offsets[i]! - tailOffset;
            if (offset >= 0) covered[offset] = 1;
          }
        }
      }
    }
  };
  const maskOutput = (bytes: Buffer, offsets?: readonly number[]) => {
    mask(bytes, literals, offsets);
    const unwrapped = Buffer.allocUnsafe(bytes.length);
    const positions: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (byte === 10 || byte === 13) continue;
      unwrapped[positions.length] = byte;
      positions.push(offsets ? offsets[i]! : tailOffset + i);
    }
    mask(unwrapped.subarray(0, positions.length), encodings, positions);
  };
  maskOutput(tail);
  // Each stream keeps its own lookbehind. A burst on stderr cannot hide a
  // credential split across writes on stdout (and vice versa).
  for (const stream of streams) {
    const { bytes, offsets } = stream();
    maskOutput(bytes, offsets);
  }
  const fragments: Buffer[] = [];
  let start = Math.max(0, tail.length - HOST_CHECK_TAIL_BYTES);
  while (
    start < tail.length &&
    !covered[start] &&
    (tail[start]! & 0xc0) === 0x80
  )
    start++;
  for (; start < tail.length;) {
    let end = start + 1;
    while (end < tail.length && covered[end] === covered[start]) end++;
    fragments.push(
      covered[start] ? Buffer.from(marker) : tail.subarray(start, end),
    );
    start = end;
  }
  const masked = await maskCredentials(Buffer.concat(fragments), [], scan);
  const text = masked?.text ?? "[output withheld]";
  return {
    exitStatus,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    stdoutDigest: hashes[0]!.digest("hex"),
    stderrDigest: hashes[1]!.digest("hex"),
    tail: Buffer.from(text)
      .subarray(-HOST_CHECK_TAIL_BYTES)
      .toString("utf8")
      .replace(/^\uFFFD/, ""),
    ...(spawnFailed ? { failure: "spawn" as const } : {}),
  };
}

type LocalHostCheckRunnerOptions = {
  tempRoot?: string;
  excludedRoots: readonly string[];
  agentHome?: string;
  readKeychain?: (service: string) => Promise<Uint8Array | undefined>;
  scan?: CredentialScanner;
};

export class LocalHostCheckRunner implements HostCheckRunner {
  readonly #options: LocalHostCheckRunnerOptions;

  constructor(options: LocalHostCheckRunnerOptions) {
    this.#options = options;
  }

  async run({
    check,
    executable,
    pack,
    archiveDigest,
    archive,
  }: HostCheckRunInput) {
    let directory: string | undefined;
    let outcome: HostCheckOutcome | undefined;
    let failure: NonNullable<HostCheckOutcome["failure"]> = "setup";
    const env: Record<string, string> = {};
    const secrets: string[] = [];
    try {
      validateHostCheckHome(
        check,
        this.#options.agentHome,
        "Edit the target's host-check declaration.",
      );
      const root = await realpath(
        this.#options.tempRoot ??
          (process.platform === "darwin" ? "/private/tmp" : tmpdir()),
      );
      for (const excluded of this.#options.excludedRoots) {
        const path = await resolveRoot(resolve(excluded));
        if (inside(foldTreePath(path), foldTreePath(root)))
          throw new Error("Unsafe host-check temp root");
      }
      directory = await mkdtemp(join(root, "agent-bootstrap-host-check-"));
      await chmod(directory, 0o700);
      const cwd = join(directory, "candidate");
      const HOME = join(directory, "home");
      const TMPDIR = join(directory, "tmp");
      for (const path of [cwd, HOME, TMPDIR])
        await mkdir(path, { mode: 0o700 });
      const treePath = join(directory, "candidate.tar");
      await pack(treePath);
      const tree = readTar(await readFile(treePath), 520 * 1024 * 1024, true);
      await extract(cwd, tree);
      await rm(treePath);
      if (archiveDigest !== null) {
        const environment = await archive();
        if (!environment)
          return (outcome = emptyHostCheckOutcome("archive-missing"));
        if (hostCheckHash(environment.bytes) !== archiveDigest)
          return (outcome = emptyHostCheckOutcome("archive-changed"));
        await unpackHostCheckEnvironment(cwd, environment, tree);
      }
      Object.assign(env, { PATH: HOST_CHECK_PATH, HOME, TMPDIR }, check.env);
      failure = "keychain";
      for (const { service, env: variable } of check.keychain ?? []) {
        const value = await (this.#options.readKeychain ?? readKeychainSecret)(
          service,
        );
        if (!value) throw new Error("Keychain item unavailable");
        try {
          if (!value.length || value.length > 4096 || value.includes(0))
            throw new Error("Invalid Keychain item");
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(value);
          secrets.push(text);
          env[variable] = text;
        } finally {
          value.fill(0);
        }
      }
      failure = "executable-changed";
      const current = await executableIdentity(check.argv[0], false);
      if (
        current.path !== executable.path ||
        current.sha256 !== executable.sha256
      )
        return (outcome = emptyHostCheckOutcome(failure));
      failure = "spawn";
      return (outcome = await runProcess(
        check,
        executable.path,
        cwd,
        env,
        secrets,
        this.#options.scan,
      ));
    } catch {
      return (outcome = emptyHostCheckOutcome(failure));
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => {
          if (outcome) outcome.cleanupFailed = true;
        });
      }
    }
  }
}
