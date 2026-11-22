# Repository environments

Status: planned, not implemented. These decisions were recorded on
2026-11-22, after the sandbox profile work (`docs/sandbox-profiles.md`).

Repositories need different toolchains (Bun, Node, Rust, Python) and
different language packages. Worker and verification VMs stay offline. The
host prepares everything they need before they run.

## Prerequisites

- **Multi-file candidates.** Integration still collects one file. Real
  repositories need the whole tree in the workspace and a bounded
  multi-file collection.
- **Large read-only trees.** The adapter's file limits (64 files, 1 MiB in
  total) cannot carry `node_modules` or package caches. They need a
  digest-pinned directory mounted read-only, for example a Microsandbox
  volume or a `--mount-dir` mount.

## Worker changes and git history

Decided on 2026-11-22.

- **Result path.** The host places the base tree in the workspace. After the
  Worker run, the host exports the workspace as a tar and reads it with the
  strict parser. It computes the changes against the base tree (changed,
  added and deleted files, and mode changes) and creates the candidate commit
  itself, with the host as author. The Worker may propose a bounded commit
  message, which is treated as untrusted text. `.git` is never collected.
  Path policy rejects changes outside the allowed paths and highlights
  protected paths on the approval screen.
- **Git in the VM.** The workspace includes a git repository for the
  Worker's own use, for example `git diff`, `git log`, `git blame` and
  `git stash`. The host never reads it.
- **Full history.** agent-bootstrap provides a full clone of the target
  branch, without other remotes, hooks or credentials. Shallow clones and
  answering requests for more history are left to dagq-lite.
- **Monorepo paths.** Restricting a Worker to some paths is for focus, not
  confidentiality. The workspace uses sparse checkout for those paths, and
  the history stays that of the whole repository. Collection still rejects
  changes outside the allowed paths.
- **Revisions.** A revision run starts from the previous candidate's tree.
  The VM repository has the base and the previous candidate as commits, so
  the Worker can see both what changed in this run and what changed overall.

### Implementation status

The result path and git in the VM are implemented. The pieces are
`prepareWorkspace`, `createCandidateTree` and the multi-file `diff` and
`advance` in `src/git-integration.ts`, the `repository` and `{ tree: true }`
collection in the adapter, `src/workspace-tree.ts`, and the `tree` plan in
`src/reviewed-integration.ts`. The Worker's proposed commit message is not
implemented yet; the host writes a fixed message.

On 2026-11-23, `spike/workspace/tree-smoke.ts` ran in real VMs with the
`browser` profile for Worker and verification:

- **Unscoped run.** The Worker saw the full history and a clean
  `git status`. Its four changes became a host-authored commit whose only
  parent is the old head, with the exact modes: a modified file, a deleted
  file, an added executable and an executable bit removed. Verification
  checked the candidate tree with 4 tests passing, and the commit was
  integrated.
- **Scope `app/`, a new file outside it.** No candidate was created.
- **Scope `app/`, an edit inside it.** Paths left out by sparse checkout were
  absent in the VM but were not treated as deletions. The candidate changed
  only `app/lib/util.sh`.
- **Audit.** The Worker and verification VMs used `browser` with the locked
  digest, and the Reviewer used `base`.

## Toolchains as features

- **Features.** A toolchain is a feature, such as `node22`, `bun1.3`,
  `rust1.9x` or `python3.13`. It is composed into a profile image at build
  time, as `sqlite` and `postgres` are for `db`.
- **Per-repository profiles.** Profiles become definable per repository, for
  example Alpine plus `node22`, `bun` and `postgres`. Each repository has its
  own lock of built image digests.
- **Declared versions.** Versions can come from the repository's
  declarations: `mise.toml`, `.tool-versions`, `package.json` engines,
  `rust-toolchain.toml` or `.python-version`. Repository content is
  untrusted. The host checks each declaration against an allowlist of
  features and versions. Fetching a new toolchain needs operator approval.
- **Role policy.** Policy moves from profile names to classes. The
  Coordinator, Planner and Reviewer get the minimal class. Worker and
  verification get the repository's extended class.

## Language packages: trust the lockfile

