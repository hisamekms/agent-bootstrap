# Sandbox profiles

Status: the mechanism is implemented with only `base` configured
(2026-11-22). The `db` and `browser` images are not built yet.

Some tasks need a database or a browser in the VM, and most do not. A
**sandbox profile** names one VM environment: a digest-pinned image plus
resource limits. Profiles change what is inside a VM. They do not change the
runtime adapter, which still creates every VM, or the credential binding,
which stays per adapter. Each VM still lives for one invocation.

## Profiles

| Profile   | Image contents                             | Intended use                  |
| --------- | ------------------------------------------ | ----------------------------- |
| `base`    | The current minimal Alpine image           | Default for every role        |
| `db`      | `base` plus SQLite and PostgreSQL          | Database tests and migrations |
| `browser` | `db` plus headless Chromium and Playwright | End-to-end tests              |

Images are built ahead of time and pinned by digest, because a VM has no
package network. The `db` and `browser` images are a later step: fetching
their packages needs operator approval. The mechanism below ships first, with
only `base` configured.

## Contracts

### `src/sandbox-profiles.ts` (new)

```ts
export const PROFILE_NAMES = ["base", "db", "browser"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
export interface SandboxProfile {
  readonly image: string; // name@sha256:<64 hex>
  readonly memoryMiB?: number; // integer 256..8192; default: backend default
  readonly cpus?: number; // integer 1..8; default: backend default
}
export type ProfileRole =
  "Coordinator" | "Planner" | "Worker" | "Reviewer" | "Verification";
/** Which profiles each role may request. */
export const ROLE_PROFILES: Readonly<
  Record<ProfileRole, readonly ProfileName[]>
>;
//   Coordinator, Planner, Reviewer: ["base"]
//   Worker, Verification: ["base", "db", "browser"]
export class ProfileCatalog {
  constructor(profiles: Partial<Record<ProfileName, SandboxProfile>>); // must include base; validates; deep-copies and freezes
  has(name: string): name is ProfileName;
  get(name: ProfileName): SandboxProfile; // throws if unconfigured
  /** The 64-hex image digest of a configured profile, for audit. */
  imageDigest(name: ProfileName): string;
}
```

Invalid input throws `SandboxRuntimeError("invalid-input")`.

### `SandboxSpec.profile`

`SandboxSpec` gains `readonly profile?: ProfileName`. When it is absent, the
profile is `base`. It is not part of the provider binding, so routing is
unchanged.

### Microsandbox adapter

`MicrosandboxConfig` replaces `image` with `profiles: ProfileCatalog`.
`create` resolves `spec.profile ?? "base"`, refuses an unconfigured profile
with `invalid-input` before any backend call, and passes the profile's image,
plus `--memory <n>M` and `--cpus <n>` when they are set. The host passes
the image digest it recorded in the audit as `SandboxSpec.imageDigest`. The
adapter refuses the spec if its own catalog resolves a different image, so
the audit cannot name one image while another boots.

### Trusted host

- `TrustedHost` takes the `ProfileCatalog` as a third constructor argument.
- It checks `ROLE_PROFILES[role]` and that the catalog has the profile
  _before_ `invocation.started`. A refused profile throws and writes nothing
  privileged, the same as other invalid plans.
- New entry point `runVerification(plan: ReviewerPlan & { sandbox: { profile? } }, id?)`.
  It runs read-only, as the Reviewer does today, under the new audit role
  `Verification`, and accepts no `provider`, `tools` or `hostTcpPort`.
  Verification never gets credentialed egress.
- On every `sandbox.create`, the `operation.requested` event records
  `profile` and `image` (the 64-hex digest).

### Audit schema v4

- Role CHECK adds `'Verification'`.
- New nullable columns:
  - `profile TEXT CHECK (profile IS NULL OR profile IN ('base','db','browser'))`
  - `image TEXT CHECK (image IS NULL OR (length(image) = 64 AND image NOT GLOB '*[^0-9a-f]*'))`
- `AuditInput` gains optional `profile` and `image`. Both are allowed only on
  an `operation.requested` event for `sandbox.create`, and only together.
- A new database is created at v4.
- Versions 1–3 still open and read, but writing `profile`, `image` or role
  `Verification` to them fails closed with `invalid-event` or
  `append-failed`. This is the same pattern v3 used for `provider.egress`.
  An old trace therefore never silently loses profile evidence. Events
  without these fields still append to old databases. But the trusted host
  records `profile` and `image` on every `sandbox.create`, so a v1–v3
  database can no longer run any invocation: it stops before a VM is created.
  Use a new audit database for new runs. Old ones remain readable.
- Reads return `profile` and `image` when they are present.

### Reviewed integration

- `Plan.verification` becomes
  `{ command: SandboxCommand; profile?: ProfileName; suite?: readonly SandboxFile[] }`.
  - The suite holds host-pinned test files: at most 32 files, 256 KiB each and
    512 KiB in total. These limits are checked when the integration flow is
    built.
  - Verification runs through `host.runVerification` with
    `readOnlyFiles` = `candidate.diff`, `candidate.source` and the suite under
    `suite/<path>`.
  - The Worker also receives the same suite read-only under
    `/review/suite/`, so it can run the tests while it develops.
  - The Worker is given the verification profile unless
    `workerSandbox.profile` says otherwise.
