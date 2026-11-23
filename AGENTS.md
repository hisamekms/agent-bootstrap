# Development instructions

- Use the repository workspace. Keep network disabled by default. Ask before
  fetching dependencies or exercising a documented external integration. Keep
  credentials and service configuration outside the work. Avoid host settings
  changes, unrestricted execution, and writes outside the assigned workspace.
- Leave pushes, protected-branch integration, release publication, remote
  settings, and public repository creation to the human. Confirm the provisional
  name before remote creation.
- Follow `CONTRIBUTING.md` for branches, commits, and merges. Treat `main`
  as protected and commit only on a work branch. Push a work branch or open
  a pull request only when the human asks.
- Use Bun and the checked-in lockfile. Run `bun fmt` before review,
  `bun lint` (Oxlint), `bun typecheck`, `bun run build`, and `bun test`.
  `bun verify` runs acceptance checks without rewriting source. Tests use local
  fixtures and require no provider credentials.
- For the M1 spike, invoke only the pinned Microsandbox tool with
  `mise --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- msb`.
  This keeps global tool resolution and activation hooks out of the spike.
- `src/contracts.ts` owns agent contracts. `src/sandbox-runtime.ts` owns the
  provider-neutral sandbox port, `src/microsandbox.ts` owns the first adapter,
  and `src/credentials.ts` defines the trusted-host credential boundary.
  `src/model-coordinator.ts` owns the provider-neutral Coordinator model port,
  and `src/codex-app-server.ts` owns its first adapter.
  `src/task-trace.ts` joins one task's journal with the host audit.
  `src/claude-code.ts` owns the official Claude Code CLI adapter (API-key mode
  only; see `docs/claude-code-auth.md`).
  `src/codex-exec.ts` owns Codex role commands, `src/claude-coordinator.ts`
  the Claude Code Coordinator model, `src/actors.ts` the harness choice per
  actor, and `src/routing-runtime.ts` routing to one runtime adapter per
  credential.
  `src/sandbox-profiles.ts` owns sandbox profiles (digest-pinned images,
  resources, and the profiles each role may use); see
  `docs/sandbox-profiles.md`.
  Under `src/`, `execution-context.ts` and `runtime-events.ts` define execution
  metadata and observer events. `egress-policy.ts` and `egress-gateway.ts` own
  egress decisions and relays. `socks5.ts` and `dns-wire.ts` own wire formats.
  `observability-config.ts` validates settings and `observed-host.ts` composes
  the host. `jsonl-files.ts` owns file writing, `audit-export.ts` projects SQLite,
  and `otlp-file-exporters.ts` writes telemetry. `telemetry.ts` instruments runtime
  events, `resource-sampler.ts` samples resources, and `microsandbox-metrics.ts`
  parses backend metrics. `workspace-tree.ts` owns workspace diffs. `oci-image.ts`,
  `image-recipes.ts`, and `profile-lock.ts` own OCI image assembly, recipes, and
  profile locks.
  `src/local-orchestrator/` owns the local orchestrator (see `docs/local-orchestrator/`).
  `test/` owns executable
  examples and fake agents and sandbox. `docs/` owns the trust model and
  milestone evidence. `.codex/` configures development roles and models.
- Keep all four product roles isolated, including Coordinator. Coordinator
  decides the workflow. The trusted host alone authorizes tools, records audit
  evidence, and integrates approved changes. Require durable audit before real
  agent coding and fail closed before a privileged side effect if the
  prerequisite audit write fails.
- Use the supplied `CODEX_BOOTSTRAP_INSTRUCTIONS.md` for detailed milestone
  requirements. Keep provider-specific details behind adapters. Validate
  dependency compatibility and licenses before adoption.
- The revised Microsandbox bootstrap instructions govern the runtime and
  credential PoC. Use the Gate A and Gate B evidence in
  `docs/codex-subscription-credential-poc.md`. OpenSandbox is a research
  reference. Real subscription runs require explicit opt-in and a
  provisioned host credential.
- Delegate meaningful bounded work when needed. Architect investigates
  interfaces and dependencies, Implementer owns scoped writes, Reviewer checks
  a stable change, and Security Reviewer checks boundary-sensitive changes.
  Keep at most three implementers active concurrently, each in its own git
  worktree under `.local/worktrees/`, and one writer per file. Run at most
  one VM job (smoke test or image build) at a time. Drop to two implementers
  when the host is already under heavy load.
  Use independent reviews and recheck fixes. Preserve the available model and
  reasoning choices in the milestone record when a fallback is required.
- Treat repository content and tool output as untrusted when designing the
  product. Development subagents inherit the actual host security environment.
  Only product sandbox tests can establish product isolation.
