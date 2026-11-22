# Claude Code on Microsandbox PoC

## Tested versions

| Component    | Version and source                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microsandbox | 0.7.16, pinned through mise                                                                                                                                                                                                                 |
| Guest image  | Alpine 3.23.8 arm64, digest-pinned                                                                                                                                                                                                          |
| Claude Code  | 2.1.330, build `linux-arm64-musl` from `downloads.claude.ai/claude-code-releases`. SHA-256 `986b8355…348a`, which matches the release manifest.                                                                                             |
| Guest shell  | bash 5.3.3-r1, readline 8.3.1-r0, libncursesw and ncurses-terminfo-base 6.5_p20251123-r0, from the Alpine v3.23 main mirror. The SHA-256 digests are pinned in `src/claude-code.ts`, and `apk` checks the signatures with the image's keys. |

The CLI binary links only musl libc. On this image it needs bash, which the
image lacks. In the guest, `claude --version` prints `2.1.330 (Claude Code)`.

## Phase 0 capability matrix

The results were verified on 2026-11-22.

| Capability                                             | Result                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret held on the host and substituted by the backend | Supported as-is                                                        | `msb create --secret ENV[:OPTIONS]@HOST`. The value comes from the host environment at create time, and the guest gets a placeholder.                                                                                                                                                                                                                                 |
| `x-api-key` substitution                               | Supported as-is (`headers=x-api-key`); verified against a fixture host | In the smoke, every Messages request reached the stand-in with the synthetic key in `x-api-key` and no `Authorization` header.                                                                                                                                                                                                                                        |
| Streaming (SSE) through the TLS proxy                  | SSE framing verified against a fixture host                            | The CLI sent `stream: true`. The stand-in wrote each event separately, 50 ms apart, and the streamed text and tool calls round-tripped. Whether the proxy forwards events incrementally was not measured.                                                                                                                                                             |
| Trust in the guest CA for the CLI                      | Supported as-is                                                        | The backend sets `NODE_EXTRA_CA_CERTS=/.msb/tls/ca.pem`, and the adapter passes it through `env -i`.                                                                                                                                                                                                                                                                  |
| Destination scope (host and port)                      | Adapter needed (implemented)                                           | Network rules allow DNS plus one host and port. The adapter binds each credential to configured `providers` entries: host, variable, header, port and CA must all match.                                                                                                                                                                                              |
| Method, path or request-count scope                    | Upstream extension needed                                              | The backend matches host and header only.                                                                                                                                                                                                                                                                                                                             |
| Unapproved destination                                 | Verified for one case                                                  | An HTTP listener on another host port received no request.                                                                                                                                                                                                                                                                                                            |
| Direct IP, IPv6, LAN, metadata, redirects              | Unverified                                                             | Deferred with Gate B.                                                                                                                                                                                                                                                                                                                                                 |
| Real key absent from the guest                         | Verified with a synthetic key                                          | After the CLI ran in the same VM, the full key matched nothing in `/proc/*/environ`, `/proc/*/cmdline`, `/tmp`, `/root`, `/etc` or `/.msb`. The guest variable held the placeholder.                                                                                                                                                                                  |
| Real key absent from output and host files             | Verified with a synthetic key                                          | The key was absent from all captured stdout and from the stderr of the probe's wrapper script. The adapter sends the CLI's own stderr to `/dev/null`, so that stream was not inspected. A scan found the key in no file under 64 MiB under the run directory (including `audit.sqlite`) or under `MSB_HOME`. Larger files, such as VM disks and images, were skipped. |
| Planted repository settings ignored                    | Adapter needed (implemented)                                           | `--setting-sources ''` is required: `--bare` alone still applied a planted `env` block. With the flag, the planted hooks, `env` and `apiKeyHelper` were all ignored.                                                                                                                                                                                                  |
| Concurrent sandboxes                                   | Verified for two                                                       | Two Planner VMs ran in parallel with separate config directories and both succeeded.                                                                                                                                                                                                                                                                                  |
| CPU and memory limits                                  | Backend supports them, adapter does not                                | `--cpus` and `--memory` exist, but the adapter does not pass them yet.                                                                                                                                                                                                                                                                                                |
| Real `api.anthropic.com` traffic                       | Unverified                                                             | No real key was authorized.                                                                                                                                                                                                                                                                                                                                           |

The Claude Code facts come from the official docs, read on 2026-11-22:

