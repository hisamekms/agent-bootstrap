import { GoalPublisher } from "../../src/publish/goals.ts";
import { githubGh } from "../../src/publish/github-gh.ts";
import { EnvironmentStore } from "../../src/environments/store.ts";
import { systemHost } from "../../src/onboarding/prerequisites.ts";
import { codexProvider, siwcCodexEndpoint } from "../../src/codex-exec.ts";
import { siwcProvider, siwcSandboxCredential } from "../../src/siwc.ts";
import { listenOperatorApi } from "../../src/local-orchestrator/operator-api.ts";
import { secretTestFacts } from "../../src/local-orchestrator/secret-test-record.ts";
import { loadConfig } from "../../src/config/layers.ts";
import { ActorConfigError, ConfigError } from "../../src/config/messages.ts";
import { MsbHomeError, requireMsbHome } from "../../src/config/msb-home.ts";
import { driftWarning } from "../../src/config/projects.ts";
import { GitIntegrationError } from "../../src/git-integration.ts";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { exportAudit, exportAuditChecked } from "../../src/audit-export.ts";
import { AuditStoreError } from "../../src/audit.ts";
import {
  CLAUDE_CODE,
  SECRET_FILE_PACKAGES,
  claudeCodeProvider,
  claudeCodeTools,
  type ClaudeCodeAuth,
} from "../../src/claude-code.ts";
import { ALPINE_3_23 } from "../../src/image-recipes.ts";
import { escapeTerminalControls } from "../../src/local-orchestrator/analysis.ts";
import {
  conciergeCommand,
  parseConciergeArgs,
  snapshotConciergeRepo,
  startConcierge,
  type ConciergeOptions,
} from "../../src/local-orchestrator/concierge.ts";
import {
  parseWorkplaceArgs,
  runWorkplace,
  workplaceStop,
} from "../../src/local-orchestrator/workplace.ts";
import { createWorkplaceEnvironment } from "../../src/local-orchestrator/workplace-environment.ts";
import { loadWorkplaceAssets } from "../../src/operator-ui/assets.ts";
import {
  loadClaudeConfig,
  resolveClaudeModel,
  userStateDirectory,
} from "../../src/local-orchestrator/claude-config.ts";
import { createClaudePolicy } from "../../src/local-orchestrator/claude-policy.ts";
import { selectsCodex } from "../../src/local-orchestrator/codex-executor.ts";
import {
  OrchestratorStore,
  OrchestratorStoreError,
} from "../../src/local-orchestrator/store.ts";
import {
  bootstrapCheckout,
  prepareTargetDirectory,
  resolveTarget,
} from "../../src/local-orchestrator/target.ts";
import { configuredVerification } from "../../src/local-orchestrator/verification.ts";
import {
  MISE_FLAGS,
  MISE_MSB,
  MSB_TOOL,
  offlineMiseEnv,
} from "../../src/mise-tools.ts";
import { parseObservabilityConfig } from "../../src/observability-config.ts";
import {
  createObservedHost,
  ObservedHostStartupError,
} from "../../src/observed-host.ts";
import {
  parseProfileLock,
  profileCatalog,
  PROFILE_LOCK_PATH,
} from "../../src/profile-lock.ts";
import { createTelemetry } from "../../src/telemetry.ts";
import { VolumeError } from "../../src/volumes/volume.ts";
import { unsafeInputSymlinkNext } from "../../src/workspace-tree.ts";
import { secretTestWarnings } from "../../src/local-orchestrator/secret-launch.ts";

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
    throw new ConfigError(
      "credential source",
      "The configured credential source is unavailable.",
      "Configure the credential source for the current user, then retry.",
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
    throw new ConfigError(
      "credential source",
      "The configured credential could not be read.",
      "Check the configured credential source for your account, then retry.",
    );
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
    throw new ObservedHostStartupError("microsandbox-version-check-failed");
  }
}

