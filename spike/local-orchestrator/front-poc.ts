import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ALPINE_3_23 } from "../../src/image-recipes.ts";
import {
  parseProfileLock,
  profileCatalog,
  PROFILE_LOCK_PATH,
} from "../../src/profile-lock.ts";

const checks = [
  "vsock",
  "read-only-mount",
  "named-volume",
  "detach-attach",
  "tty",
  "secret-modify",
] as const;
type Check = (typeof checks)[number];
type Outcome = "pass" | "fail" | "blocked";
type Report = { name: Check; outcome: Outcome; evidence: string[] };
const LIMIT = 2048;
const PIN = [
  "mise",
  "--no-config",
  "--no-env",
  "--no-hooks",
  "exec",
  "microsandbox@0.7.16",
  "--",
  "msb",
] as const;
const SECRET = "FPOC_DUMMY@example.invalid";
const PYTHON = "/usr/bin/python3";

export function parseCli(args: string[]) {
  let run = false;
  let only: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run" && !run) run = true;
    else if (args[i] === "--only" && only === undefined)
      only = args[++i]?.split(",") ?? [];
    else throw new Error("Usage: front-poc.ts --run [--only vsock,tty,...]");
  }
  if (
    only &&
    (!only.length ||
      only.some((name) => !checks.some((check) => check === name)))
  ) {
    throw new Error("Invalid --only; choose from " + checks.join(", "));
  }
  return {
    run,
    selected: checks.filter((name) => only?.includes(name) ?? true),
  };
}

type Profile = { image: string; memoryMiB?: number; cpus?: number };
export function createArgs(name: string, profile: Profile, feature: string[]) {
  return [
    "create",
    "--name",
    name,
    "--label",
    `front-poc=${name}`,
    "--pull",
    "never",
    "--no-net",
    "--max-duration",
    "5m",
    ...(profile.memoryMiB === undefined
      ? []
      : ["--memory", `${profile.memoryMiB}M`]),
    ...(profile.cpus === undefined ? [] : ["--cpus", String(profile.cpus)]),
    ...feature,
    profile.image,
  ];
}

export function assertSocketPath(path: string) {
  if (Buffer.byteLength(path) >= 100)
    throw new Error("Host socket path must be under 100 bytes");
}

const lines = (output: string) =>
  output.split(/\r?\n/).map((line) => line.trim());
export function jobId(output: string) {
  const id = output
    .trim()
    .match(/^(?:job(?:[-_ ]id)?\s*[:=]\s*)?([a-z0-9][a-z0-9_-]{0,127})$/i);
  return id?.[1];
}
export function ttySize(output: string, rows: number, cols: number) {
  return lines(output).some(
    (line) => line.split(/\s+/).join(" ") === `${rows} ${cols}`,
  );
}
export function vsockOutcome(
  output: string,
  connections: number,
  client: boolean,
  exited: boolean,
): Outcome {
  if (!client) return "blocked";
  return exited && connections === 1 && lines(output).includes("ack:ping")
    ? "pass"
    : "fail";
}

