# Sandbox profiles

Status: in progress on `feat/sandbox-profiles` (design from 2026-11-22).

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
plus `--memory <n>M` and `--cpus <n>` when they are set.

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
  without these fields still append to old databases.
- Reads return `profile` and `image` when they are present.

### Reviewed integration

- `Plan.verification` becomes
  `{ command: SandboxCommand; profile?: ProfileName; suite?: readonly SandboxFile[] }`.
  - The suite holds host-pinned test files (bounded by the adapter's file
    limits).
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

  Any other shape is a concern. The journal's `verification.finished` event
  records the counts when they are present.

### Claude Code Worker shell

`claudeCodeCommand` takes an optional `shell: true`, allowed only for the
Worker role. With it, the pinned tool set adds `Bash`. Without it, the tool
set is unchanged. Consequence: a shell in the VM can make arbitrary requests
to the bound provider host with the substituted credential. The Codex Worker
has the same property today. The value itself never enters the guest. This
needs a security review.

## Not in this step

- The `db` and `browser` image builds, the PostgreSQL start script, and glibc
  builds of the CLIs. They need network approval.
- Multi-file candidates. The integration flow still collects one file.
