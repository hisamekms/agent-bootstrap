import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { AuditStoreError, SqliteAudit } from "./audit.ts";
import { EgressGateway, type EgressGatewayOptions } from "./egress-gateway.ts";
import { EgressPolicy } from "./egress-policy.ts";
import {
  MICROSANDBOX_LIMITS,
  MicrosandboxRuntime,
  type MicrosandboxConfig,
} from "./microsandbox.ts";
import { parseObservabilityConfig } from "./observability-config.ts";
import { RoutingSandboxRuntime } from "./routing-runtime.ts";
import type {
  SandboxHandle,
  SandboxProvider,
  SandboxRuntime,
  SandboxSpec,
} from "./sandbox-runtime.ts";
import {
  TrustedHost,
  type ClaudeHostPolicy,
  type HostGateway,
  type HostObserver,
} from "./trusted-host.ts";

export interface ObservedHostObserver extends HostObserver {
  startResourceSampling?(
    executionId: string,
    handle: SandboxHandle,
    runtime: Pick<SandboxRuntime, "sampleResources">,
  ): void;
}

export interface ObservedHostOptions {
  readonly config: unknown;
  readonly auditPath: string;
  readonly msb: Pick<MicrosandboxConfig, "binary" | "home" | "stagingRoot">;
  readonly profiles: MicrosandboxConfig["profiles"];
  readonly credentials?: MicrosandboxConfig["credentials"];
  readonly gatewayHosts?: readonly string[];
  readonly providers?: MicrosandboxConfig["providers"];
  /** One credential per binding. Exclusive with credentials and providers. */
  readonly providerBindings?: readonly {
    readonly provider: SandboxProvider;
    readonly credentials: NonNullable<MicrosandboxConfig["credentials"]>;
  }[];
  readonly observers?: readonly ObservedHostObserver[];
  readonly claude?: ClaudeHostPolicy;
  /** Host-side override for fixtures. The same factory serves startup and runs. */
  readonly openGateway?: (
    options: EgressGatewayOptions,
  ) => Promise<HostGateway>;
}

const startupMessages = {
  "microsandbox-version-check-failed": "Microsandbox version check failed",
  "microsandbox-version-mismatch": "Microsandbox 0.7.16 required",
  "gateway-startup-failed": "Egress gateway startup check failed",
} as const;

export class ObservedHostStartupError extends Error {
  readonly code: keyof typeof startupMessages;

  constructor(code: keyof typeof startupMessages) {
    super(startupMessages[code]);
    this.code = code;
  }
}

const runFile = promisify(execFile);

async function checkVersion(msb: ObservedHostOptions["msb"]): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await runFile(msb.binary, ["--version"], {
      cwd: msb.home,
      env: { PATH: "/usr/bin:/bin", MSB_HOME: msb.home, MSB_BACKEND: "local" },
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: MICROSANDBOX_LIMITS.backendTimeoutMs,
      maxBuffer: 1024,
    }));
  } catch {
    throw new ObservedHostStartupError("microsandbox-version-check-failed");
  }
  if (stdout.trim() !== "msb 0.7.16")
    throw new ObservedHostStartupError("microsandbox-version-mismatch");
}

class ObservedRuntime extends MicrosandboxRuntime {
  readonly #onCreated: (spec: SandboxSpec, handle: SandboxHandle) => void;
  readonly #required: boolean;
  readonly #assertOpen: () => void;

  constructor(
    config: MicrosandboxConfig,
    onCreated: (spec: SandboxSpec, handle: SandboxHandle) => void,
    required: boolean,
    assertOpen: () => void,
  ) {
    super(config);
    this.#onCreated = onCreated;
    this.#required = required;
    this.#assertOpen = assertOpen;
  }