// Slice before decoding and discard a trailing partial UTF-8 character to keep
// the serialized evidence within the byte budget.
export function bounded(value: string) {
  const bytes = Buffer.from(value);
  if (bytes.length <= LIMIT) return value;
  return new TextDecoder().decode(bytes.subarray(0, LIMIT), { stream: true });
}

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  unavailable?: boolean;
};
type CommandOptions = {
  timeout?: number;
  dummy?: string;
  discard?: boolean;
  redact?: string[];
  help?: { match: RegExp; following?: number };
};
export type Runner = (
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;
const okay = (result: CommandResult) =>
  result.code === 0 && !result.timedOut && !result.unavailable;
const cliBlocked = (result: CommandResult) =>
  result.unavailable ||
  /unexpected argument|unrecognized (?:option|subcommand)|unknown (?:flag|option|subcommand)|invalid value.+for /i.test(
    result.stderr,
  );

function runProcess(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    const child = spawn(file!, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let unavailable = false;
    let continuation = 0;
    let partial = "";
    const retain = (before: Buffer, chunk: Buffer) =>
      before.length >= LIMIT + 128
        ? before
        : Buffer.concat([
            before,
            chunk.subarray(0, LIMIT + 128 - before.length),
          ]);
    const keepLine = (line: string) => {
      if (options.help?.match.test(line))
        continuation = 1 + (options.help.following ?? 0);
      if (continuation > 0) {
        stdout = retain(stdout, Buffer.from(line + "\n"));
        continuation--;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!options.help) {
        stdout = retain(stdout, chunk);
        return;
      }
      const split = (partial + chunk.toString()).split("\n");
      partial = bounded(split.pop() ?? "");
      for (const line of split) keepLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = retain(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      unavailable = true;
      stderr = retain(stderr, Buffer.from(error.code ?? "spawn failed"));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, options.timeout ?? 20_000);
    const clean = (bytes: Buffer) => {
      let value = new TextDecoder().decode(bytes, { stream: true });
      for (const dummy of options.redact ?? [])
        value = value.replaceAll(dummy, "[redacted]");
      return bounded(value);
    };
    child.on("close", (code) => {
      clearTimeout(timer);
      if (options.help && partial) keepLine(partial);
      resolve({
        code,
        timedOut,
        unavailable,
        stdout: options.discard ? "" : clean(stdout),
        stderr: clean(stderr),
      });
    });
  });
}

class CheckError extends Error {
  readonly outcome: Outcome;
  constructor(outcome: Outcome) {
    super(outcome);
    this.outcome = outcome;
  }
}

function record(
  evidence: string[],
  label: string,
  result: CommandResult,
  includeStdout = true,
) {
  evidence.push(
    `${label} exit: ${result.timedOut ? "timeout" : (result.code ?? "unavailable")}`,
  );
  if (includeStdout && result.stdout)
    evidence.push(bounded(`${label} stdout:\n${result.stdout}`));
  if (result.stderr)
    evidence.push(bounded(`${label} stderr:\n${result.stderr}`));
}

function requireOkay(
  evidence: string[],
  label: string,
  result: CommandResult,
  otherwise: Outcome = "fail",
) {
  record(evidence, label, result);
  if (!okay(result))
    throw new CheckError(cliBlocked(result) ? "blocked" : otherwise);
}

export class Resources {
  private vm: { name: string; created: boolean } | undefined;
  private volume: string | undefined;
  constructor(
    privateRun: Runner,
    profile: Profile,
    evidence: string[],
    suffix = () => randomBytes(4).toString("hex"),
  ) {
    this.run = privateRun;
    this.profile = profile;
    this.evidence = evidence;
    this.suffix = suffix;
  }
  private readonly run: Runner;
  private readonly profile: Profile;
  private readonly evidence: string[];
  private readonly suffix: () => string;

  async create(feature: string[] = [], options?: CommandOptions) {
    if (this.vm)
      throw new Error(
        "The previous VM must be removed before creating another",
      );
    const name = "fpoc-" + this.suffix();
    const vm = { name, created: false };
    this.vm = vm;
    const result = await this.run(createArgs(name, this.profile, feature), {
      timeout: 45_000,
      ...options,
    });
    vm.created = okay(result);
    requireOkay(this.evidence, "create " + name, result, "blocked");
    return name;
  }

  async createVolume() {
    const name = "fpoc-vol-" + this.suffix();
    this.volume = name;
    const result = await this.run(["volume", "create", name]);
    if (
      !okay(result) &&
      !result.timedOut &&
      !result.unavailable &&
      /already exists/i.test(result.stderr)
    )
      this.volume = undefined;
    requireOkay(this.evidence, "volume create " + name, result, "blocked");
    return name;
  }

  private async clean(args: string[]) {
    const label = "cleanup " + args.join(" ");
    try {
      const result = await this.run(args);
      if (okay(result)) return true;
      record(this.evidence, label, result);
    } catch {
      this.evidence.push(label + " could not run");
    }
    return false;
  }

  async removeVM() {
    if (!this.vm) return true;
    const { name, created } = this.vm;
    const stopped = !created || (await this.clean(["stop", name]));
    // The creation label also covers a create that timed out after reserving a VM.
    const removed = await this.clean([
      "rm",
      "--force",
      "--label",
      `front-poc=${name}`,
    ]);
    if (removed) this.vm = undefined;
    return stopped && removed;
  }

  async cleanup() {
    const vm = await this.removeVM();
    const volume =
      !this.volume || (await this.clean(["volume", "remove", this.volume]));
    if (volume) this.volume = undefined;
    return vm && volume;
  }
}

const execArgs = (vm: string, ...command: string[]) => [
  "exec",
  "--no-stdin",
  "--no-tty",
  vm,
  "--",
  ...command,
];
const guest = (run: Runner, vm: string, script: string, args: string[] = []) =>
  run(execArgs(vm, "sh", "-c", script, "sh", ...args));

async function ackServer(path: string) {
  assertSocketPath(path);
  let connections = 0;
  const active = new Set<Socket>();
  const server = createServer((socket) => {
    connections++;
    active.add(socket);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      const messages = pending.split("\n");
      pending = messages.pop() ?? "";
      if (
        Buffer.byteLength(pending) > LIMIT ||
        messages.some((line) => Buffer.byteLength(line) > LIMIT)
      ) {
        socket.destroy();
        return;
      }
      for (const line of messages) socket.write(`ack:${line}\n`);
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => active.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of active) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const ptyHelper = String.raw`
import errno, fcntl, os, pty, select, signal, struct, sys, termios, time
def size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def ctrl_c(fd):
    started = time.monotonic()
    try:
        os.write(fd, b"\x03")
        return started
    except OSError as exc:
        if exc.errno != errno.EIO:
            raise
        return None

pid, fd = pty.fork()
if pid == 0:
    size(0, 40, 120)
    os.execvp(sys.argv[2], sys.argv[2:])

resize = sys.argv[1] == "resize"
data = bytearray()
first_line = bytearray()
interrupted = None
deadline = time.monotonic() + 8
exited = False
resized_at = None
try:
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            exited = True
            break
        if not select.select([fd], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
            if resized_at is not None and interrupted is None and time.monotonic() >= resized_at + 2:
                interrupted = ctrl_c(fd)
                if interrupted is None:
                    break
                deadline = interrupted + 3
            continue
        try:
            chunk = os.read(fd, 1024)
        except OSError as exc:
            if exc.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        data.extend(chunk[:max(0, 1700 - len(data))])
        if interrupted is None:
            first_line.extend(chunk)
            if resize and resized_at is not None:
                if b"50 100" not in data and time.monotonic() < resized_at + 2:
                    first_line.clear()
                    continue
            elif b"\n" not in first_line and len(first_line) < 2048:
                continue
            elif resize:
                # Let the shell install its WINCH trap after stty exits.
                time.sleep(0.08)
                size(fd, 50, 100)
                os.kill(pid, signal.SIGWINCH)
                resized_at = time.monotonic()
                first_line.clear()
                continue
            # The shell can still be reaping stty when its output arrives.
            time.sleep(0.08)
            interrupted = ctrl_c(fd)
            if interrupted is None:
                break
            deadline = interrupted + 3
    while not exited and interrupted is not None and time.monotonic() <= deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        exited = bool(waited)
        if not exited:
            time.sleep(0.01)
    elapsed = str(round((time.monotonic() - interrupted) * 1000)) if exited and interrupted is not None else "none"
    print("ctrl-c-exit-ms=" + elapsed, flush=True)
    sys.stdout.buffer.write(data)
finally:
    if not exited and not os.waitpid(pid, os.WNOHANG)[0]:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(fd)
`;

export function ttyOutcome(output: string): Outcome {
  const elapsed = /^ctrl-c-exit-ms=(\d+)$/m.exec(output)?.[1];
  return ttySize(output, 40, 120) &&
    elapsed !== undefined &&
    Number(elapsed) <= 3000
    ? "pass"
    : "fail";
}

const secretProbe = `if [ "${"$"}{FPOC_DUMMY+x}" != x ]; then echo unset; exit; fi
digest=$(printf '%s' "$FPOC_DUMMY" | sha256sum) || exit 1
printf 'set %s\\n' "${"$"}{digest%% *}"`;

export function secretObservation(output: string) {
  const value = output.trim();
  if (value === "unset") return value;
  return /^set ([a-f0-9]{64})$/.exec(value)?.[1];
}

type Context = {
  run: Runner;
  vm: Resources;
  directory: string;
  host: NodeJS.ProcessEnv;
  evidence: string[];
};

async function vsock({
  run,
  vm,
  directory,
  evidence,
}: Context): Promise<Outcome> {
  const path = join(directory, "h.sock");
  const server = await ackServer(path);
  try {
    const name = await vm.create(["--vsock", `${path}:5000`]);
    const probe = await guest(
      run,
      name,
      `if test -e /dev/vsock; then echo '/dev/vsock present'; else echo '/dev/vsock absent'; fi
command -v socat python3 nc || :
busybox nc --help 2>&1 | head
if command -v socat >/dev/null; then echo 'client=socat';
elif command -v python3 >/dev/null; then echo 'client=python3'; fi`,
    );
    requireOkay(evidence, "guest vsock probe", probe);
    const socat = lines(probe.stdout).includes("client=socat");
    const python = lines(probe.stdout).includes("client=python3");
    if (!socat && !python) {
      evidence.push("no guest vsock client");
      return "blocked";
    }
    const result = socat
      ? await guest(run, name, "echo ping | socat - VSOCK-CONNECT:2:5000")
      : await run(
          execArgs(
            name,
            "python3",
            "-c",
            "import socket; s=socket.socket(socket.AF_VSOCK,socket.SOCK_STREAM); s.settimeout(5); s.connect((2,5000)); s.sendall(b'ping\\n'); print(s.makefile('r').readline().rstrip('\\n'))",
          ),
        );
    record(evidence, "guest vsock exchange", result);
    evidence.push(`host connections: ${server.connections()}`);
    return cliBlocked(result)
      ? "blocked"
      : vsockOutcome(result.stdout, server.connections(), true, okay(result));
  } finally {
    await server.close();
  }
}

async function readOnlyMount({
  run,
  vm,
  directory,
  evidence,
}: Context): Promise<Outcome> {
  const help = await run(["create", "--help"], {
    help: { match: /^\s*--mount-dir\s/, following: 3 },
  });
  requireOkay(evidence, "create --help mount-dir", help, "blocked");
  if (
    !help.stdout.includes("--mount-dir") ||
    !help.stdout.includes("SOURCE:DEST[:OPTIONS]")
  )
    return "blocked";
  evidence.push(
    /\bro\b/.test(help.stdout)
      ? "Mount option spelling in help: :ro"
      : "Help lists [:OPTIONS]. Testing :ro as used by src/microsandbox.ts.",
  );
  const repo = join(directory, "repo");
  await mkdir(repo);
  const file = join(repo, "f.txt");
  await writeFile(file, "orig\n", { mode: 0o600 });
  const name = await vm.create(["--mount-dir", `${repo}:/repo:ro`]);
  const result = await guest(
    run,
    name,
    `cat /repo/f.txt || exit 1
if (echo x > /repo/f.txt); then echo overwrite=allowed; else echo overwrite=denied; fi
if touch /repo/new; then echo create=allowed; else echo create=denied; fi`,
  );
  record(evidence, "guest mount probe", result);
  const unchanged = (await readFile(file, "utf8")) === "orig\n";
  const absence = await lstat(join(repo, "new")).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );
  evidence.push(
    `host file unchanged: ${unchanged}`,
    `host new file absent: ${absence}`,
  );
  if (cliBlocked(result)) return "blocked";
  return okay(result) &&
    result.stdout.replaceAll("\r\n", "\n") ===
      "orig\noverwrite=denied\ncreate=denied\n" &&
    unchanged &&
    absence
    ? "pass"
    : "fail";
}

async function namedVolume({ run, vm, evidence }: Context): Promise<Outcome> {
  const volume = await vm.createVolume();
  const mount = ["--mount-named", `${volume}:/state`];
  const nonce = randomBytes(16).toString("hex");
  const first = await vm.create(mount);
  requireOkay(
    evidence,
    "write volume marker",
    await guest(run, first, 'printf "%s\\n" "$1" > /state/marker', [nonce]),
  );
  if (!(await vm.removeVM())) return "fail";
  const second = await vm.create(mount);
  const result = await run(execArgs(second, "cat", "/state/marker"));
  requireOkay(evidence, "read volume marker in second VM", result);
  return result.stdout === nonce + "\n" ? "pass" : "fail";
}

async function detachAttach({ run, vm, evidence }: Context): Promise<Outcome> {
  const name = await vm.create();
  const result = await run([
    "exec",
    "-d",
    name,
    "--",
    "sh",
    "-c",
    'i=0; while [ "$i" -lt 30 ]; do echo tick$i; i=$((i+1)); sleep 1; done',
  ]);
  requireOkay(evidence, "detach", result);
  const jobs = await run(["jobs", name]);
  requireOkay(evidence, "jobs", jobs);
  const id = jobId(result.stdout);
  if (!id) {
    evidence.push("Could not parse a job ID from detach stdout");
    return "blocked";
  }
  await delay(3000);
  const attached = await run(["attach", "--read-only", "--job", id, name], {
    timeout: 4000,
  });
  record(evidence, "read-only attach", attached);
  if (cliBlocked(attached)) return "blocked";
  // A live stream normally reaches the host timeout. Cleanup stops the job's VM.
  return lines(attached.stdout).some((line) => /^tick\d+$/.test(line))
    ? "pass"
    : "fail";
}

async function tty({
  vm,
  directory,
  host,
  evidence,
}: Context): Promise<Outcome> {
  const python = await runProcess([PYTHON, "-I", "--version"], host);
  requireOkay(evidence, "system python3", python, "blocked");
  const helper = join(directory, "pty.py");
  await writeFile(helper, ptyHelper, { mode: 0o600, flag: "wx" });
  const name = await vm.create();
  const probe = (mode: string, script: string) =>
    runProcess(
      [
        PYTHON,
        "-I",
        helper,
        mode,
        ...PIN,
        "exec",
        "-t",
        name,
        "--",
        "sh",
        "-c",
        script,
      ],
      host,
      { timeout: 15_000 },
    );
  const initial = await probe("initial", "stty size; sleep 30");
  record(evidence, "PTY initial size and Ctrl-C", initial);
  const resize = await probe(
    "resize",
    'stty size; trap "stty size" WINCH; sleep 30',
  );
  record(evidence, "PTY resize", resize);
  evidence.push(
    `resize to 50 100 observed: ${ttySize(resize.stdout, 50, 100)}`,
  );
  if (
    cliBlocked({ ...initial, stderr: initial.stderr + "\n" + initial.stdout })
  )
    return "blocked";
  return okay(initial) ? ttyOutcome(initial.stdout) : "fail";
}

async function secretModify({ run, vm, evidence }: Context): Promise<Outcome> {
  const help = await run(["modify", "--help"], {
    help: {
      match:
        /Usage:|--secret\s|Add or rotate|--next-start\b|Save changes|--restart\b|Restart if/,
    },
  });
  if (!okay(help)) requireOkay(evidence, "modify --help", help, "blocked");
  const helpLines = help.stdout
    .split("\n")
    .filter((line) =>
      /Usage:|--secret\b|Add or rotate|--next-start\b|Save changes|--restart\b|Restart if/.test(
        line,
      ),
    );
  evidence.push(...helpLines.map((line) => line.trim()));
  if (
    !helpLines.some((line) => /--secret\s</.test(line)) ||
    !helpLines.some((line) => /--restart\b/.test(line))
  ) {
    evidence.push("modify help did not describe both --secret and --restart");
    return "blocked";
  }
  const dummy = randomBytes(24).toString("hex");
  const next = randomBytes(24).toString("hex");
  const redact = [dummy, next];
  const name = await vm.create(["--secret", SECRET], {
    dummy,
    redact,
    discard: true,
  });
  const read = () => run(execArgs(name, "sh", "-c", secretProbe), { redact });
  const initial = await read();
  const before = okay(initial) ? secretObservation(initial.stdout) : undefined;
  if (before === undefined) {
    evidence.push("Initial secret state unavailable");
    return cliBlocked(initial) ? "blocked" : "fail";
  }
  evidence.push(
    before === "unset"
      ? "unset"
      : before === createHash("sha256").update(dummy).digest("hex")
        ? "equal"
        : "different",
  );

  let outcome: Outcome = "pass";
  for (const restart of [false, true]) {
    const label = restart ? "modify with restart" : "modify without restart";
    const result = await run(
      ["modify", "--secret", SECRET, ...(restart ? ["--restart"] : []), name],
      { dummy: next, redact, discard: true, timeout: 45_000 },
    );
    record(evidence, label, result, false);
    const reread = await read();
    const after = okay(reread) ? secretObservation(reread.stdout) : undefined;
    evidence.push(
      `${label} guest value: ${after === undefined ? "unavailable" : after === before ? "unchanged" : "changed"}`,
    );
    if (restart) {
      const alive = await run(execArgs(name, "true"), {
        discard: true,
        redact,
      });
      evidence.push(`VM accepts exec after restart attempt: ${okay(alive)}`);
    }
    if (cliBlocked(result) || cliBlocked(reread)) outcome = "blocked";
    else if (
      (result.code === null || result.timedOut || after === undefined) &&
      outcome !== "blocked"
    )
      outcome = "fail";
  }
  return outcome;
}

const runChecks = {
  vsock,
  "read-only-mount": readOnlyMount,
  "named-volume": namedVolume,
  "detach-attach": detachAttach,
  tty,
  "secret-modify": secretModify,
};

async function main(args: string[]) {
  const { run, selected } = parseCli(args);
  if (!run) {
    console.log(
      "Plan (one VM at a time, with no network egress): " + selected.join(", "),
    );
    console.log(
      "Use --run with a short absolute MSB_HOME containing the pinned base image.",
    );
    return 0;
  }

  const requested = process.env.MSB_HOME;
  if (!requested || !isAbsolute(requested))
    throw new Error(
      "Set a short absolute MSB_HOME with the pinned base image preloaded",
    );
  const home = await realpath(requested).catch(() => {
    throw new Error("MSB_HOME is inaccessible");
  });
  if (Buffer.byteLength(home) > 40)
    throw new Error(
      "Use an MSB_HOME path at most 40 bytes to leave room for backend sockets",
    );
  const host: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    MISE_DATA_DIR: process.env.MISE_DATA_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    MISE_OFFLINE: "1",
    MISE_NOT_FOUND_AUTO_INSTALL: "false",
    MSB_HOME: home,
    MSB_BACKEND: "local",
  };
  const runner: Runner = (command, options) =>
    runProcess(
      [...PIN, ...command],
      options?.dummy ? { ...host, FPOC_DUMMY: options.dummy } : host,
      options,
    );
  const profile = profileCatalog(
    ALPINE_3_23.reference,
    parseProfileLock(
      await readFile(
        new URL(`../../${PROFILE_LOCK_PATH}`, import.meta.url),
        "utf8",
      ),
    ),
  ).get("base")!;
  const timestamp = new Date().toISOString();
  const root = fileURLToPath(
    new URL("../../.local/front-poc/", import.meta.url),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const output = join(root, timestamp);
  await mkdir(output, { mode: 0o700 });
  const reportPath = join(output, "report.json");
  const results: Report[] = [];
  const cleanupFailures: string[] = [];
  let directory: string | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    directory = await mkdtemp("/private/tmp/ab-fpoc.");
    const setup = await runner(["--version"]);
    let canContinue = okay(setup) && setup.stdout.trim() === "msb 0.7.16";
    for (const name of selected) {
      const evidence: string[] = [];
      let outcome: Outcome = "blocked";
      if (interrupted) {
        evidence.push("Skipped after operator interruption");
      } else if (!canContinue) {
        if (!okay(setup) || setup.stdout.trim() !== "msb 0.7.16") {
          record(evidence, "expected msb 0.7.16", setup);
        } else {
          evidence.push("Skipped after resource cleanup failed");
        }
      } else {
        const vm = new Resources(runner, profile, evidence);
        try {
          outcome = await runChecks[name]({
            run: runner,
            vm,
            directory,
            host,
            evidence,
          });
        } catch (error) {
          outcome = error instanceof CheckError ? error.outcome : "fail";
          if (!(error instanceof CheckError)) {
            const code = (error as NodeJS.ErrnoException)?.code;
            evidence.push(`Local check error${code ? ": " + code : ""}`);
          }
        } finally {
          if (!(await vm.cleanup())) {
            outcome = "fail";
            canContinue = false;
          }
        }
      }
      results.push({ name, outcome, evidence: evidence.map(bounded) });
    }
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => {
        cleanupFailures.push("Failed to remove host temporary directory");
      });
    }
    if (interrupted && results.length) {
      results.at(-1)!.outcome = "fail";
      results.at(-1)!.evidence.push("Run interrupted by operator");
    }
    if (cleanupFailures.length && results.length)
      results.at(-1)!.outcome = "fail";
    await writeFile(
      reportPath,
      JSON.stringify({ timestamp, checks: results, cleanupFailures }, null, 2) +
        "\n",
      { mode: 0o600, flag: "wx" },
    ).finally(() => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    });
  }
  console.table(results.map(({ name, outcome }) => ({ check: name, outcome })));
  console.log("Report " + reportPath);
  return results.some(({ outcome }) => outcome === "fail") ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Known usage errors contain fixed text. Unexpected errors may contain paths
    // or process details, so only surface their system error code.
    const failure = error as NodeJS.ErrnoException;
    console.error(
      failure.code ? `Front PoC failed (${failure.code})` : failure.message,
    );
    process.exitCode = 1;
  }
}