export function conciergeFailure(stage: string, error: unknown): string {
  const message = `Concierge failed to ${stage}`;
  const withCause = (code: string, next: string) =>
    `${message} (${code})\nnext: ${escapeTerminalControls(next)}`;
  if (error instanceof ConfigError)
    return withCause(
      error instanceof ActorConfigError
        ? `${error.code}/${error.key}`
        : "config-invalid",
      error.next,
    );
  if (error instanceof VolumeError)
    return withCause(`volume/${error.code}`, error.next);
  if (error instanceof MsbHomeError)
    return withCause("runtime-home-invalid", error.next);
  if (error instanceof AuditStoreError)
    return withCause(
      `audit-store/${error.code}`,
      "Keep the audit database and run agent-bootstrap help troubleshoot.",
    );
  if (error instanceof GitIntegrationError)
    return withCause(
      `git-integration/${error.code}`,
      error.code === "unsafe-input-symlink"
        ? unsafeInputSymlinkNext
        : "Check the target checkout and local main, then run agent-bootstrap help troubleshoot.",
    );
  if (error instanceof OrchestratorStoreError)
    return withCause(
      `orchestrator-store/${error.code}`,
      error.code === "session-busy"
        ? "Wait for the active launcher, or run agent-bootstrap reconcile with the same target if it stopped."
        : "Check the target state directory and run agent-bootstrap help troubleshoot.",
    );
  if (error instanceof ObservedHostStartupError)
    return withCause(
      error.code,
      error.code === "gateway-startup-failed"
        ? "Check local socket permissions and run agent-bootstrap help troubleshoot."
        : "Check the pinned runtime with agent-bootstrap doctor.",
    );
  return message;
}

async function main(args: readonly string[]) {
  if (args[0] === "workplace") {
    let flags: ReturnType<typeof parseWorkplaceArgs>;
    try {
      flags = parseWorkplaceArgs(args.slice(1));
    } catch {
      throw new Error("Run agent-bootstrap help workplace for usage.");
    }
    const lifelineFd = process.env.AGENT_BOOTSTRAP_LIFELINE_FD;
    delete process.env.AGENT_BOOTSTRAP_LIFELINE_FD;
    const lifeline =
      lifelineFd === "3"
        ? createReadStream("", { fd: 3 }).on("error", () => {})
        : undefined;
    lifeline?.resume();
    const stopControl = workplaceStop(
      process,
      (code) => {
        process.stderr.write(
          "Stopped without cleanup. Run agent-bootstrap doctor before the next launch.\n",
        );
        process.exit(code);
      },
      lifeline,
    );
    let stage = "resolve target";
    try {
      await launchConcierge(
        flags,
        (next) => {
          stage = next;
        },
        {
          signal: stopControl.signal,
          stop: stopControl.stop,
          devBridge: flags.devBridge,
        },
      );
    } catch (error) {
      if (!stopControl.signal.aborted || error !== stopControl.signal.reason)
        throw new Error(conciergeFailure(stage, error));
    } finally {
      stopControl.dispose();
      if (stopControl.exitCode !== undefined)
        process.exitCode = stopControl.exitCode;
    }
    return;
  }

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
      const target = await resolveTarget(flags.target).catch(
        (error: unknown) => {
          throw new Error(conciergeFailure("resolve target", error));
        },
      );
      console.log(
        JSON.stringify({ target: target.repoRoot, state: target.directory }),
      );
    }
    console.log(usage);
    return;
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY))
    throw new Error("Concierge --run requires an operator TTY");

  let stage = "resolve target";
  try {
    await launchConcierge(flags, (next) => {
      stage = next;
    });
  } catch (error) {
    throw new Error(conciergeFailure(stage, error));
  }
}