  override async create(spec: SandboxSpec) {
    this.#assertOpen();
    if (this.#required) throw new Error("Audited sandbox binding required");
    const handle = await super.create(spec);
    this.#onCreated(spec, handle);
    return handle;
  }

  override async createBound(spec: SandboxSpec, sandboxId: string) {
    this.#assertOpen();
    const handle = await super.createBound(spec, sandboxId);
    this.#onCreated(spec, handle);
    return handle;
  }
}

export async function createObservedHost({
  config: input,
  auditPath,
  msb,
  profiles,
  claude,
  credentials,
  providers,
  gatewayHosts = [],
  providerBindings,
  observers = [],
  openGateway = EgressGateway.open,
}: ObservedHostOptions): Promise<{
  host: TrustedHost;
  audit: SqliteAudit;
  /** Read-only runtime capability. Sandbox lifecycle operations go through host. */
  runtime: Readonly<Pick<MicrosandboxRuntime, "sampleResources">>;
  /** Wait for normal invocations to finish before closing their host. */
  close(): Promise<void>;
}> {
  const config = parseObservabilityConfig(input, {
    msbHome: msb.home,
    stagingRoot: msb.stagingRoot,
  });
  const required = config.audit.mode === "required";
  const networkLimits = config.audit.network;
  if (
    providerBindings !== undefined &&
    (credentials !== undefined || providers !== undefined)
  )
    throw new Error("Conflicting observed host provider configuration");
  const audit = new SqliteAudit(auditPath);
  const gateways = new Set<Promise<HostGateway>>();
  let closing: Promise<void> | undefined;

  async function gatewayFactory(
    options: EgressGatewayOptions,
  ): Promise<HostGateway> {
    if (closing) throw new Error("Observed host is closing");
    const opening = Promise.resolve()
      .then(() =>
        openGateway({
          ...options,
          limits: { ...options.limits, ...networkLimits },
        }),
      )
      .then((gateway) => {
        let closed: Promise<void> | undefined;
        return {
          get socksPort() {
            return gateway.socksPort;
          },
          get dnsPort() {
            return gateway.dnsPort;
          },
          get username() {
            return gateway.username;
          },
          get password() {
            return gateway.password;
          },
          get quarantined() {
            return gateway.quarantined || closing !== undefined;
          },
          close() {
            return (closed ??= Promise.resolve()
              .then(() => gateway.close())
              .then(() => {
                gateways.delete(opening);
              }));
          },
        };
      });
    gateways.add(opening);
    let gateway: HostGateway;
    try {
      gateway = await opening;
    } catch (error) {
      gateways.delete(opening);
      throw error;
    }
    if (closing) throw new Error("Observed host is closing");
    return gateway;
  }

  try {
    if (!audit.isV5Writable) throw new AuditStoreError("read-only");

    const activeObservers = config.telemetry.enabled ? [...observers] : [];
    const pendingHandles = new Map<string, SandboxHandle | undefined>();
    const samplingObservers: HostObserver[] = [];
    for (const observer of activeObservers) {
      if (!observer.startResourceSampling) continue;
      samplingObservers.push({
        observe(event) {
          if (
            event.eventType !== "sandbox.created" ||
            event.payload.outcome !== "succeeded" ||
            event.executionId === undefined
          )
            return;
          const handle = pendingHandles.get(event.executionId);
          if (handle && handle.id === event.sandboxId)
            return observer.startResourceSampling?.(
              event.executionId,
              handle,
              samplingRuntime,
            );
        },
      });
    }
    if (samplingObservers.length) {
      samplingObservers.push({
        observe(event) {
          const id = event.executionId;
          if (id === undefined) return;
          if (event.eventType === "execution.started")
            pendingHandles.set(id, undefined);
          if (
            event.eventType === "sandbox.created" ||
            event.eventType === "execution.finished"
          )
            pendingHandles.delete(id);
        },
      });
    }
    const createRuntime = (
      credentials?: MicrosandboxConfig["credentials"],
      providers?: MicrosandboxConfig["providers"],
    ) =>
      new ObservedRuntime(
        {
          binary: msb.binary,
          home: msb.home,
          stagingRoot: msb.stagingRoot,
          profiles,
          gatewayHosts,
          ...(credentials === undefined ? {} : { credentials }),
          ...(providers === undefined ? {} : { providers }),
          ...(required
            ? {
                gatewayPassword: (binding): string =>
                  host.gatewayPassword(binding),
              }
            : {}),
        },
        (spec, handle) => {
          const id = spec.invocationId;
          // The adapter keys its VM state by handle identity. The observer
          // receives that handle after TrustedHost records the create outcome.
          if (id !== undefined && pendingHandles.has(id))
            pendingHandles.set(id, handle);
        },
        required,
        () => {
          if (closing) throw new Error("Observed host is closing");
        },
      );
    const runtime =
      providerBindings === undefined
        ? createRuntime(credentials, providers)
        : new RoutingSandboxRuntime([
            { runtime: createRuntime() },
            ...providerBindings.map(({ provider, credentials }) => ({
              provider,
              runtime: createRuntime(credentials, [provider]),
            })),
          ]);
    const samplingRuntime = Object.freeze({
      sampleResources: runtime.sampleResources.bind(runtime),
    });
    const host = new TrustedHost(audit, runtime, profiles, {
      config,
      gatewayHosts,
      observers: [...activeObservers, ...samplingObservers],
      ...(required ? { gatewayFactory } : {}),
      ...(claude ? { claude } : {}),
    });

    if (required) {
      await checkVersion(msb);
      try {
        const probe = await openGateway({
          executionId: randomUUID(),
          sandboxLabel: `bootstrap-${randomUUID()}`,
          policy: new EgressPolicy({ allow: [] }),
          audit,
          limits: networkLimits,
        });
        try {
          if (probe.quarantined !== false)
            throw new Error("Gateway quarantined");
        } finally {
          await probe.close();
        }
      } catch (error) {
        if (error instanceof AuditStoreError) throw error;
        throw new ObservedHostStartupError("gateway-startup-failed");
      }
      if (!audit.isV5Writable) throw new AuditStoreError("read-only");
    }

    return {
      host,
      audit,
      runtime: samplingRuntime,
      close() {
        return (closing ??= Promise.resolve().then(async () => {
          const results = await Promise.allSettled(
            [...gateways].map(async (opening) => {
              const gateway = await opening.catch(() => undefined);
              await gateway?.close();
            }),
          );
          if (results.some((result) => result.status === "rejected"))
            throw new Error("Egress gateway shutdown failed");
          audit.close();
        }));
      },
    };
  } catch (error) {
    audit.close();
    throw error;
  }
}