- The candidate is a single host-collected file and the suite is host-owned,
  so the Worker cannot weaken the tests that verification runs.
- The integration target digest also covers the profile name and the SHA-256
  of each suite file (path and bytes). Changing the verifier invalidates
  earlier approvals.
- Verification output may be exactly `{"review":"pass"|"revise"}`, or that
  object plus a `tests` summary
  `{"passed": int, "failed": int, "failures": string[]}`, in at most 4096
  bytes:
  - the counts are integers from 0 to 100000;
  - there are at most 20 failures;
  - each failure is at most 200 bytes, printable ASCII only.

  Any other shape is a concern, as is `pass` with failing tests. The
  journal's `verification.finished` event records the counts when they are
  present.

- **The verdict is self-reported.** The verification VM also runs the
  candidate code, as the same user, so a hostile candidate can print a forged
  `pass` and invented counts. Verification catches honest failures. Reviewer
  and human approval remain the integration gate, and the counts are evidence
  of what the VM reported, not proof. A Worker with the opt-in shell can
  rehearse against the same suite, which makes a forged pass easier to
  build. The adapter also still accepts a spec without `imageDigest`; the
  trusted host always sets it. Planned hardening: run the candidate as
  a separate unprivileged user, and have a host-pinned runner report through
  a channel the candidate cannot write.

### Claude Code Worker shell

`claudeCodeCommand` takes an optional `shell: true`, allowed only for the
Worker role. With it, the pinned tool set adds `Bash`. Without it, the tool
set is unchanged. Consequence: a shell in the VM can make arbitrary requests
to the bound provider host with the substituted credential. The Codex Worker
has the same property today. The value itself never enters the guest. This
needs a security review.

## Building profile images

Each profile is a set of **features**, and composition happens when the image
is built. A request still names one profile.

| Profile   | Base           | Features                         |
| --------- | -------------- | -------------------------------- |
| `db`      | Alpine 3.23    | `sqlite`, `postgres`             |
| `browser` | Debian (later) | `sqlite`, `postgres`, `chromium` |

A feature recipe lists pinned packages (file name and SHA-256) and an
optional setup script. The `browser` profile will need Debian variants of
the `sqlite` and `postgres` recipes, because Playwright does not support
Alpine.

### Build steps (Alpine)

1. **Check the packages.** The host verifies each package file against its
   pinned SHA-256. Packages are fetched once from `dl-cdn.alpinelinux.org`
   into `.local/alpine/v3.23/main/aarch64/`. Fetching needs operator approval.
2. **Install in a build VM.** A build VM with no network starts from the
   pinned base image, with the package files copied in. It runs
   `apk add --no-network` without `--allow-untrusted`, so apk checks each
   package signature against the Alpine keys in the base image. Then it runs
   each feature's setup script.
3. **Export the root filesystem.** The build VM writes the root filesystem as
   a tar, excluding `/proc`, `/sys`, `/dev` and `/tmp` contents, and the host
   copies it out with `msb copy`.
4. **Normalize the layer.** The host rewrites the tar deterministically:
   entries sorted by path, mtime 0, and ownership and mode kept. Builds of the
   same inputs then tend to give the same digest. This is best effort: file
   contents such as account dates may differ.
5. **Assemble the image.** The host builds an OCI image layout:
   - one squashed layer;
   - a config derived from the base config (env, cmd and working directory),
     with `created` fixed at the epoch;
   - the manifest.

   The image digest is the manifest digest.

6. **Load the image.** `msb load -t localhost/agent-bootstrap/<profile>@sha256:<digest>`,
   then `msb image inspect` must report that digest.
7. **Record the result.** `images/profiles.lock.json` records the reference,
   the memory and CPU limits, and the inputs (base reference, package
   digests, recipe digest). The lock file is what a `ProfileCatalog` is built
   from. Rebuilding is a deliberate lock update.

### Image digest check at run time

Microsandbox does not verify a digest-form local tag. Loading an image with
`-t name@sha256:<anything>` succeeds, and that reference then boots it
(observed with 0.7.16 on 2026-11-22). So before every `msb create` the adapter
runs `msb image inspect --format json <reference>`, and refuses with
`invalid-input` unless the reported `digest` equals the digest in the
reference. This also covers registry images, where the reported digest is the
reference digest.

### PostgreSQL in the `db` image

The `postgres` setup installs `/usr/local/bin/agent-bootstrap-postgres`. It
does the following:

- creates a fresh data directory with `initdb` (trust authentication, local
  only);
- starts the server on `127.0.0.1:5432` and the socket in `/run/postgresql`;
- waits until the server accepts connections;
- prints `postgresql://postgres@127.0.0.1:5432/postgres`.

Verification and Worker commands call it when they need a database. The data
is discarded with the VM.

## Evidence

On 2026-11-22, `bun verify` passed 114 tests. Two M5 fixture runs in real
VMs completed with outcome `done`: `all=codex` and
`Coordinator=claude,Worker=claude,Reviewer=codex`. The audit database was
v4, and every `sandbox.create` request recorded profile `base` with the
pinned Alpine image digest. Verification was recorded under its own role,
`Verification`, with no `provider.egress` grant.

## Not in this step

- The `db` and `browser` image builds, the PostgreSQL start script, and glibc
  builds of the CLIs. They need network approval.
- Multi-file candidates. The integration flow still collects one file.
