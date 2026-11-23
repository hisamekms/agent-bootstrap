import { GitIntegrationError } from "../../src/git-integration.ts";
import { configuredCredentialScanner } from "../../src/local-orchestrator/credential-scan.ts";
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { exportAudit, exportAuditChecked } from "../../src/audit-export.ts";
import {
  CLAUDE_CODE,
  claudeCodeProvider,
  claudeCodeTools,
  type ClaudeCodeAuth,
} from "../../src/claude-code.ts";
import { ALPINE_3_23 } from "../../src/image-recipes.ts";
import {
  claudeLoginCommand,
  conciergeCommand,
  parseConciergeArgs,
  snapshotConciergeRepo,
  startConcierge,
} from "../../src/local-orchestrator/concierge.ts";
import {
  loadClaudeConfig,
  userStateDirectory,
} from "../../src/local-orchestrator/claude-config.ts";
import { createClaudePolicy } from "../../src/local-orchestrator/claude-policy.ts";
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
import { MISE_FLAGS, MSB_TOOL, offlineMiseEnv } from "../../src/mise-tools.ts";
import { parseObservabilityConfig } from "../../src/observability-config.ts";
import { createObservedHost } from "../../src/observed-host.ts";
import {
  parseProfileLock,
  profileCatalog,
  PROFILE_LOCK_PATH,
} from "../../src/profile-lock.ts";
import { createTelemetry } from "../../src/telemetry.ts";

const usage =
  "Usage: bun run spike/local-orchestrator/concierge.ts --run [--continue] [--mode <m>] [--target <path>] [--claude-auth <mode>]";
const operatorCli = "bun run src/local-orchestrator/cli.ts status";
const runFile = promisify(execFile);

async function fromKeychain(service: string | undefined): Promise<string> {
  const account = userInfo().username;
  if (
    !account ||
    !/^[A-Za-z0-9._-]+$/.test(account) ||
    !service ||
    !/^[A-Za-z0-9._-]+$/.test(service)
  )
    throw new Error(
      "Configure the API key Keychain service for the current user.",
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
      [...MISE_FLAGS, "where", MSB_TOOL],
      {
        env: offlineMiseEnv(process.env),
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
  let flags: ReturnType<typeof parseConciergeArgs>;
  try {
    flags = parseConciergeArgs(args);
  } catch {
    throw new Error(usage);
  }
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

  const { MSB_HOME, LO_CLAUDE_MODEL, LO_CLAUDE_BINARY } = process.env;
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
  const model = LO_CLAUDE_MODEL ?? "claude-opus-5-5";
  const options = { model, mode: flags.mode, continue: flags.continue };
  const target = await resolveTarget(flags.target ?? bootstrapCheckout);
  const { bootstrapRoot, directory, repoRoot } = target;
  await prepareTargetDirectory(bootstrapRoot, directory);
  const effective = loadClaudeConfig(process.env, directory, flags.claudeAuth);
  for (const warning of effective.warnings) console.error(warning);
  const login = flags.loginGroup;
  if (
    login &&
    (!effective.configDir || !Object.hasOwn(effective.configDir.groups, login))
  )
    throw new Error("Select a configured Claude group for login.");
  const auth: ClaudeCodeAuth =
    effective.auth === "config-dir"
      ? { mode: "config-dir" }
      : { mode: "api-key", credential: "host-secret" };
  if (!login) conciergeCommand(options, auth);
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

  let verificationConfig: ReturnType<typeof readVerificationConfig>;
  try {
    verificationConfig = login ? null : readVerificationConfig(directory);
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
  const provider =
    auth.mode === "config-dir" ? undefined : claudeCodeProvider(auth);
  let credential = provider
    ? await fromKeychain(effective.keychainService)
    : "";
  const claude = createClaudePolicy(
    effective,
    userStateDirectory(process.env),
    (note) => console.error(note),
  );
  const scan = login
    ? claude.configDir?.scan
    : (claude.configDir?.scan ??
      configuredCredentialScanner(
        directory,
        (note) => console.error(note),
        process.env,
        flags.claudeAuth,
      ));
  const telemetry = createTelemetry(config.telemetry, config.directory);
  let store: OrchestratorStore | undefined;
  let observed: Awaited<ReturnType<typeof createObservedHost>> | undefined;
  let sessionId: string | undefined;
  let stage = "open state";
  try {
    if (!login) store = OrchestratorStore.open(join(directory, "state.db"));
    console.log(`Audit database ${JSON.stringify(auditPath)}`);
    if (!login)
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
      claude,
      ...(effective.gatewayHosts
        ? { gatewayHosts: effective.gatewayHosts }
        : {}),
      ...(provider
        ? {
            providers: [provider],
            credentials: {
              async withAccessToken(consume) {
                if (!credential) throw new Error("Credential unavailable");
                return consume(credential);
              },
            },
          }
        : {}),
      observers: [telemetry],
    });
    stage = "launch or clean up session";
    if (login) {
      console.error(
        "Disable OSC 52 clipboard access. Use the Claude Code CLI's own /login, then exit the CLI.",
      );
      const result = await observed.host.runClaudeLogin(
        login,
        claudeCodeTools(install),
        claudeLoginCommand(),
      );
      if (result.outcome !== "ok") process.exitCode = 1;
      return;
    }
    if (!store) throw new Error("Concierge state unavailable");
    const result = await startConcierge(
      {
        host: observed.host,
        store,
        snapshot: snapshotConciergeRepo,
        ...(scan ? { scan } : {}),
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
      error instanceof GitIntegrationError &&
      error.code === "unsafe-input-symlink"
    )
      throw new Error(error.message);
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
          if (scan) await exportAuditChecked(auditPath, config.directory, scan);
          else exportAudit(auditPath, config.directory);
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
