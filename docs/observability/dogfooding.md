# OBS-16 dogfooding

## Offline fixture

From the repository root, with Bun and the checked-in dependencies already
installed and DuckDB 1.5.6 present in mise:

```sh
bun spike/obs/dogfood-scenarios.ts --fixture
```

The driver runs a synthetic Worker for each provider binding. It uses the real
`createObservedHost` in required mode, the Microsandbox adapter against a
scripted backend, the runtime's terminal sampler, SQLite, and the OTLP and
audit JSONL exporters. The fixture gateway uses the product's egress policy,
DNS pins and durable audit API. Its effects are in-memory records and
counters. This command needs no sockets, VM, model credential or network.
Fixture artifacts are retained under the private `.local/obs16-*` directories
printed on stdout.

Each execution closes its telemetry and audit writers, exports the audit, and
loads both shared SQL files using the offline
`mise --no-config --no-env --no-hooks exec duckdb@1.5.6 -- duckdb` CLI.
The driver prints each execution ID and its passing assertions. It exits
nonzero if any answer is missing or wrong. The two normal executions share one
audit and export directory so the comparison queries can associate each
duration, startup ratio, CPU time and memory reading with its execution ID.
Resource figures come from scripted metrics.

| Scenario                        | Required answer                                                                                                                                                                                                                                                                                  | Fixture result | Coordinator evidence                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------- |
| Normal coding task              | Audit records binding, create, process result, artifact collection and destroy. The trace shows the execution and its child spans. The provider destination and DNS allow appear under the same execution ID.                                                                                    | Pass           | Execution IDs and DuckDB rows pending |
| Policy denial                   | The unapproved TCP destination has a deny decision, no upstream effect and no relay finish. The random DNS name has an audited denial with no answers.                                                                                                                                           | Pass           | Execution IDs and DuckDB rows pending |
| Timeout                         | The durable outcome is `timed-out`. The execution span is `timed_out` with error status and a `resource.limit_exceeded` event.                                                                                                                                                                   | Pass           | Execution IDs and DuckDB rows pending |
| Start failure                   | A missing image fails the create operation and its span. The audit has no process or gateway traffic for that execution.                                                                                                                                                                         | Pass           | Execution IDs and DuckDB rows pending |
| Process failure                 | The failed execution retains guest-reported exit code 23.                                                                                                                                                                                                                                        | Pass           | Execution IDs and DuckDB rows pending |
| Forced termination              | The driver aborts an in-flight command after the modeled relay opens. The execution remains queryable and the relay ends with `sandbox-destroyed`.                                                                                                                                               | Pass           | Execution IDs and DuckDB rows pending |
| Audit failure                   | A duplicate flow ID triggers a real SQLite transaction failure. The writer becomes unwritable and the fixture gateway quarantines itself. The host halts the command, removes the sandbox through emergency cleanup, and the export preserves the earlier allowed decision with unknown outcome. | Pass           | Execution IDs and DuckDB rows pending |
| Telemetry failure               | A regular file at the trace directory path prevents trace export deterministically. The audit is complete, the metrics file contains a nonzero drop counter, and stderr contains the diagnostic.                                                                                                 | Pass           | Execution IDs and DuckDB rows pending |
| Compare executions              | Codex and Claude fixture samples can be compared on duration, startup overhead, CPU time and memory.                                                                                                                                                                                             | Pass           | DuckDB comparison pending             |
| Audit and trace cross-reference | The joins by execution ID and by the durable context's trace ID select the same spans for the fixture execution.                                                                                                                                                                                 | Pass           | Execution IDs and DuckDB rows pending |

### Implementer fixture evidence

All 16 executions passed. The following execution IDs identify the
synthetic records from this run.

| Scenario           | Codex                                  | Claude                                 |
| ------------------ | -------------------------------------- | -------------------------------------- |
| normal             | `f6af38a0-f90c-4400-ab90-3befb4da0877` | `31b462b7-4df8-4090-8adf-660b290c5ec4` |
| policy-denial      | `3a263da1-b815-474f-9339-8631a88d2dd3` | `6b365206-6376-413b-89f8-2aaa5b6eaccd` |
| timeout            | `f2b4d9e1-4f56-4a10-98fc-6f8f22365a2b` | `042d090a-b1f8-4840-89f1-9db798408ae2` |
| start-failure      | `e7fd012b-c0ea-4804-8bdb-c2b64b0182ba` | `35ecd671-afe2-4798-b046-f2ac99e7c0c7` |
| process-failure    | `c08269ce-bb4c-4e82-a6e3-9cef0f9ba03b` | `a6e247de-e1a7-450e-b88f-0b1e03f5d4a4` |
| forced-termination | `a01fbf9f-ac05-4233-857f-46b42064c23f` | `a5a96162-a166-417a-83aa-f2c8ec994bb2` |
| audit-failure      | `14a5d5af-5e88-419f-bb20-f788a6b28200` | `2da31f10-dfdf-41d8-8c48-b9d1a08b1b1f` |
| telemetry-failure  | `479dfdb5-ec7c-4aa2-a93c-e4cd476010da` | `4ac9f35a-e9f0-410f-9e9c-3b89c7093c5c` |

