# Observability dependencies

Pinned on 2026-11-23 (DEP-1). Every version is exact, and each is the latest
stable release that was at least 14 days old at fetch time. All are
Apache-2.0 unless noted.

## OpenTelemetry (runtime dependencies)

| Package                               | Version | Published  |
| ------------------------------------- | ------- | ---------- |
| `@opentelemetry/api`                  | 1.10.0  | 2026-10-20 |
| `@opentelemetry/core`                 | 3.1.0   | 2026-11-05 |
| `@opentelemetry/resources`            | 3.1.0   | 2026-11-05 |
| `@opentelemetry/sdk-trace`            | 3.1.0   | 2026-11-05 |
| `@opentelemetry/sdk-metrics`          | 3.1.0   | 2026-11-05 |
| `@opentelemetry/sdk-logs`             | 3.1.0   | 2026-11-05 |
| `@opentelemetry/otlp-transformer`     | 0.301.0 | 2026-11-05 |
| `@opentelemetry/semantic-conventions` | 1.45.0  | 2026-11-06 |

These are the only runtime packages installed, direct or transitive.
`otlp-transformer` 0.301 needs no protobuf runtime.

### Deviations from the plan

The plan assumed the 2.x line, with `sdk-trace-base` and `api-logs`. The 3.x
line changed both:

- `@opentelemetry/sdk-trace-base` is deprecated ("Use
  @opentelemetry/sdk-trace package"); its last release, 2.12.0, peers on
  `api <1.10`. The 3.x tracing SDK is `@opentelemetry/sdk-trace`.
- The 3.x logs SDK does not depend on `@opentelemetry/api-logs`, so it is not
  installed.
- `core`, `resources`, `sdk-trace`, `sdk-metrics` and `sdk-logs` are all
  3.1.0 (lockstep). `otlp-transformer` 0.301.0 is the matching release: it
  depends on exactly those five at 3.1.0. All of them peer on
  `@opentelemetry/api >=1.10.0 <1.11.0`.

API changes in 3.x that later tasks (OBS-13, OBS-14) must follow, as
exercised by `test/otel-compat.test.ts`:

- The tracer provider is `TracerProvider`; there is no `BasicTracerProvider`.
- Processors take an options object:
  - `new SimpleSpanProcessor({ exporter })`
  - `new SimpleLogRecordProcessor({ exporter })`
- `JsonTraceSerializer` (and the metric and log serializers) from
  `@opentelemetry/otlp-transformer` produce OTLP JSON.

Not added: `sdk-node`, auto-instrumentations and network exporters. The
telemetry exporters write OTLP JSON files.

## DuckDB CLI (analysis only, not a package dependency)

- **Version:** DuckDB 1.5.6 (released 2026-09-28, MIT), run through scoped
  mise:
  `mise --no-config --no-env --no-hooks exec duckdb@1.5.6 -- duckdb`.
- **Why 1.5.6:** 2.0.0 (2026-10-21) also passes mise's minimum release age,
  but it is a new major version. The plan targets 1.x, so the latest 1.x
  release was chosen.
- **What works offline:** the `json` and `parquet` extensions are statically
  linked, so `read_json` over JSONL works with no network. This was checked
  with `duckdb_extensions()`.
- **What does not:** `sqlite_scanner` is not installed and would need a
  download. This is why the audit is exported to JSONL instead of being read
  from SQLite directly.