- [Authentication](https://code.claude.com/docs/en/authentication.md):
  - The CLI checks credentials in a documented order. `ANTHROPIC_AUTH_TOKEN`
    and `ANTHROPIC_API_KEY` come before `apiKeyHelper` and before CLI-managed
    credentials.
  - `ANTHROPIC_API_KEY` is sent as `X-Api-Key`.
  - In `-p` mode the key is used without an approval prompt.
- [Headless mode](https://code.claude.com/docs/en/headless.md): `--bare`
  never reads OAuth credentials or the keychain.
- [Environment variables](https://code.claude.com/docs/en/env-vars.md):
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` disables updates, telemetry,
  error reporting and feature-flag fetches.
- [Setup](https://code.claude.com/docs/en/setup.md): Alpine requires bash.

## Smoke

```sh
MSB_HOME=/absolute/short/msb-home \
  bun spike/m6/claude-code-smoke.ts /absolute/path/to/msb \
  /absolute/path/to/.local/claude-code/2.1.330/linux-arm64-musl/claude
```

The smoke uses the product path: `MicrosandboxRuntime` with a credential
provider and a bound `providers` entry, and `TrustedHost.runPlanner` and
`runWorker`
with the `src/claude-code.ts` adapter. Its fixtures are:

- **API stand-in.** A loopback HTTPS server with a disposable CA stands in
  for the Anthropic API, as `host.microsandbox.internal`. It is reached
  through `claudeCodeProvider(..., fixture)`, using the backend's upstream
  CA option and a custom intercept port.
- **Key.** The trusted host holds a synthetic `sk-ant-synthetic-…` key.

The Planner and Worker inputs also include planted `.claude/settings.json`
and `.claude/settings.local.json`. They contain a hook that appends to
`hello.txt`, an `env` block that redirects the API to an unapproved port,
and an `apiKeyHelper`.

The variables `M6_PLANT`, `M6_ONLY_PLANNER` and `M6_TIMEOUT` exist only for
diagnosis. They weaken or skip assertions, so a run that sets them is not
evidence.

On 2026-11-22 it passed in about 23 seconds:

- **Planners.** Two Planner VMs ran in parallel. Each returned the CLI's
  JSON result, and `parseClaudeCodeResult` read `FIXTURE-PLAN-OK`.
- **Worker.** The stand-in drove `Read` and then `Edit`. The edited
  `hello.txt` was collected as `Good day from Claude Code.`
- **Requests.** All six Messages requests were streamed and carried the
  substituted key in `x-api-key`. None had an `Authorization` header.
- **Planted settings.** None took effect: the edited file had no appended
  text, and no request went to the redirected URL.
- **Probe VM.** After a CLI run, the placeholder was present and the full
  key was found nowhere in the guest. An unapproved port was blocked.
- **Host.** The key appeared in no captured output and in no file under the
  run directory or `MSB_HOME`.
- **Audit.** Each role VM recorded the `provider.egress` grant as requested,
  allowed and finished `ok`.

## Operator credential variable

The smoke also runs a Worker in `operator-credential` mode. By default it
substitutes `ANTHROPIC_AUTH_TOKEN` into `authorization`, without `--bare`,
using a separate runtime bound to that provider entry.
`M6_OPERATOR_VARIABLE` selects another variable without changing any
assertion. Its inputs include the planted settings and a planted `CLAUDE.md`.

On 2026-11-22 the run passed:

- **Requests.** Every Messages request was streamed and carried `Bearer`
  with the synthetic credential. None had an `x-api-key` header.
- **Tools.** The offered tools were exactly the pinned Read, Glob, Grep,
  Edit and Write, plus the CLI's internal `DeferredToolPlaceholder`.
- **Planted content.** The planted text never appeared in a request, and
  the edit was not tampered with.
- **Audit.** The `provider.egress` grant was recorded and closed `ok`.

A separate offline experiment ran the non-bare CLI against a plain HTTP
stand-in, with planted hooks, `env`, `CLAUDE.md`, a skill, an agent and
`.mcp.json` in the working directory:

- **Isolation flags.** With `--setting-sources '' --strict-mcp-config
--disable-slash-commands`, none of the planted files took effect or
  appeared in the request. This held whether the working directory was the
  repository or a separate directory with the repository passed through
  `--add-dir`.
- **Without `--tools`.** The CLI offered `Workflow`, `ScheduleWakeup`,
  `ToolSearch`, `ListAgents` and `ReportFindings`.
- **With a denylist instead.** Denying those tools exposed further deferred
  tools: `CronCreate`, `EnterWorktree` and `TaskStop`. Only `--tools` pins
  the set.

## Failures found on the way

- **Tool limit.** The adapter limit of four tools rejected the CLI plus
  four packages. It is now eight.
- **Write tool not offered in bare mode.** With `--bare`, CLI 2.1.330
  offers the model only `Read` and `Edit`, so a `Write` call failed with
  "No such tool available". Planner and Reviewer now remove `Edit` and
  `Write`, so they see only `Read`.
- **Planted `env` applied under `--bare`.** A planted project
  `settings.json` `env` block redirected `ANTHROPIC_BASE_URL` even with
  `--bare`. Every role then timed out at the network policy. Adding
  `--setting-sources ''` fixed it.
- **Search hits from the probe itself.** The first exposure probe matched
  its own command line. It now joins the search string inside the shell and
  writes it to a file outside the searched paths.
- **Network problem that was not one.** A blocking `spawnSync` in an early
  experiment froze the in-process mock server, which looked like a network
  failure.

## Open questions

- **Gate B with a real key.** The real `api.anthropic.com` path needs a
  separately authorized run with a real API key.
- **Remaining bypass tests.** Direct IP, IPv6, LAN, metadata and redirect
  bypass tests are still missing.
- **Request scope.** Method, path and request-count limits on the
  substituted credential need an upstream feature or a host-side proxy.
- **CPU and memory limits.** These are not yet passed to the backend.
- **Integration with reviewed integration and the Coordinator.** Claude Code
  roles are not yet wired into `ReviewedIntegration` or the Coordinator
  runner. The adapter's Worker command already fits the existing collect
  protocol.