Package safety is the user's responsibility. The trust boundary is the
lockfile.

- **Trusted:** the lockfile in the protected base commit, because a human
  approved its integration.
- **Untrusted:** a lockfile inside a candidate. No one has approved it yet.

### Preparer VM

Install scripts often download binaries:

- Playwright and Puppeteer browsers, Cypress, Electron and Prisma engines;
- older `sharp`;
- `prebuild-install` and `node-pre-gyp` modules;
- some Rust `build.rs` scripts.

Platform packages, such as those of esbuild, swc and rollup, must also match
the VM (Linux, arm64, musl or glibc), not the macOS host. So installation
runs in a **preparer VM**, never on the host:

1. **Create the VM.** It boots the repository's profile image. Egress is
   limited to an allowlist (below). It gets no credentials and no repository
   write access.
2. **Install from the trusted lockfile.** Install scripts run, for example
   `bun install --frozen-lockfile`, `cargo fetch` with a build, or `uv sync`.
3. **Save the result.** The host copies out `node_modules` and the tool
   caches as a digest-pinned artifact. The artifact is keyed by the lockfile
   digest, the profile image digest and the allowlist.
4. **Use it offline.** Worker and verification VMs mount the artifact
   read-only and do not need the network.
5. **Audit.** The preparer is its own audit role, `Preparer`. The audit
   records the egress grant, with the allowlisted hosts, and the artifact
   digest.

The host never runs a package's code. A malicious package can affect only
the disposable preparer VM and the artifact it produces. Trusting that
artifact is the user's choice.

### Egress allowlist

- **Defaults per ecosystem:**
  - npm and Bun: `registry.npmjs.org`;
  - Cargo: `crates.io`, `index.crates.io` and `static.crates.io`;
  - pip and uv: `pypi.org` and `files.pythonhosted.org`.

  The host picks them from the lockfile types present.

- **User additions.** The user adds hosts per repository, for example a
  Playwright download host, `github.com` and `objects.githubusercontent.com`,
  or an internal mirror.
  - **Where they live:** additions are host-side configuration. A list inside
    the repository is read only from the base commit, and changing it needs
    human approval. Otherwise a Worker could widen its own egress.
  - **Format:** entries are exact host names and ports, which is the unit of
    Microsandbox network rules. No wildcards or IP ranges at first.
  - **Effect:** the list is part of the artifact key and of the audit
    record. Changing it rebuilds the artifact.
- **Authenticated registries.** A registry that needs credentials can later
  use the existing credentialed-egress mechanism, where the host substitutes
  a credential at egress. That would be one binding per host.
- **Diagnostics.** When a connection is refused, the preparer should report
  the destination host, so the user can decide whether to allow it. It is not
  yet verified whether Microsandbox exposes refused destinations.

### Known large downloads

Profile features provide common large downloads, so the preparer does not
fetch them each time. For example, the `chromium` feature provides a browser.
Environment variables then turn off the package's own download and point it
at the provided copy:

- Playwright: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` and the executable path;
- Puppeteer: `PUPPETEER_SKIP_DOWNLOAD`;
- Prisma and Electron: their mirror variables.

### Dependency changes

A Worker cannot fetch anything, so adding or updating a dependency is a
separate, two-phase flow. It is never part of a feature candidate.

1. **Resolve.** The Worker, or the Coordinator, proposes a manifest change
   (`package.json`, `Cargo.toml`, `pyproject.toml`). A preparer VM
   regenerates only the lockfile, with registry egress and install scripts
   disabled. Examples are `bun install --lockfile-only`, `cargo update -p`
   and `uv lock`.
2. **Approve.** The manifest and lockfile change is the candidate. The
   approval screen lists the added, removed and changed packages
   prominently. When a human approves and integrates it, the lockfile
   becomes trusted, and that approval is where the user takes
   responsibility.
3. **Continue.** On the new base, the preparer installs from the now-trusted
   lockfile, and the Worker continues the original task.

Mixing dependency changes into a feature candidate would install from an
unapproved lockfile before approval. The Coordinator gets a delegation kind
such as `requestDependencyChange`, and the task pauses until that change is
approved.
