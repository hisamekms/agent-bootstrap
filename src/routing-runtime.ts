import {
  sameProvider,
  SandboxRuntimeError,
  type CollectedArtifacts,
  type CollectSpec,
  type ConciergeVolumeBackend,
  type ExecResult,
  type ResourceSample,
  type SandboxCommand,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRuntime,
  type SandboxSession,
  type SandboxSpec,
  type TerminalAttachment,
  type TerminalCommand,
  type TerminalExit,
  type TerminalSink,
} from "./sandbox-runtime.ts";

export interface RuntimeRoute {
  /** The one provider binding this runtime serves; omit for the route used
   * by specs without provider egress. */
  readonly provider?: SandboxProvider;
  readonly runtime: SandboxRuntime & Partial<ConciergeVolumeBackend>;
}

/**
 * Sends each sandbox to the runtime adapter bound to its provider. A runtime
 * adapter is the host-side object that creates sandboxes; it lives for the
 * whole task and holds a single credential. Each sandbox (VM) it creates still
 * lives for one invocation: one planning, coding or review run, or one
 * Coordinator turn. Actors that use different model providers, and so
 * different credentials, need separate adapters behind one host.
 */
export class RoutingSandboxRuntime implements SandboxRuntime {
  readonly #routes: readonly RuntimeRoute[];
  readonly #owners = new WeakMap<SandboxHandle, SandboxRuntime>();

  constructor(routes: readonly RuntimeRoute[]) {
    for (const [index, route] of routes.entries())
      if (
        routes.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            sameProvider(other.provider, route.provider),
        )
      )
        throw new SandboxRuntimeError("invalid-input");
    // Copy and freeze each binding so later host changes cannot alter routing.
    this.#routes = Object.freeze(
      routes.map((route) =>
        Object.freeze({
          runtime: route.runtime,
          ...(route.provider
            ? { provider: Object.freeze({ ...route.provider }) }
            : {}),
        }),
      ),
    );
  }

  #owner(handle: SandboxHandle): SandboxRuntime {
    const owner = this.#owners.get(handle);
    if (!owner) throw new SandboxRuntimeError("unknown-handle");
    return owner;
  }

  #route(spec: SandboxSpec): SandboxRuntime {
    const route = this.#routes.find((candidate) =>
      sameProvider(candidate.provider, spec.provider),
    );
    if (!route) throw new SandboxRuntimeError("invalid-input");
    if (spec.interactive !== undefined && !route.runtime.attachTerminal)
      throw new SandboxRuntimeError("unsupported");
    return route.runtime;
  }

  netRuleDigest(spec: SandboxSpec): string {
    const runtime = this.#route(spec);
    if (!runtime.netRuleDigest) throw new SandboxRuntimeError("unsupported");
    return runtime.netRuleDigest(spec);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const runtime = this.#route(spec);
    if (
      (spec.egressGateway !== undefined ||
        spec.expectedNetRuleDigest !== undefined) &&
      !runtime.netRuleDigest
    )
      throw new SandboxRuntimeError("unsupported");
    const handle = await runtime.create(spec);
    this.#owners.set(handle, runtime);
    return handle;
  }

  async createBound(
    spec: SandboxSpec,
    sandboxId: string,
  ): Promise<SandboxHandle> {
    const runtime = this.#route(spec);
    if (!runtime.createBound || !runtime.netRuleDigest)
      throw new SandboxRuntimeError("unsupported");
    const handle = await runtime.createBound(spec, sandboxId);
    this.#owners.set(handle, runtime);
    return handle;
  }

  async exec(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<ExecResult> {
    return this.#owner(handle).exec(handle, command);
  }

  async openSession(
    handle: SandboxHandle,
    command: SandboxCommand,
  ): Promise<SandboxSession> {
    const owner = this.#owner(handle);
    if (!owner.openSession) throw new SandboxRuntimeError("unsupported");
    return owner.openSession(handle, command);
  }

  attachTerminal(
    handle: SandboxHandle,
    command: TerminalCommand,
  ): Promise<TerminalExit>;
  attachTerminal(
    handle: SandboxHandle,
    command: TerminalCommand,
    sink: TerminalSink,
  ): Promise<TerminalAttachment>;
  async attachTerminal(
    handle: SandboxHandle,
    command: TerminalCommand,
    sink?: TerminalSink,
  ): Promise<TerminalExit | TerminalAttachment> {
    const owner = this.#owner(handle);
    if (!owner.attachTerminal) throw new SandboxRuntimeError("unsupported");
    if (sink === undefined) return owner.attachTerminal(handle, command);
    const result = await owner.attachTerminal(handle, command, sink);
    if (!("terminal" in result)) throw new SandboxRuntimeError("unsupported");
    return result;
  }

  #volumeRuntime(): ConciergeVolumeBackend {
    // Volume operations have no handle. Prefer the Concierge provider's
    // backend, or require a unique volume backend in other deployments.
    const concierge = this.#routes.filter(
      ({ provider }) =>
        provider?.host === "api.anthropic.com" &&
        (provider.port ?? 443) === 443,
    );
    const routes = concierge.length
      ? concierge
      : this.#routes.filter(
          ({ runtime }) => runtime.createVolume && runtime.removeVolume,
        );
    const candidates = new Set(routes.map(({ runtime }) => runtime));
    const [runtime] = candidates;
    if (
      !runtime?.createVolume ||
      !runtime.removeVolume ||
      candidates.size !== 1
    )
      throw new SandboxRuntimeError("unsupported");
    return runtime as ConciergeVolumeBackend;
  }

  async createVolume(name: string): Promise<{ reused: boolean }> {
    return this.#volumeRuntime().createVolume(name);
  }

  async removeVolume(name: string): Promise<void> {
    await this.#volumeRuntime().removeVolume(name);
  }

  collect(
    handle: SandboxHandle,
    spec: CollectSpec,
  ): Promise<CollectedArtifacts> {
    return this.#owner(handle).collect(handle, spec);
  }

  async sampleResources(handle: SandboxHandle): Promise<ResourceSample | null> {
    return (await this.#owner(handle).sampleResources?.(handle)) ?? null;
  }

  finalResourceSample(handle: SandboxHandle): ResourceSample | null {
    return this.#owner(handle).finalResourceSample?.(handle) ?? null;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    return this.#owner(handle).destroy(handle);
  }
}
