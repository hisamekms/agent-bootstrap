# agent-bootstrap

An experimental TypeScript bootstrap for auditable multi-agent software development.
The current baseline provides provider-neutral role contracts, an offline
Microsandbox runtime, and a trusted Worker host with SQLite audit records.

```sh
bun install --frozen-lockfile --ignore-scripts
bun fmt
bun lint
bun typecheck
bun run build
bun test
```

Use Bun 1.4.4. `bun verify` runs the non-mutating format check, lint, typecheck,
build, and tests. The build emits JavaScript and TypeScript declarations in
`dist/`.

The intended MVP runs Coordinator, Planner, Worker, and Reviewer in separate
sandbox invocations. Coordinator chooses when to delegate or ask a human. A
trusted host enforces permissions, persists audit evidence, and integrates
changes after human approval. The local [Worker audit smoke test](docs/milestones.md#m2-trusted-worker-and-durable-audit)
covers authorization and trace inspection. The [reviewed integration smoke](docs/milestones.md#m3-reviewed-integration)
uses a disposable repository and requires an explicit terminal decision.
The [runtime smoke test](docs/microsandbox-runtime.md) and
[subscription credential PoC](docs/codex-subscription-credential-poc.md)
record the verified sandbox and synthetic Codex paths.

DAGQ Lite architecture, a fixed role sequence, distributed scheduling, remote
workers, and a dashboard are outside the MVP scope. See the
[trust model](docs/trust-model.md) and [milestone checks](docs/milestones.md).

Licensed under the [MIT License](LICENSE). The project is experimental and
provided as is, with no guaranteed maintenance, support, or security updates.
