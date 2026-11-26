# Codex subscription credential PoC

## Phase 0 evidence and gate

The pinned versions are [Microsandbox 0.7.16](https://github.com/superradcompany/microsandbox/releases/tag/v0.7.16)
and [Codex CLI 0.170.0](https://github.com/openai/codex/releases/tag/rust-v0.170.0).
The Microsandbox release commit is `0fefb8f2fed3da964819afd222227dc1c5b0e78f`.
Local CLI help confirms the Microsandbox `--secret ENV:headers=authorization@HOST`
option takes a host environment reference, and `--pull never` and `--no-net`
are available. The [tagged Secrets guide](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/secrets.mdx)
describes a guest placeholder and host-side TLS substitution with a scoped
destination. The [tagged TLS guide](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/networking/tls.mdx)
describes independent upstream certificate validation and the guest trust
store.

Codex supports headless device authentication and file-backed credentials.
The [authentication guide](https://learn.chatgpt.com/docs/auth) treats the
local `auth.json` as credential material. The
[Codex v0.170.0 auth manager](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/auth/manager.rs)
implements managed OAuth reload/refresh after authorization failures.
Guest-managed login and copying the host auth cache both put credentials in
the guest and fall outside this PoC.

OpenAI's [ChatGPT plan usage documentation](https://developers.openai.com/siwc/token-sharing-open-source)
describes an authorized OAuth flow for eligible open-source or local apps.
The [app-server guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
uses a supported provider at `https://api.openai.com/v1` over HTTP/SSE.
The [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
include eligibility and request-shape constraints. This is the documented
route to evaluate for subscription use. The applicable
[OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) and account
permissions apply. The PoC does not depend on private ChatGPT endpoints.

Already observed locally: networking denied the measured loopback target
without an allow rule, and guest Codex completed a simulated HTTP/SSE turn
through an explicitly scoped loopback rule. Dynamic tool outcomes,
interruption and same-process continuation were observed. Neither test
used a real subscription credential or proved TLS substitution.

## Comparison with OpenSandbox

OpenSandbox is a reference. The stable [1.2.1 release](https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.2.1)
(commit `db708c2`) ships the OSEP-0025 exchange implementation even though the
[tagged proposal](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/oseps/0025-credential-vault-provider-spi.md)
still has status `implementing`. The comparison uses release code and
does not introduce an OpenSandbox dependency.

| Capability                         | Microsandbox 0.7.16                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | OpenSandbox 1.2.1 reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination and request match      | Secret matches the exact allowlisted host and selected request header. DNS, TLS/SNI and HTTP authority participate. The egress allowlist can additionally scope TCP port. A method/path binding would need a separate trusted enforcement layer or an upstream extension. [Secrets implementation flags](https://github.com/superradcompany/microsandbox/blob/v0.7.16/crates/cli/lib/commands/common.rs#L2443), [security boundary](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/secrets.mdx#security-boundary) | OSEP-0012 matches scheme, canonical port, host, HTTP method and path. Exact host matches take precedence. Ambiguous matches at the selected precedence are rejected. [Matching and rejection](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/mitmscripts/system.py#L1332-L1426)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Redirects and response handling    | Each destination is checked. Redirects to the same allowed host remain eligible for substitution. An allowed upstream receives the real value and could reflect it. No general response redaction is established. [Secrets security limits](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/secrets.mdx#security-boundary)                                                                                                                                                                                         | The proxy matches each request. The exchange resolver HTTP client separately declines redirects. The proxy suppresses or redacts response headers and streams SSE; it leaves response bodies intact. [Resolver HTTP client](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/pkg/credentialvault/resolver_client.go#L167-L202), [response hooks](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/mitmscripts/system.py#L2367-L2433)                                                                                                                                                                                                                                                                                                            |
| Egress and failure                 | Explicit deny by default and narrow allow rules compose with Secrets; unsupported or bypassed TLS gives no substitution. HTTP/3 is outside TLS inspection. [Network defenses](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/security/network.mdx), [TLS limits](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/networking/tls.mdx#limits)                                                                                                                                                               | The egress runtime and addon enforce request policy. The exchange handler applies bounded resolution, validates the decision and rechecks the binding after resolution. Rejected or timed-out resolution yields a failure without a usable exchange credential. [Egress assembly](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/fastsandbox_mitm.go), [resolve handler](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/pkg/credentialvault/resolve_handler.go#L124-L245)                                                                                                                                                                                                                                                                   |
| Delegated resolution and isolation | The CLI can resolve a host environment source at startup. A supported per-request resolver API was not found in this release. A future resolver would need a verified host-only boundary and an integration point. [Secret sources and changes](https://github.com/superradcompany/microsandbox/blob/v0.7.16/docs/sandboxes/secrets.mdx)                                                                                                                                                                                                       | The exchange source stores an endpoint and resolves headers per request. The release has a Unix-socket transport and a privileged local resolver path. HTTPS is supported as a transport, but the proposal's resolver caller authentication is deferred. HTTPS alone provides no egress-only caller boundary in the sidecar profile. [Exchange source](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/pkg/credentialvault/source_exchange.go), [socket permissions](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/egress/pkg/credentialvault/active_socket.go#L55-L104), [tagged resolver caveat](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/oseps/0025-credential-vault-provider-spi.md#resolver-caller-authentication) |

## Gate A and Gate B status

**Gate A synthetic checks passed on macOS arm64.** The runtime lifecycle
smoke passed. The historical credential smoke used
official Linux arm64 Codex, a fresh synthetic host-only token, and a
loopback TLS origin with a scoped fixture CA. The real CLI completed an
HTTP/SSE turn. The approved HTTPS server observed the exact substituted
Bearer header. The guest CLI received the placeholder. The test observed no
synthetic token in captured CLI output. A second live loopback listener
received the host control request and no guest request. These observations
cover the tested routes and output surfaces.

The direct-network fixture is preserved in Git at `de26b1409fe8`.
HTTPS and the completed SSE turn were observed. WebSocket frames, latency
between SSE events, and refresh are unverified.

**Gate A manual subscription turn passed on 2026-11-22.** Following
browser consent, the operator reported the smoke runner's success line:

```text
Guest Codex reported a completed turn using the supplied OAuth access token.
```

The success line requires the guest placeholder and binary checks, a
read-only ephemeral thread with an empty environments list, a completed
turn, and sandbox cleanup. This establishes compatibility for one
operator-authorized turn with pinned Codex 0.170.0 and Microsandbox
0.7.16. The launcher requests refresh token revocation separately after
the runner exits. The operator saw `agent-bootstrap` under ChatGPT
Settings → Usage → App limits, with no usage value visible. This confirms
the app listing. Usage attribution for the turn and confirmation of
refresh-token revocation remain unverified.

The first operator run stopped before completing a guest turn. An offline
reproduction showed that `thread/start` rejects `environments: []` unless
`initialize` advertises `experimentalApi`. The corrected configuration
passed the network-disabled IPC test and the operator's live retry.

The historical direct-network runner is preserved in Git at `de26b1409fe8`.
It scoped outbound TLS to `api.openai.com:443` and requested a single,
read-only, ephemeral thread with environment access disabled. The network
rule scoped the destination. Method, path, request count, redirect handling,
response handling, and provider request auditing were outside the scope of
that evidence.

### Operator-only subscription run

1. Follow the [live M5 operator checklist](observability/dogfooding.md#live-m5-operator-checklist)
   and run the [authorization launcher](../spike/m1/subscription-authorize.ts)
   from the host terminal. Use a short `MSB_HOME`, the cached digest-pinned
   images, pinned Microsandbox and a SHA-verified Linux Codex binary.
   The M5 runner sends sandbox traffic through the audited egress gateway.

   ```sh
   M5_ACTORS=all=codex MSB_HOME=/absolute/short/msb-home \
     bun spike/m1/subscription-authorize.ts --authorize-and-run-m5 \
     /absolute/path/to/msb /absolute/path/to/codex
   ```

2. In the browser opened on the host, choose an eligible
   ChatGPT account and workspace, then approve plan usage for Agent Bootstrap.
   The launcher uses the documented [Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
   and verifies the app-specific grant. It pipes the access token to the
   M5 runner on the host and requests revocation of the refresh token
   when the run ends unless Keychain storage is enabled. The current
   launcher shares the host SIWC provider and its private user state.
   A normal Codex CLI login provides a separate session.

3. Record the outcome and confirm application attribution under Settings →
   Usage in the selected ChatGPT account. Under App limits, open Manage
   limits for the app and look for current-period usage alongside the
   configured limit. See the official
   [usage documentation](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).
   Review the M5 run report and audit export using the live checklist.
   The launcher checks documented token claims during preflight. OpenAI
   checks authorization using the provisioned session. If revocation cannot
   be confirmed, the terminal
   directs the operator to disconnect Agent Bootstrap in ChatGPT settings.

**Gate B is deferred.** The denial check covers one loopback port and two
address forms. Broader DNS, IPv6, LAN and metadata checks, redirects and
reachable alternative origins, all credential surfaces, and refresh races
remain unverified. The offline runtime's concurrent workspace separation and
isolated synthetic guest-local authentication state also passed with two
live VMs. That run had no credential projection.

### Keeping the refresh token

On macOS, run `agent-bootstrap codex authorize` from a terminal to save
the grant without starting the runner. If the browser cannot be opened,
open the consent URL printed in the terminal while the command waits.
The M5 launcher accepts `--keychain` immediately after
`--authorize-and-run-m5` for grants whose legacy launcher is still active.
The registration lives at
`${XDG_STATE_HOME:-~/.local/state}/agent-bootstrap/siwc/registration.json`.
The state directories use mode 0700 and the registration uses mode 0600.
The Keychain account is the macOS login user from `userInfo().username`.
On the first Keychain operation after import, if that account has no item
and the old launcher's `$USER`
names a different account with an item, the provider copies the token to
the login account, verifies read-back, and deletes the old item. An
interrupted move resumes before the next Keychain operation. Later
operations use the login account. If both accounts already have items
when migration starts, the provider records the legacy account and prints a
`security delete-generic-password` command for manual removal. It leaves both
items in place. The service name remains
`agent-bootstrap.siwc.refresh.<hex>`, where `<hex>` is the first 16 hex
characters of the registration host ID's SHA-256 hash.

On first use, an existing user registration takes precedence. Otherwise the
provider looks for `.local/siwc-smoke/registration.json` in the primary
checkout first, then in the linked worktree. It copies
and verifies the private registration, records the source directory in
`migratedFrom`, and preserves the host ID used by the Keychain item.
The provider takes the source checkout's run lock during migration and
while using the copied registration, as long as that directory exists.
On fresh consent it retires the source registration so an old launcher
at that path stops before reaching Keychain with a stale client ID. If
the recorded directory is missing, the provider records it as retired
and continues. `agent-bootstrap codex forget` retires a source registration
with the same host ID and clears the migration link. The compatibility
launcher stays retired.
Keep one user state location across checkouts. A moved or copied legacy
checkout can still have a launcher with the same host ID and Keychain item
and its own run lock. Using it can race with the user-state provider and
invalidate the grant. Do not run any moved or copied legacy launcher.

The user-state run lock serializes grant operations across processes.
A refresh saves the replacement in Keychain and verifies read-back as soon
as it parses the token, before fetching JWKS or validating the response.
If fetching the signing keys fails, including an HTTP 5xx response, the
provider reports `siwc-unavailable` and keeps the saved replacement for the
next refresh. Access remains blocked until the provider verifies a later
ID token or the operator forgets the grant and authorizes again. Before
saving a refresh that needs this check, the provider retires any matching
source registration because the old launcher cannot enforce the check.
If identity validation or persistence fails and the provider clears the
item after attempting revocation, it reports `siwc-rejected` and directs
the operator to authorize again. Missing grants report `siwc-missing`.
HTTP 400 or 401 from the refresh exchange triggers a revocation attempt,
item deletion and `siwc-rejected`. HTTP 5xx or a transport failure at the
refresh exchange reports `siwc-unavailable` and leaves the item in place.
These access paths run without opening a browser.

The refresh token has a rolling 30-day lifetime. Any same-user process able
to run `security` can read the item without a prompt. The provider omits a
`-T` restriction to avoid a prompt on every run. If the process crashes
after refresh and before saving the replacement, disconnect Agent Bootstrap
in ChatGPT settings and authorize again. A `run.lock` in either the user
state or the migration source records its owner's PID and process start
identity. The provider reclaims it when that owner is gone, including
when the PID has been reused. Permission errors checking the owner cause
the provider to wait. The provider can reclaim an empty lock from an older
launcher after five minutes, once it confirms no other descriptor is open.
An old launcher can still unlink the path if it was paused between closing
its descriptor and removing the file. Stop old launchers before migration
to avoid that race.
For an unreadable lock or a failed open-file check, use the path in the
error. Remove the lock only after confirming that every command and legacy
launcher using it has stopped.

Run `agent-bootstrap codex forget` to revoke the grant and delete the item.
The M5 launcher's `--forget` is available before the legacy registration
is retired. Keep the user registration while the Keychain
item exists. If the provider cannot confirm revocation it still deletes
the item and directs the operator to disconnect Agent Bootstrap in ChatGPT
settings. If the registration is lost or unreadable, disconnect Agent
Bootstrap and use Keychain Access to remove the leftover
`agent-bootstrap.siwc.refresh.<hex>` item.

## Host credential lifecycle

[`CredentialProvider`](../src/credentials.ts) exposes an access credential
to a trusted host callback. The credential resolver and injection are
separate responsibilities. This fixture supplies only the synthetic
credential to Microsandbox's host environment source at VM creation.
The production offline runtime has no credential inputs.

The short-lived PoC would provision one valid access token for a single
bounded run. At expiry or terminal rejection, stop the invocation and
provision a fresh host session before starting another run. The official
[Codex auth implementation](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/auth/manager.rs#L2039-L2050)
describes managed unauthorized recovery. The separately documented
[ChatGPT plan OAuth refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens)
uses the issued client ID and serializes rotation. The host SIWC provider
now persists the replacement before making the access token available and
reports value-free refresh outcomes. The trusted Executor caller can record
the refresh attempt before exchange and the outcome before consuming access.
Local fixtures cover serialization
across processes. The local Executor integration and live Gate B checks
are pending. A delegated resolver must be callable only from the trusted
proxy and avoid replay of an admitted or partially streamed inference
request.
