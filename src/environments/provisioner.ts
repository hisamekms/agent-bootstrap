import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { SqliteAudit, type AuditInput, type NetworkEvent } from "../audit.ts";
import { environmentDestination } from "../config/layers.ts";
import { EgressGateway, type EgressGatewayOptions } from "../egress-gateway.ts";
import { EgressPolicy } from "../egress-policy.ts";
import { withBuildSandbox } from "../image-build-sandbox.ts";
import { publishPrivateFile } from "../private-journal.ts";
import type { ProfileLockEntry } from "../profile-lock.ts";
import type { HostGateway } from "../trusted-host.ts";
import {
  EnvironmentError,
  GATEWAY_STOPS,
  identifyEnvironment,
  type EnvironmentOperation,
  type EnvironmentTree,
} from "./adapter.ts";
import { allowsEmptyLock, bunAdapter, environmentPath } from "./bun.ts";
import {
  emptyPackageDiff,
  type EnvironmentEvidence,
  type EnvironmentEvent,
} from "./events.ts";
import { runProvisionerGuest } from "./provisioner-guest.ts";
import { diffPackages, parseBunLock } from "./lock.ts";
import type { EnvironmentManifest, EnvironmentStore } from "./store.ts";

/** Package managers open many connections at once (Bun up to 16 here, see
 * bun.ts), so the Provisioner gets more headroom than a task VM. */
export const provisionerGatewayLimits = Object.freeze({
  attemptBurst: 128,
  attemptsPerSecond: 64,
  maxNetworkRows: 65_536,
});

export type ProvisionerCommand = (
  args: readonly string[],
  timeoutMs: number,
  environment?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ code: number | null; stdout: string; stderr?: string }>;

interface ProvisionerInput {
  readonly tree: EnvironmentTree & { pack(output: string): Promise<void> };
  readonly profile: ProfileLockEntry;
  readonly operation: EnvironmentOperation;
  readonly names?: readonly string[];
  readonly allow: readonly string[];
}

interface ProvisionerHost {
  readonly env: NodeJS.ProcessEnv;
  readonly store: EnvironmentStore;
  readonly run: ProvisionerCommand;
  readonly openGateway?: (
    options: EgressGatewayOptions,
  ) => Promise<HostGateway>;
  readonly openAudit?: (path: string) => SqliteAudit;
}

export function provisionerPolicy(allow: readonly string[]) {
  return new EgressPolicy({
    allow: [...bunAdapter.defaultEgress, ...allow.map(environmentDestination)],
  });
}

function checkInput(input: ProvisionerInput) {
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        !["tree", "profile", "operation", "names", "allow"].includes(
          String(key),
        ),
    ) ||
    Reflect.ownKeys(input.profile).some(
      (key) =>
        !["image", "recipeDigest", "memoryMiB", "cpus"].includes(String(key)),
    ) ||
    !/^localhost\/agent-bootstrap\/bun@sha256:[a-f0-9]{64}$/.test(
      input.profile.image,
    )
  )
    throw new EnvironmentError();
}

function networkEvidence(events: readonly NetworkEvent[]) {
  const allowed = new Map<string, string>();
  const reached = new Set<string>();
  let failed = false;
  for (const event of events) {
    if (
      event.phase === "decided" &&
      event.decision === "allow" &&
      event.hostname
    )
      allowed.set(
        event.connectionId,
        `${event.hostname}:${event.destinationPort}`,
      );
    else if (
      (event.phase === "decided" || event.phase === "dns") &&
      event.decision === "deny"
    )
      failed = true;
    else if (event.phase === "finished") {
      const destination = allowed.get(event.connectionId);
      if (destination && event.result === "connected") reached.add(destination);
      else if (event.result === "connect-failed") failed = true;
    }
  }
  return { reached: [...reached].sort(), failed };
}

class CommandFailure extends EnvironmentError {
  readonly canBeFetch: boolean;

  constructor(
    canBeFetch: boolean,
    fetchDiagnostic = false,
    lockMismatch = false,
  ) {
    super(
      lockMismatch
        ? "env-lock-mismatch"
        : fetchDiagnostic
          ? "env-fetch-failed"
          : "env-build-failed",
    );
    this.canBeFetch = canBeFetch;
  }
}