async function launchConcierge(
  flags: ReturnType<typeof parseConciergeArgs>,
  setStage: (stage: string) => void,
  workplace?: { signal: AbortSignal; stop(): void; devBridge: boolean },
) {
  const { LO_CLAUDE_BINARY } = process.env;
  const target = await resolveTarget(flags.target ?? bootstrapCheckout);
  const { bootstrapRoot, directory, repoRoot, configDirectory } = target;
  setStage("load configuration");
  const layers = loadConfig(process.env, configDirectory);
  setStage("resolve runtime home");
  const home = await requireMsbHome(process.env, layers.user);
  const warning = driftWarning(target.project, layers.approved);
  if (warning) console.error(warning);
  setStage("prepare target state");
  await prepareTargetDirectory(bootstrapRoot, directory);
  setStage("configure Concierge");
  const effective = loadClaudeConfig(
    process.env,
    configDirectory,
    flags.claudeAuth,
    layers,
  );
  const model = resolveClaudeModel(effective);
  const options = { model, mode: flags.mode, continue: flags.continue };
  for (const warning of effective.warnings) console.error(warning);
  const volumeShell = flags.volumeShell;
  const auth: ClaudeCodeAuth =
    effective.auth === "external"
      ? { mode: "external" }
      : { mode: "api-key", credential: "host-secret" };
  if (!volumeShell) conciergeCommand(options, auth);
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
  if (!volumeShell && !isAbsolute(install.binary))
    throw new ConfigError(
      "CLI path",
      "The path must be absolute.",
      "Configure an absolute path to the pinned CLI.",
    );
  if (!volumeShell)
    await Promise.all(
      [
        ...claudeCodeTools(install, "alpine").map(({ hostPath }) => hostPath),
        ...(Object.keys(effective.config.secretEnv ?? {}).length
          ? SECRET_FILE_PACKAGES.map(({ name }) =>
              join(install.packageDir, name),
            )
          : []),
      ].map((path) => access(path)),
    ).catch(() => {
      throw new ConfigError(
        "CLI installation",
        "The pinned CLI or required guest packages are missing.",
        "Run agent-bootstrap help setup.",
      );
    });
  setStage("locate runtime");
  const binary = await microsandboxBinary();
  setStage("load runtime profiles");
  const profileLock = parseProfileLock(
    await readFile(join(bootstrapRoot, PROFILE_LOCK_PATH), "utf8"),
  );
  const profiles = profileCatalog(ALPINE_3_23.reference, profileLock);
  if (!profiles.has("concierge"))
    throw new Error("The profile lock must include the Concierge image");

  const verificationConfig = volumeShell
    ? undefined
    : layers.config.verification;
  if (verificationConfig && !profiles.has(verificationConfig.profile))
    throw new Error(
      "The profile lock must include the configured Verification profile",
    );
  const baseImage = profiles.get("base").image;
  if (!volumeShell)
    for (const warning of secretTestWarnings(
      effective.config,
      userStateDirectory(process.env),
      baseImage,
      repoRoot,
    ))
      console.error(warning);
  const auditPath = join(directory, "audit.sqlite");
  const displayedAuditPath = escapeTerminalControls(JSON.stringify(auditPath));
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
    volumeShell || auth.mode === "external"
      ? undefined
      : claudeCodeProvider(auth);
  const codex =
    !volumeShell && selectsCodex(effective.config)
      ? codexProvider(siwcCodexEndpoint)
      : undefined;
  const claudeCredential = {
    async withAccessToken<T>(consume: (token: string) => Promise<T>) {
      if (!credential) throw new Error("Credential unavailable");
      return consume(credential);
    },
  };
  setStage("read Concierge credential");
  let credential = provider
    ? await fromKeychain(effective.keychainService)
    : "";
  setStage("configure audited host");
  const claude = createClaudePolicy(
    volumeShell
      ? {
          ...effective,
          config: {
            ...effective.config,
            egress: {
              shell: [
                ...new Set([
                  ...(layers.user.egress?.shell ?? []),
                  ...(layers.local.egress?.shell ?? []),
                ]),
              ],
            },
          },
        }
      : effective,
    userStateDirectory(process.env),
    (note) => console.error(note),
    target.project,
  );
  const scan = volumeShell ? undefined : claude.scan;
  const telemetry = createTelemetry(config.telemetry, config.directory);
  let store: OrchestratorStore | undefined;
  let publisher: GoalPublisher | undefined;
  let observed: Awaited<ReturnType<typeof createObservedHost>> | undefined;
  let sessionId: string | undefined;
  let operator: Awaited<ReturnType<typeof listenOperatorApi>> | undefined;
  let interrupted = false;
  const stopOperator = async (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    await operator?.close().catch(() => {
      console.error("operator-api-close-failed");
    });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.kill(process.pid, signal);
  };
  const interrupt = () => void stopOperator("SIGINT");
  const terminate = () => void stopOperator("SIGTERM");
  setStage("open state");
  try {
    workplace?.signal.throwIfAborted();
    if (!volumeShell)
      store = OrchestratorStore.open(join(directory, "state.db"));
    console.log(`Audit database ${displayedAuditPath}`);
    if (!volumeShell && !workplace)
      console.log(
        target.isDefault
          ? `Inspect proposals and approvals from another host terminal with ${operatorCli}`
          : "Inspect proposals and approvals with the operator CLI and the same --target argument.",
      );
    setStage("open audited host");
    observed = await createObservedHost({
      config,
      auditPath,
      msb,
      profiles,
      claude,
      ...(codex
        ? {
            gatewayHosts: [
              ...new Set([...(effective.gatewayHosts ?? []), codex.host]),
            ],
          }
        : effective.gatewayHosts
          ? { gatewayHosts: effective.gatewayHosts }
          : {}),
      ...(codex
        ? {
            providerBindings: [
              ...(provider
                ? [{ provider, credentials: claudeCredential }]
                : []),
              {
                provider: codex,
                credentials: {
                  withAccessToken(consume, invocationId) {
                    if (!observed) throw new Error("Audited host unavailable");
                    return siwcSandboxCredential(observed.audit, (hooks) =>
                      siwcProvider({ checkout: bootstrapRoot, ...hooks }),
                    ).withAccessToken(consume, invocationId);
                  },
                },
              },
            ],
          }
        : provider
          ? { providers: [provider], credentials: claudeCredential }
          : {}),
      observers: [telemetry],
    });
    setStage("launch or clean up session");
    if (volumeShell) {
      const result = await observed.host.runVolumeShell(volumeShell);
      if (result.code) console.error(result.code);
      if (result.outcome !== "ok" || result.terminal?.exitCode !== 0)
        process.exitCode = 1;
      return;
    }
    if (!store) throw new Error("Concierge state unavailable");
    const host = observed.host;
    setStage("open operator API");
    publisher = new GoalPublisher(
      store,
      directory,
      repoRoot,
      githubGh(repoRoot, target.env, undefined, scan),
      effective.config.publish,
      scan,
    );
    const apiOptions = {
      store,
      publisher,
      stateDirectory: directory,
      target: repoRoot,
      repository: {
        project: target.project.name,
        repositoryPath: target.repositoryPath,
      },
      secretTests: () =>
        secretTestFacts(
          effective.config.secretEnv,
          userStateDirectory(process.env),
          baseImage,
        ),
      ...(scan ? { scan } : {}),
    };
    const launchSession = (
      sessionOptions: Pick<
        ConciergeOptions,
        "terminal" | "signal" | "stopOperatorWrites"
      > = {},
    ) => {
      setStage("launch or clean up session");
      publisher?.start(sessionOptions.signal);
      return startConcierge(
        {
          host,
          store: apiOptions.store,
          snapshot: snapshotConciergeRepo,
          ...(scan ? { scan } : {}),
          install,
          auth,
          config: effective.config,
          readHostChecks: () =>
            loadConfig({ ...process.env, MSB_HOME: home }, configDirectory)
              .config.hostChecks ?? [],
          baseImage,
          ...(effective.config.environment?.enabled
            ? {
                taskEnvironment: {
                  profile: profileLock.profiles.bun,
                  allow: effective.config.environment.allow ?? [],
                  requireAudit: host.requireTaskEnvironmentAudit.bind(host),
                  host: {
                    env: target.env,
                    store: new EnvironmentStore(target.project.id, target.env),
                    run(args, timeout, extra, signal) {
                      return systemHost.command(
                        "mise",
                        [...MISE_MSB, ...args],
                        {
                          ...offlineMiseEnv(target.env),
                          MSB_HOME: home,
                          ...extra,
                        },
                        timeout,
                        signal,
                      );
                    },
                  },
                },
              }
            : {}),
          note: (message) => console.error(message),
          ...(verificationConfig
            ? { verification: configuredVerification(verificationConfig) }
            : {}),
        },
        {
          ...options,
          ...sessionOptions,
          repoRoot,
          target,
          onSession: (id) => {
            sessionId = id;
            console.log(`Concierge session ${id}`);
          },
        },
      );
    };
    let result: Awaited<ReturnType<typeof startConcierge>>;
    if (workplace) {
      workplace.signal.throwIfAborted();
      result = await runWorkplace(
        {
          ...apiOptions,
          workplace,
          environment: createWorkplaceEnvironment({
            target,
            profile: profileLock.profiles.bun,
            host: systemHost,
            signal: workplace.signal,
            journal: store,
          }),
        },
        (terminal, stopOperatorWrites) =>
          launchSession({
            terminal,
            signal: workplace.signal,
            stopOperatorWrites,
          }),
        workplace.devBridge
          ? {
              loadAssets: loadWorkplaceAssets,
              printUrl: (url) => process.stdout.write(`${url}\n`),
            }
          : undefined,
      );
    } else {
      operator = await listenOperatorApi(apiOptions);
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      result = await launchSession();
    }
    console.log(
      `Concierge outcome ${result.outcome}, exit code ${result.exitCode ?? "unavailable"}`,
    );
    if (workplace)
      process.exitCode =
        result.exitCode === 0 && result.outcome !== "ok"
          ? 1
          : (result.exitCode ?? 1);
    else if (result.outcome !== "ok" || result.exitCode !== 0)
      process.exitCode = 1;
  } finally {
    credential = "";
    const closed = await Promise.allSettled([
      Promise.resolve().then(() => operator?.close()),
      Promise.resolve().then(() => publisher?.stop()),
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
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (closed.some(({ status }) => status === "rejected")) {
      console.error("concierge-shutdown-failed");
      process.exitCode ||= 1;
    }
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // main exposes fixed diagnostics and known recovery actions.
    console.error(
      error instanceof Error ? error.message : "Concierge launcher failed",
    );
    process.exitCode = 1;
  }
}
