import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { exportAudit } from "../../src/audit-export.ts";
import {
  CLAUDE_CODE,
  claudeCodeProvider,
  claudeCodeTools,
  type ClaudeCodeAuth,
} from "../../src/claude-code.ts";
import { ALPINE_3_23 } from "../../src/image-recipes.ts";
import {
  conciergeCommand,
  parseConciergeMode,
  snapshotConciergeRepo,
  startConcierge,
} from "../../src/local-orchestrator/concierge.ts";
import {
  OrchestratorStore,
  OrchestratorStoreError,
} from "../../src/local-orchestrator/store.ts";
import {
  bootstrapCheckout,
  prepareTargetDirectory,
  resolveTarget,
} from "../../src/local-orchestrator/target.ts";
import {
  configuredVerification,
  readVerificationConfig,
} from "../../src/local-orchestrator/verification.ts";
import { parseObservabilityConfig } from "../../src/observability-config.ts";
import { createObservedHost } from "../../src/observed-host.ts";
import {
  parseProfileLock,
  profileCatalog,
  PROFILE_LOCK_PATH,
} from "../../src/profile-lock.ts";
import { createTelemetry } from "../../src/telemetry.ts";

const usage =
  "Usage: bun run spike/local-orchestrator/concierge.ts --run [--continue] [--mode <m>] [--target <path>]";
const operatorCli = "bun run src/local-orchestrator/cli.ts status";
const runFile = promisify(execFile);

function parseArgs(args: readonly string[]) {
  let run = false;
  let resume = false;
  let target: string | undefined;
  let mode: ReturnType<typeof parseConciergeMode> | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run" && !run) run = true;
    else if (args[i] === "--continue" && !resume) resume = true;
    else if (args[i] === "--mode" && mode === undefined)
      mode = parseConciergeMode(args[++i]);
    else if (args[i] === "--target" && target === undefined) {
      target = args[++i];
      if (!target || target.startsWith("--") || target.includes("\0"))
        throw new Error(usage);
    } else throw new Error(usage);
  }
  return { run, mode: mode ?? "auto", continue: resume, target };
}

function operatorAuth(value: string | undefined): ClaudeCodeAuth {
  const [mode, variable, header, extra] = (value ?? "").split(":");
  if (
    mode !== "operator" ||
    !variable ||
    (header !== "authorization" && header !== "x-api-key") ||
    extra !== undefined
  )
    throw new Error("Set LO_CLAUDE_AUTH to operator:<VARIABLE>:<header>");
  return { mode: "operator-credential", variable, header };
}

async function fromKeychain(service: string | undefined): Promise<string> {
  const account = process.env.USER;
  if (
    !account ||
    !/^[A-Za-z0-9._-]+$/.test(account) ||
    !service ||
    !/^[A-Za-z0-9._-]+$/.test(service)
  )
    throw new Error(
      "Set LO_CLAUDE_KEYCHAIN to the service for the current user's Keychain item",
    );
  try {
    const { stdout } = await runFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { env: { PATH: "/usr/bin:/bin" }, timeout: 30_000, maxBuffer: 16_384 },
    );
    const value = stdout.trim();
    if (value.length < 20 || /\s/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error("Unable to read a usable Claude credential from Keychain");
  }
}

async function microsandboxBinary() {
  try {
    const { stdout } = await runFile(
      "mise",
      ["--no-config", "--no-env", "--no-hooks", "where", "microsandbox@0.7.16"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MISE_DATA_DIR: process.env.MISE_DATA_DIR,
          XDG_DATA_HOME: process.env.XDG_DATA_HOME,
          MISE_OFFLINE: "1",
          MISE_NOT_FOUND_AUTO_INSTALL: "false",
        },
        timeout: 15_000,
        maxBuffer: 4096,
      },
    );
    const dir = stdout.trim();
    if (!isAbsolute(dir)) throw new Error();
    return await realpath(join(dir, "msb"));
  } catch {
    throw new Error(
      "Install the pinned Microsandbox 0.7.16 mise tool before launching",
    );
  }
}

