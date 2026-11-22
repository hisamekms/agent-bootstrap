# Claude Code authentication

Agent Bootstrap can run the official, unmodified `claude` CLI as a role in a
Microsandbox VM. This page explains how that CLI is authenticated, what each
mode exposes, and which modes are deliberately left out.

## Modes

| Mode                            | Status                                                                                                                        | What the guest sees                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `api-key` with `host-secret`    | Implemented. Verified offline against a loopback stand-in for the API; see [the PoC record](claude-code-microsandbox-poc.md). | A placeholder in `ANTHROPIC_API_KEY`. The real key never enters the guest. |
| `api-key` with direct injection | Not implemented.                                                                                                              | —                                                                          |
| `native-cli`                    | Refused (`ClaudeCodeUnsupportedError`).                                                                                       | —                                                                          |
| Claude subscription tokens      | Not supported, and not planned.                                                                                               | —                                                                          |

Choose `api-key` with `host-secret`. It is the only mode the public package
implements.

### Host-held API key

The trusted host owns an Anthropic API key (Claude Console billing) and
provides it through the adapter's `CredentialProvider`. When it creates the
sandbox, Microsandbox gets the following:

- `--secret ANTHROPIC_API_KEY:headers=x-api-key@api.anthropic.com`;
- `--tls-intercept`;
- `--secret-violation-action block`;
- network rules that allow only DNS and `api.anthropic.com:443`.

The flow is:

1. The key is placed only in the environment of the `msb create` process. It
   is never in argv, in other backend commands, in the repository, the
   audit, the journals or any report.
2. Inside the guest, `ANTHROPIC_API_KEY` holds Microsandbox's placeholder.
   The guest script checks this before starting the CLI.
3. The CLI sends the placeholder in `x-api-key`. The backend's TLS proxy
   substitutes the real value only on requests to the allowed host.
4. Before the VM exists, the trusted host records the grant as
   `provider.egress` in the audit, and it closes the grant after teardown.

Without the backend, the guest has no way to recover the key. A guest
process can still use the key while the VM lives, by sending the
placeholder to `api.anthropic.com`. See the risks below.

The CLI always runs with `--bare --strict-mcp-config --setting-sources ''`.
According to the Claude Code documentation, bare mode never reads OAuth
credentials or the system keychain. Together with a clean environment
(`env -i`) and a fresh `CLAUDE_CONFIG_DIR`, this keeps API-key mode from
picking up a pre-existing subscription session or host profile. No host
home, `~/.claude`, SSH agent, Docker socket or cloud credential directory is
mounted.

`--setting-sources ''` matters because the CLI runs inside untrusted
repository content. A test on 2026-11-22 with CLI 2.1.330 planted
`.claude/settings.json` and `.claude/settings.local.json` in the working
directory:

- **With `--bare` alone,** the CLI ignored the planted hooks but still
  applied the planted `env` block. That block redirected
  `ANTHROPIC_BASE_URL`, and the requests stalled at the network policy.
- **With `--setting-sources ''`,** the planted hooks, `env` and
  `apiKeyHelper` were all ignored.

Managed settings and `--settings` still apply under bare mode. The adapter
passes neither.

### Direct injection

A mode that places the raw key in the guest environment is not
implemented. If one is added later, it must be opt-in, named so it is not
mistaken for the host-held mode (for example `direct-env`), and documented
as readable by any process in the guest. It must also have a test proving
the guest can read the test secret.

### Native CLI login

CLI-managed login needs a session inside the guest. A disposable VM has
none, and the bootstrap never copies host profiles into sandboxes, so this
mode is refused rather than enabled through a silent mount.

### Subscription tokens

Agent Bootstrap has no code path for `claude setup-token`,
`CLAUDE_CODE_OAUTH_TOKEN`, OAuth refresh, or a subscription proxy. Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance.md#authentication-and-credential-use)
says that third-party developers may not offer Claude.ai login, route
requests through Free, Pro, Max or Ultra plan credentials on behalf of their
users, or collect, store or intermediate Claude.ai credentials or session
tokens. The provider-egress mechanism is generic, but this page does not
describe it as a way to use subscription credentials, and doing so would not
make such use acceptable.

## Billing

