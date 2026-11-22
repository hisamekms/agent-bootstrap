import {
  sameProvider,
  SandboxRuntimeError,
  type CollectedArtifacts,
  type CollectSpec,
  type ExecResult,
  type SandboxCommand,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRuntime,
  type SandboxSession,
  type SandboxSpec,
} from "./sandbox-runtime.ts";

export interface RuntimeRoute {
  /** The one provider binding this runtime serves; omit for the route used
   * by specs without provider egress. */
  readonly provider?: SandboxProvider;
  readonly runtime: SandboxRuntime;
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

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const route = this.#routes.find((candidate) =>
      sameProvider(candidate.provider, spec.provider),
    );
    if (!route) throw new SandboxRuntimeError("invalid-input");
    const handle = await route.runtime.create(spec);
    this.#owners.set(handle, route.runtime);
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

  collect(
    handle: SandboxHandle,
    spec: CollectSpec,
  ): Promise<CollectedArtifacts> {
    return this.#owner(handle).collect(handle, spec);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    return this.#owner(handle).destroy(handle);
  }
}