DuckDB returned these comparison rows. Duration and startup are wall-clock
fixture timings. CPU and memory are scripted values.

| Fixture | Duration (ms) | Startup (ms) | Startup ratio | CPU (ns) | Memory and peak (bytes) |
| ------- | ------------: | -----------: | ------------: | -------: | ----------------------: |
| claude  |        135.05 |        62.02 |        0.4593 |    30000 |                    8192 |
| codex   |        140.81 |        65.02 |        0.4617 |    20000 |                    4096 |

For the normal Codex execution, DuckDB reported an `ok` outcome, 24
durable audit records, zero derived records and 120 matches in each
audit-to-trace join. Its outbound destination was `192.0.2.11:443` with
channel `provider-egress`, one allowed and connected attempt, and no
unknown outcomes.

The forced-termination fixture uses the host cancellation path. The
coordinator's VM check for externally issued removal and real relay behavior
is pending. The sink and filesystem faults exercise fixture behavior under failure
conditions. See the [ADR](adr-0001-observability.md) and
[network audit matrix](network-audit-matrix.md) for the scope of connection
visibility.

To inspect the retained rows for any run, use the directory and execution ID
from the driver output. For the telemetry failure runs the directory is
`<telemetry failure root>/codex` or `<telemetry failure root>/claude`.

```sh
bun spike/obs/dogfood-scenarios.ts --analyze "$OBS_DIR" "$EXECUTION_ID"
```

Repository verification passed for the three owned files and the socket-free
test suite. Lint reported an existing warning in `src/sandbox-runtime.ts`.
The gateway socket test file requires loopback binding.

```sh
bun fmt spike/m5/dogfood.ts spike/obs/dogfood-scenarios.ts docs/observability/dogfooding.md
bun lint
bun typecheck
bun run build
bun test --timeout 60000 $(rg --files test -g '*.test.ts' -g '!egress-gateway.test.ts')
```

The test command reported 415 passing tests across 35 files. The pinned
DuckDB schema smoke, `bun spike/obs/duckdb-smoke.ts`, passed all 15 checks.

## Live M5 operator checklist

Run these commands only after the operator approves the provider, credential
use and VM run and the coordinator confirms the preceding network evidence
gates. Use a terminal and run one command at a time. Use a dedicated local
`MSB_HOME`, the installed pinned Microsandbox 0.7.16 binary and cached,
digest-pinned images. Set `MSB` and `CODEX_BINARY` to absolute paths.
The live runner uses the synthetic `hello.txt` task and creates a temporary
repository under `.local`. Review the candidate at the approval prompt.

1. For a Codex Worker, opt in via the launcher. On macOS, optionally add
   `--keychain` after `--authorize-and-run-m5` to reuse browser consent on later
   runs. The launcher passes the access token over stdin. Set `MSB_HOME` to a
   short absolute path outside the repository. A path under this repository is
   too long for macOS's 104-byte Unix socket path limit.
   Follow the [subscription credential procedure](../codex-subscription-credential-poc.md).

   ```sh
   M5_ACTORS=all=codex MSB_HOME="$MSB_HOME" \
     bun spike/m1/subscription-authorize.ts --authorize-and-run-m5 \
       "$MSB" "$CODEX_BINARY"
   ```

   Set `M5_DEBUG_WORKER=1` to capture up to 4096 bytes of stderr from a
   failing live Codex Worker. M5 prints only the path to the private local
   `worker-stderr-<invocation id>.txt` file in the run directory (mode 0600).
   Treat this file as sensitive. The guest sees a credential placeholder,
   which Microsandbox replaces with the real token at egress.

2. For a Claude Worker, use Claude Code API-key mode and the macOS Keychain
   item for account `$USER`. Supply the service name via
   `M5_CLAUDE_KEYCHAIN` and the pinned binary via `M5_CLAUDE_BINARY`.
   The M5 positional interface still takes an absolute Codex binary path.
   Follow the [Claude Code credential procedure](../claude-code-auth.md).

   ```sh
   M5_ACTORS=all=claude M5_CLAUDE_AUTH=api-key \
     M5_CLAUDE_KEYCHAIN="$CLAUDE_KEYCHAIN_SERVICE" \
     M5_CLAUDE_BINARY="$CLAUDE_BINARY" MSB_HOME="$MSB_HOME" \
     bun spike/m5/dogfood.ts --live "$MSB" "$CODEX_BINARY"
   ```