async function main(args: readonly string[]) {
  const flags = parseArgs(args);
  if (!flags.run) {
    console.log(
      `Dry run. The launcher would open the audited Concierge VM in ${flags.mode} mode${flags.continue ? " and resume the last conversation" : ""}, expose the Host API over vsock, and queue Planner runs.`,
    );
    if (flags.target !== undefined) {
      const target = await resolveTarget(flags.target);
      console.log(
        JSON.stringify({ target: target.repoRoot, state: target.directory }),
      );
    }
    console.log(usage);
    return;
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY))
    throw new Error("Concierge --run requires an operator TTY");

  const {
    MSB_HOME,
    LO_CLAUDE_AUTH,
    LO_CLAUDE_KEYCHAIN,
    LO_CLAUDE_MODEL,
    LO_CLAUDE_BINARY,
  } = process.env;
  if (!MSB_HOME || !isAbsolute(MSB_HOME))
    throw new Error(
      "Set MSB_HOME to a short absolute path with the pinned images preloaded",
    );
  const home = await realpath(MSB_HOME).catch(() => {
    throw new Error("MSB_HOME is inaccessible");
  });
  if (Buffer.byteLength(home) > 40)
    throw new Error(
      "MSB_HOME must be at most 40 bytes after resolving symlinks",
    );
  const auth = operatorAuth(LO_CLAUDE_AUTH);
  const model = LO_CLAUDE_MODEL ?? "claude-opus-5-5";
  const options = { model, mode: flags.mode, continue: flags.continue };
  conciergeCommand(options, auth);

  const target = await resolveTarget(flags.target ?? bootstrapCheckout);
  const { bootstrapRoot, directory, repoRoot } = target;
  const local = join(bootstrapRoot, ".local");
  const install = {
    binary:
      LO_CLAUDE_BINARY ??
      join(
        local,
        "claude-code",
        CLAUDE_CODE.version,
        CLAUDE_CODE.platform,
        "claude",
      ),
    packageDir: join(local, "alpine/v3.23/main/aarch64"),
  };
  if (!isAbsolute(install.binary))
    throw new Error("LO_CLAUDE_BINARY must be an absolute path");
  await Promise.all(
    claudeCodeTools(install, "alpine").map(({ hostPath }) => access(hostPath)),
  ).catch(() => {
    throw new Error("The pinned Claude CLI or Alpine packages are missing");
  });
  const binary = await microsandboxBinary();
  const profiles = profileCatalog(
    ALPINE_3_23.reference,
    parseProfileLock(
      await readFile(join(bootstrapRoot, PROFILE_LOCK_PATH), "utf8"),
    ),
  );
  if (!profiles.has("concierge"))
    throw new Error("The profile lock must include the Concierge image");

  await prepareTargetDirectory(bootstrapRoot, directory);
  let verificationConfig: ReturnType<typeof readVerificationConfig>;
  try {
    verificationConfig = readVerificationConfig(directory);
  } catch {
    throw new Error("Invalid target verification configuration");
  }
  if (verificationConfig && !profiles.has(verificationConfig.profile))
    throw new Error(
      "The profile lock must include the configured Verification profile",
    );
  const auditPath = join(directory, "audit.sqlite");
  const msb = { binary, home, stagingRoot: join(directory, "sandboxes") };
  const config = parseObservabilityConfig(
    {
      directory: join(directory, "observability"),
      audit: { mode: "required" },
      telemetry: { enabled: true, resourceSamplingIntervalMs: 1000 },
    },
    { msbHome: home, stagingRoot: msb.stagingRoot },
  );
  let credential = await fromKeychain(LO_CLAUDE_KEYCHAIN);
  const telemetry = createTelemetry(config.telemetry, config.directory);
  let store: OrchestratorStore | undefined;
  let observed: Awaited<ReturnType<typeof createObservedHost>> | undefined;
  let sessionId: string | undefined;
  let stage = "open state";
  try {
    store = OrchestratorStore.open(join(directory, "state.db"));
    console.log(`Audit database ${JSON.stringify(auditPath)}`);
    console.log(
      target.isDefault
        ? `Inspect proposals and approvals from another host terminal with ${operatorCli}`
        : "Inspect proposals and approvals with the operator CLI and the same --target argument.",
    );
    stage = "open audited host";
    observed = await createObservedHost({
      config,
      auditPath,
      msb,
      profiles,
      providers: [claudeCodeProvider(auth)],
      credentials: {
        async withAccessToken(consume) {
          if (!credential) throw new Error("Credential unavailable");
          return consume(credential);
        },
      },
      observers: [telemetry],
    });
    stage = "launch or clean up session";
    const result = await startConcierge(
      {
        host: observed.host,
        store,
        snapshot: snapshotConciergeRepo,
        install,
        auth,
        ...(verificationConfig
          ? { verification: configuredVerification(verificationConfig) }
          : {}),
      },
      {
        ...options,
        repoRoot,
        target,
        onSession: (id) => {
          sessionId = id;
          console.log(`Concierge session ${id}`);
        },
      },
    );
    console.log(
      `Concierge outcome ${result.outcome}, exit code ${result.exitCode ?? "unavailable"}`,
    );
    if (result.outcome !== "ok" || result.exitCode !== 0) process.exitCode = 1;
  } catch (error) {
    if (
      error instanceof OrchestratorStoreError &&
      error.code === "session-busy"
    )
      throw new Error(error.message);
    throw new Error(`Concierge failed to ${stage}`);
  } finally {
    credential = "";
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => observed?.close()),
      telemetry.shutdown(),
    ]);
    try {
      if (sessionId && observed && store) {
        let exported = false;
        try {
          exportAudit(auditPath, config.directory);
          exported = true;
        } catch {
          console.error("concierge-audit-export-failed");
        }
        try {
          store.recordSessionAuditExport(sessionId, exported);
        } catch {
          console.error("concierge-audit-export-evidence-failed");
        }
      }
    } finally {
      try {
        store?.close();
      } catch {
        closed.push({ status: "rejected", reason: "store-close-failed" });
      }
    }
    if (closed.some(({ status }) => status === "rejected")) {
      console.error("concierge-shutdown-failed");
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Only fixed messages leave the launcher. Never echo subprocess errors.
    console.error(
      error instanceof Error && !("code" in error)
        ? error.message
        : "Concierge launcher failed",
    );
    process.exitCode = 1;
  }
}
