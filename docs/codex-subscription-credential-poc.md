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
smoke passed. [The credential smoke](../spike/m1/credential-smoke.ts) used
official Linux arm64 Codex, a fresh synthetic host-only token, and a
loopback TLS origin with a scoped fixture CA. The real CLI completed an
HTTP/SSE turn. The approved HTTPS server observed the exact substituted
Bearer header. The guest CLI received the placeholder. The test observed no
synthetic token in captured CLI output. A second live loopback listener
received the host control request and no guest request. These observations
cover the tested routes and output surfaces.

```sh
bun spike/m1/credential-smoke.ts /absolute/path/to/codex /absolute/path/to/msb
```

Use the same short dedicated `MSB_HOME`, cached arm64 image and
SHA-verified Codex binary used by the [M1 smoke tests](milestones.md).
The fixture also needs local OpenSSL to create its disposable CA. It uses
the documented Secrets path with automatic WebSocket transport disabled
for the fixture provider. HTTPS and the completed SSE turn were observed.
WebSocket frames, latency between SSE events, and refresh are unverified.

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

### Operator-only subscription run

1. Run the [authorization launcher](../spike/m1/subscription-authorize.ts)
   from the host terminal. Use the short `MSB_HOME`, cached image, pinned
   Microsandbox and SHA-verified Linux Codex binary from the synthetic checks.

   ```sh
   MSB_HOME=/absolute/short/msb-home \
     bun spike/m1/subscription-authorize.ts --authorize-and-run \
     /absolute/path/to/msb /absolute/path/to/codex
   ```

2. Open the displayed URL in a browser on the host. Choose an eligible
   ChatGPT account and workspace, then approve plan usage for Agent Bootstrap.
   The launcher uses the documented [Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
   and verifies the app-specific grant. It pipes the access token to the
   smoke runner on the host and requests revocation of the refresh token
   when the run ends. It stores the app registration and a hash of the
   validated subject in `.local/siwc-smoke/`. A normal Codex CLI login
   provides a separate session.

3. Record the outcome and confirm application attribution under Settings →
   Usage in the selected ChatGPT account. Under App limits, open Manage
   limits for the app and look for current-period usage alongside the
   configured limit. See the official
   [usage documentation](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).
   The harness reports turn completion or a
   fixed failure stage, with a fixed Codex error category and HTTP status
   where available. It checks documented token claims as a
   preflight; authorization is established by the provisioned session and
   checked by OpenAI. If revocation cannot be confirmed, the terminal
   directs the operator to disconnect Agent Bootstrap in ChatGPT settings.

If the operator already has an authorized Agent Bootstrap grant, a trusted
host credential command can pipe its access token straight to the runner.
The credential provider owns refresh and session cleanup for that route.

```sh
read_agent_bootstrap_access_token |
  bun spike/m1/subscription-smoke.ts --live /absolute/path/to/msb /absolute/path/to/codex
```

The harness scopes outbound TLS to `api.openai.com:443` and uses gateway DNS.
It requests a single, read-only, ephemeral thread with environment access
disabled. The network allowlist scopes the destination. Method, path, and
request-count enforcement are outside that network rule. Real deployment
will need a decision on redirect and response handling and an audit path
for provider requests. The manual smoke cannot establish these properties.

**Gate B is deferred.** The denial check covers one loopback port and two
address forms. Broader DNS, IPv6, LAN and metadata checks, redirects and
reachable alternative origins, all credential surfaces, and refresh races
remain unverified. The offline runtime's concurrent workspace separation and
isolated synthetic guest-local authentication state also passed with two
live VMs. That run had no credential projection.

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
uses the issued client ID and serializes rotation. A future host provider
would refresh once per registered session, atomically persist the
replacement and give subsequent worker requests the new generation. A
future delegated resolver must be callable only from the trusted proxy,
and must avoid replay of an admitted or partially streamed inference
request. The operator launcher exchanges an authorization code for a single
run. Live renewal remains unimplemented.