3. For each run, record the Worker execution ID from `report.json` in the
   parent of the printed observability directory. Pass that directory to
   `--analyze`. Check for a complete
   lifecycle, successful process outcome, provider egress and DNS, and an
   audit-to-span match by execution ID. For the durable-context join, also run
   the analyzer with a Coordinator execution ID. Compare the Worker rows
   across the two exports for duration, startup overhead, and CPU and memory
   samples. Record missing samples as unavailable.
4. Confirm the report says `auditExported: true`, inspect `input_issues`
   and retain only reviewed evidence from the exports. Keep credentials and
   host configuration outside the artifacts. Check sandbox cleanup and the
   launcher credential lifecycle using the existing operator procedures.
5. Record any further live scenario evidence from the network audit matrix,
   including in-flight external removal, separately from the fixture results.

| Live claim                                           | Codex evidence | Claude evidence |
| ---------------------------------------------------- | -------------- | --------------- |
| Command outcome, role execution IDs and audit export | Pass (1)       | Pending         |
| Lifecycle, provider TCP and DNS rows                 | Pass (1)       | Pending         |
| Audit and trace joins and Worker resource comparison | Partial (1)    | Pending         |
| External termination and abnormal records            | Pending        | Pending         |
| Evidence review and cleanup                          | Pass (1)       | Pending         |

### Codex live evidence

(1) On 2026-11-23, M5 completed live with `M5_ACTORS=all=codex`, model
`gpt-6.2-sol` with the derived catalog, gateway egress, and the
Keychain-stored refresh token (`--keychain`, no browser consent). Task
`dca9b351-0507-488c-a494-5365e2af542c` finished `done` in 72.8 seconds
with three Coordinator turns, one Worker, one Reviewer, no revisions, no
retries and one approval. The repository's `hello.txt` now reads
`Good day.`. The operator delegated the approval gate to the coordinating
agent, which approved the one-line candidate after checking it against the
task. The prompt, diff, reason and answer are in the run's local
`gate-answers.md`.

| Role         | Execution ID                           | Seconds |
| ------------ | -------------------------------------- | ------: |
| Coordinator  | `0690b49a-09a8-4633-bc7b-a9546d140548` |   12.05 |
| Worker       | `a3c5db79-80ec-459b-b087-a6c3860fec0c` |   16.78 |
| Coordinator  | `3cdac9f6-a8f6-4a05-8242-75c6080bfd54` |    9.40 |
| Reviewer     | `bae9f3da-7db8-4521-aa4f-f2f4d482fa42` |    9.28 |
| Coordinator  | `c265dce6-f57f-4b0f-bde6-dabb72e15d58` |    8.20 |
| Verification | `66c35f82-42e9-4b03-8bcc-b7ee18902cc4` |    0.50 |

- The report says `auditExported: true`. Every model-driven role shows
  create, exec and destroy finished `ok` and a `provider.egress` grant.
  Verification has no egress.
- Each model-driven role connected only to `api.openai.com:443` on channel
  `provider-egress`. The Worker made three connections (55–58 KB sent,
  76–94 KB received). DNS for `chatgpt.com`, `ab.chatgpt.com` and
  `api.github.com` was denied with `dns-not-allowlisted`. The second
  Coordinator turn's relay ended with `error` although its turn succeeded.
- For the Worker, the audit-to-trace join matched 285 rows by execution ID.
  The durable-context join matched 180 rows for the first Coordinator
  turn and none for the Worker, which has no durable context of its own.
  The Worker used 2.06 s CPU and 90 MB peak memory with a 6.1% startup
  ratio. The Coordinator used 1.96 s CPU and 87 MB with a 9.0% ratio.
  A Claude run is still needed for the cross-provider comparison.
- No sandboxes remained in the dedicated `MSB_HOME`. The run lock was
  released, and the refresh token stayed in the Keychain as intended.
- External termination was not exercised live.

Earlier live attempts on the same day found two problems.

- A repository-local `MSB_HOME` exceeded the 104-byte Unix socket limit.
- The Worker's `codex exec` failed with HTTP 400
  `subscription_sharing_unsupported_capability`, because subscription
  sharing rejects `tool_search`. `M5_DEBUG_WORKER=1` exposed the error, and
  the derived catalog now disables `supports_search_tool`.