API-key mode is billed to the key's Claude Console organization at API
rates. The CLI's JSON result includes `total_cost_usd` and token usage;
`parseClaudeCodeResult` returns those fields. Pro or Max plans do not cover
this traffic.

## Setup

1. Obtain the pinned CLI build, `CLAUDE_CODE` in `src/claude-code.ts`:
   - Download `linux-arm64-musl/claude` for version 2.1.330 from
     `https://downloads.claude.ai/claude-code-releases/`.
   - Check its SHA-256 against that release's `manifest.json`.
2. Obtain the four Alpine 3.23 packages listed in
   `CLAUDE_CODE_GUEST_PACKAGES` (bash and its dependencies) from the
   official Alpine mirror. The guest verifies their pinned digests, and
   `apk` checks their signatures with the image's keys.
3. Keep both under `.local/`, which Git ignores.
4. Configure `MicrosandboxRuntime` with:
   - `providers: [claudeCodeProvider({ mode: "api-key", credential: "host-secret" })]`.
     This binds the credential to that host, the `x-api-key` header, the
     `ANTHROPIC_API_KEY` variable, port 443 and no extra CA. A sandbox spec
     whose `provider` differs in any field is refused.
   - a `CredentialProvider` that returns the API key from the host's own
     secret store.

   Pass the following to the role's sandbox and command:
   - `claudeCodeProvider({ mode: "api-key", credential: "host-secret" })`;
   - `claudeCodeTools(...)`;
   - `claudeCodeCommand(...)`.

Do not put keys in repository files, CLI flags or shell history.

## Command contract

`claudeCodeCommand` builds the guest command from constants and validated
values only. The untrusted prompt is a single argv entry (`$1`), passed after
`--`. An agent's text cannot choose host commands or CLI flags.

| Item        | How it is set                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flags       | Always `-p --bare --strict-mcp-config --setting-sources '' --output-format json --max-turns N --model M --permission-mode ... --allowedTools ... --disallowedTools ...`.                                                                  |
| Environment | Only `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, the placeholder key, the backend CA path (`NODE_EXTRA_CA_CERTS`) and the variables that disable nonessential traffic, telemetry, error reporting and auto-update.                               |
| Tools       | Bash is removed for every role. Planner and Reviewer are allowed Read, Glob and Grep, with Edit and Write removed; in bare mode CLI 2.1.330 then offers only Read. Worker is also allowed Edit and Write; bare mode offers Read and Edit. |
| Output      | Worker prints only the bounded collect request, and the host collects the files. Planner and Reviewer print the CLI's JSON result, at most 64 KiB.                                                                                        |
| Limits      | The adapter bounds runtime, output size and turns. CPU and memory limits exist in Microsandbox (`--cpus`, `--memory`) but are not yet wired into the adapter.                                                                             |

## Trust boundaries and risks

- **The key can be used, not read.** Any process in the guest can send the
  placeholder to `api.anthropic.com` and have the real key substituted.
  That host receives arbitrary methods and paths, with no request cap, so a
  prompt-injected model can spend the key's budget or call other Console API
  endpoints while the VM is alive.
- **Exfiltration through DNS.** `allow@dns` lets the guest send data out
  through DNS queries.
- **Reflected headers.** The upstream could echo the substituted header back
  to the guest. Microsandbox does not redact responses.
- **Same-user host processes.** While a credentialed VM is alive, its `msb
machine` process holds the key in its environment. A process running as
  the same user can read it with `ps eww`.
- **Untested bypass routes.** Direct IP, IPv6, LAN, metadata and redirect
  bypass attempts are not yet covered by tests. Gate B in the Codex PoC
  tracks the same matrix.
- **Host-side variable name.** On the host, the key sits in the `msb
create` environment as `ANTHROPIC_API_KEY`, because Microsandbox uses the
  same name in the guest. It has not been verified that `msb` itself never
  interprets that variable.
- **Placeholder format.** The guest check expects the literal placeholder
  `$MSB_ANTHROPIC_API_KEY`. This fails closed, but depends on the
  Microsandbox version.
- **Reviewer verdicts can be steered.** The Reviewer reads untrusted
  candidate text, so prompt injection can influence its verdict. The human
  approval of the full diff remains the independent check.