async function prepareProvisioner(
  { tree, profile, operation, names, allow }: ProvisionerInput,
  { store, openAudit }: ProvisionerHost,
) {
  try {
    const policy = provisionerPolicy(allow);
    const identity = await identifyEnvironment(
      tree,
      profile.image.slice(-64),
      bunAdapter,
    );
    const step = bunAdapter.command(
      operation,
      identity.lock !== undefined,
      names,
    );
    if (!step) throw new EnvironmentError();
    store.prepare();
    const path = join(store.directory, "audit.sqlite");
    try {
      await (await open(path, "wx", 0o600)).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (
      !info.isFile() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (info.mode & 0o777) !== 0o600
    )
      throw new EnvironmentError();
    const audit = (openAudit ?? ((filename) => new SqliteAudit(filename)))(
      path,
    );
    return { policy, identity, step, audit };
  } catch {
    throw new EnvironmentError();
  }
}

export async function provisionEnvironment(
  input: ProvisionerInput,
  host: ProvisionerHost,
) {
  checkInput(input);
  const { tree, profile, operation } = input;
  const { env, store } = host;
  const { policy, identity, step, audit } = await prepareProvisioner(
    input,
    host,
  );
  const invocationId = randomUUID();
  const { key, layout, lock, profileDigest } = identity;
  const started = performance.now();
  const write = (event: Omit<AuditInput, "invocationId" | "role">) =>
    audit.append({ ...event, invocationId, role: "Provisioner" });
  const record = async (
    kind: EnvironmentEvent["kind"],
    detail: EnvironmentEvidence,
  ) => {
    const event: EnvironmentEvent = { ...detail, kind, invocationId };
    write({ kind, detail });
    await publishPrivateFile(
      store.directory,
      `${invocationId}.${kind}.json`,
      JSON.stringify(event),
    );
  };

  let cache: EnvironmentManifest | undefined;
  let release: (() => void) | undefined;
  let staging: string | undefined;
  let archive: Uint8Array | undefined;
  let afterLock: Uint8Array | undefined;
  let outdated: string | undefined;
  let failure: EnvironmentError | undefined;
  let gateway: HostGateway | undefined;
  let packages: readonly string[] = [];
  let previousPackages: readonly string[] = [];
  let manifest: EnvironmentManifest | undefined;
  const initial = {
    key,
    operation,
    durationMs: 0,
    size: 0,
    cacheHit: false,
    destinationsReached: [],
    packageDiff: emptyPackageDiff,
    ...(step.warning && { warning: step.warning }),
  };
  try {
    cache = operation === "build" ? store.get(key) : undefined;
    if (cache)
      try {
        release = store.hold(key);
      } catch {
        // A concurrent prune is removing this entry: build it again.
        cache = undefined;
      }
    await record("environment.started", {
      ...initial,
      size: cache?.size ?? 0,
      cacheHit: !!cache,
    });
    try {
      const before = lock ? parseBunLock(lock) : [];
      packages = cache?.packages ?? before;
      previousPackages =
        operation === "build"
          ? ((cache ?? store.list()[0])?.packages ?? before)
          : before;
      manifest = cache;
      if (!cache) {
        if (
          !tree.paths.includes("package.json") ||
          layout.outputs.some(
            (output) =>
              !environmentPath(output) ||
              tree.paths.some(
                (path) => path === output || path.startsWith(`${output}/`),
              ),
          )
        )
          throw new EnvironmentError();
        const runDirectory = await mkdtemp(
          join(store.directory, ".provision-"),
        );
        staging = runDirectory;
        const source = join(runDirectory, "input");
        if (source.includes(":")) throw new EnvironmentError();
        await mkdir(source, { mode: 0o700 });
        await tree.pack(join(source, "tree.tar"));
        let packageCommand = false;
        await withBuildSandbox({
          profile: "bun",
          image: profile.image,
          digest: profileDigest,
          memoryMiB: profile.memoryMiB,
          cpus: profile.cpus,
          env,
          provisioner: {
            audit,
            invocationId,
            policy,
            inputDirectory: source,
            limits: provisionerGatewayLimits,
          },
          async openGateway(options) {
            const opened = await (host.openGateway ?? EgressGateway.open)(
              options,
            );
            gateway = opened;
            return opened;
          },
          async run(args, timeoutMs, environment, signal) {
            const result = await host.run(args, timeoutMs, environment, signal);
            if (result.code !== 0) {
              // Classify fixed diagnostics only. Guest output can contain private data.
              const diagnostic = packageCommand ? (result.stderr ?? "") : "";
              throw new CommandFailure(
                packageCommand,
                /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|FailedToDownload|ConnectionRefused|ConnectionClosed)\b|failed to (?:download|resolve)/i.test(
                  diagnostic,
                ) ||
                  /error: (?:GET|POST) .* - (?:401|403|404|429|5\d\d)\b/.test(
                    diagnostic,
                  ),
                /lockfile had changes|frozen lockfile/i.test(diagnostic),
              );
            }
            return result.stdout;
          },
          async use(name, run) {
            ({
              archive,
              lock: afterLock,
              outdated,
            } = await runProvisionerGuest(
              name,
              step,
              layout.outputs,
              layout.linkTargets,
              runDirectory,
              write,
              run,
              (active) => {
                packageCommand = active;
              },
            ));
          },
        });
        if (step.writesLock) {
          if (afterLock?.length) packages = parseBunLock(afterLock);
          else if (await allowsEmptyLock(tree, layout.keyFiles.length)) {
            afterLock = undefined;
            packages = [];
          } else throw new EnvironmentError("env-lock-mismatch");
        }
      }
      if (!audit.isV5Writable) throw new EnvironmentError();
      if (operation === "build" && archive)
        manifest = await store.publish(
          {
            key,
            adapter: bunAdapter.name,
            profileDigest,
            createdAt: new Date().toISOString(),
            size: archive.byteLength,
            packages,
            hasLock: lock !== undefined,
          },
          archive,
        );
    } catch (error) {
      failure =
        error instanceof EnvironmentError ? error : new EnvironmentError();
    }
    const network = networkEvidence(
      audit.readExecution(invocationId).networkEvents,
    );
    if (
      failure instanceof CommandFailure &&
      failure.canBeFetch &&
      failure.code !== "env-lock-mismatch" &&
      network.failed
    )
      failure = new EnvironmentError("env-fetch-failed");
    // A gateway that stopped every flow explains the failure better than the
    // package manager's own message.
    const stopped = gateway?.quarantineReason;
    const gatewayStopped = GATEWAY_STOPS.find((reason) => reason === stopped);
    // Only budget stops are fetch problems; audit and listener stops are host
    // faults, so they keep their code and only add the reason.
    if (failure && gatewayStopped)
      failure = new EnvironmentError(
        gatewayStopped === "rate-limited" ||
          gatewayStopped === "network-row-limit"
          ? "env-fetch-failed"
          : failure.code,
        gatewayStopped,
      );
    const size = manifest?.size ?? archive?.byteLength ?? 0;
    const detail = {
      ...initial,
      durationMs: Math.round(performance.now() - started),
      size,
      cacheHit: !!cache,
      destinationsReached: network.reached,
      packageDiff: failure
        ? emptyPackageDiff
        : diffPackages(previousPackages, manifest?.packages ?? packages),
      ...(failure && { failure: failure.code }),
      ...(failure?.gatewayStopped && {
        gatewayStopped: failure.gatewayStopped,
      }),
    };
    await record("environment.finished", detail);
    if (failure) throw failure;
    return {
      ...detail,
      manifest,
      archive: manifest ? undefined : archive,
      lock: afterLock,
      outdated,
    };
  } catch (error) {
    throw error instanceof EnvironmentError ? error : new EnvironmentError();
  } finally {
    try {
      release?.();
      if (staging) await rm(staging, { recursive: true, force: true });
    } finally {
      audit.close();
    }
  }
}
