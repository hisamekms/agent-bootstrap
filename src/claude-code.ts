import {
  isSafeCredentialVariable,
  permitsProviderHeader,
  type SandboxCommand,
  type SandboxProvider,
  type SandboxTool,
} from "./sandbox-runtime.ts";
import { SECRET_FILE_PORT, SECRET_TOOL_DIRS } from "./secret-file.ts";
import { FEATURES } from "./image-recipes.ts";

/** The pinned official Claude Code CLI build for Alpine/musl arm64 guests.
 * Checksum from https://downloads.claude.ai/claude-code-releases/2.1.332/manifest.json */
export const CLAUDE_CODE = {
  version: "2.1.332",
  platform: "linux-arm64-musl",
  sha256: "122dd3751257a9e769d8c08b19d16e45f3e86c43a09e18d7182fc01c81143246",
  guestPath: "/tmp/claude",
} as const;

/** The guest userland a sandbox image provides. Alpine (musl, busybox) is the
 * base and db profiles; Debian (glibc, GNU coreutils, bash) is browser. */
export type GuestKind = "alpine" | "debian";

/** The pinned CLI build per guest kind (same version, per-libc binary). */
export const CLAUDE_CODE_BUILDS = {
  alpine: { platform: "linux-arm64-musl", sha256: CLAUDE_CODE.sha256 },
  debian: {
    platform: "linux-arm64",
    sha256: "50c305fcb8912851ce774429131d94ed6f84edbe3d8d0ed7a59dade5d893acc0",
  },
} as const;

/** Claude Code needs bash. Debian images have it; the pinned Alpine 3.23
 * image has none. These are Alpine's signed packages, verified by `apk` with the image's own keys. */
export const CLAUDE_CODE_GUEST_PACKAGES = [
  {
    name: "bash-5.3.3-r1.apk",
    sha256: "5557dc5d3dbf3bb3e64f7aad4cfe535a6bffe4c2c13b81d527ef25dd6c438652",
  },
  {
    name: "readline-8.3.1-r0.apk",
    sha256: "70d288a6c3d8daf19b10fb220120d2ebd6f154011c96ca5bc84923b658cb21f7",
  },
  {
    name: "libncursesw-6.5_p20251123-r0.apk",
    sha256: "7fe332c8af8b97579e89df56466f83f4abda5040a18e1842c07d684320bbef4b",
  },
  {
    name: "ncurses-terminfo-base-6.5_p20251123-r0.apk",
    sha256: "6952a6b39abaf7bbc498cb085f0f59bf23619b53b3f7328b08fe50c0198a2bd4",
  },
] as const;

const SECRET_RUNTIME_PACKAGES = [
  {
    name: "bubblewrap-0.12.0-r0.apk",
    sha256: "626dc90e578d23c57fb41ddfd777f4019615e82f803957115eda482fde71883b",
  },
  {
    name: "libcap2-2.78-r0.apk",
    sha256: "b92145d3ceaf2ba81106241e2939eafc7aacb9c32590e4b1be37171fd2f61112",
  },
  {
    name: "socat-1.8.1.3-r0.apk",
    sha256: "e415cdf30d41bbf4053ab52eb71c55fb9f5c3b811cd53cf22182960888186cbf",
  },
  {
    name: "libssl3-3.5.9-r1.apk",
    sha256: "c6e06484ab80e8c575b4c3c0e0cea34b350d8cbd35406e59e186ee1a3e0ebedf",
  },
  {
    name: "libcrypto3-3.5.9-r1.apk",
    sha256: "719af95f8e01494aa8dd0e06e3af6d0eaf96cb816d13c52c81628e2780c1adae",
  },
] as const;

export const SECRET_FILE_PACKAGES = [
  ...SECRET_RUNTIME_PACKAGES,
  ...FEATURES.git.packages,
  ...FEATURES.zstd.packages,
];

export const SECRET_FILE_TOOL_COUNT =
  1 + CLAUDE_CODE_GUEST_PACKAGES.length + SECRET_FILE_PACKAGES.length;

function guestPackages(secretFile: boolean) {
  return secretFile
    ? [...CLAUDE_CODE_GUEST_PACKAGES, ...SECRET_FILE_PACKAGES]
    : CLAUDE_CODE_GUEST_PACKAGES;
}

export const CLAUDE_MOUNT_ENV = ["CLAUDE_CONFIG_DIR"] as const;

export function claudeMountArgv(
  argv: readonly string[],
  path?: string,
  restricted = false,
): readonly string[] {
  return path || restricted
    ? [
        "/usr/bin/env",
        ...(path ? [`LO_MOUNT_CONFIG_DIR=${path}`] : []),
        ...(restricted ? ["LO_MOUNT_RESTRICTED=1"] : []),
        ...argv,
      ]
    : argv;
}

export const CLAUDE_MANAGED_PATH = "/etc/claude-code/managed-settings.json";
export const CLAUDE_MANAGED_STAGING = "/tmp/claude-managed-settings.json";
export const CLAUDE_BWRAP_OK = "agent-bootstrap-bwrap-ok";
export const CLAUDE_BWRAP_FAILED = "agent-bootstrap-bwrap-failed";

export type ClaudeCodeAuth =
  | { readonly mode: "api-key"; readonly credential: "host-secret" }
  | { readonly mode: "secret-file"; readonly variable: string }
  | {
      readonly mode: "operator-credential";
      readonly variable: string;
      readonly header: "authorization" | "x-api-key";
    }
  | { readonly mode: "native-cli" | "external" };

export class ClaudeCodeUnsupportedError extends Error {
  constructor(what: string) {
    super(`Claude Code: ${what} is not supported in disposable VMs`);
    this.name = "ClaudeCodeUnsupportedError";
  }
}

/** The guest variable and header for a supported mode. */
function credentialOf(auth: ClaudeCodeAuth): {
  variable: string;
  header: "authorization" | "x-api-key";
  bare: boolean;
} {
  if (auth.mode === "api-key" && auth.credential === "host-secret")
    return { variable: "ANTHROPIC_API_KEY", header: "x-api-key", bare: true };
  if (auth.mode === "operator-credential") {
    if (
      !isSafeCredentialVariable(auth.variable) ||
      (auth.header !== "authorization" && auth.header !== "x-api-key") ||
      (auth.variable === "ANTHROPIC_API_KEY" && auth.header !== "x-api-key")
    )
      throw new Error("Invalid operator credential");
    return { variable: auth.variable, header: auth.header, bare: false };
  }
  throw new ClaudeCodeUnsupportedError("native CLI authentication");
}

export function parseOperatorClaudeAuth(
  value: string | undefined,
): ClaudeCodeAuth {
  const [mode, variable, header, extra] = (value ?? "").split(":");
  if (
    mode !== "operator" ||
    !variable ||
    (header !== "authorization" && header !== "x-api-key") ||
    extra !== undefined
  )
    throw new Error("Set LO_CLAUDE_AUTH to operator:<VARIABLE>:<header>");
  const auth = { mode: "operator-credential", variable, header } as const;
  credentialOf(auth);
  return auth;
}

/** Provider egress for the Anthropic API host. */
export function claudeCodeProvider(
  auth: ClaudeCodeAuth,
  fixture?: { host: string; port: number; upstreamCaCertPath: string },
  gatewayHosts: readonly string[] = [],
): SandboxProvider {
  if (auth.mode === "secret-file")
    throw new Error("Secret-file mode uses plain audited egress");
  const { variable, header } = credentialOf(auth);
  const provider = {
    host: fixture?.host ?? "api.anthropic.com",
    secretEnv: variable,
    header,
    ...(fixture
      ? { port: fixture.port, upstreamCaCertPath: fixture.upstreamCaCertPath }
      : {}),
  };
  if (!permitsProviderHeader(provider, gatewayHosts))
    throw new Error(
      "Authorization substitution requires an operator gateway host",
    );
  return provider;
}

/** Host paths of the verified CLI binary and guest packages. */
export interface ClaudeCodeInstall {
  readonly binary: string;
  /** Directory holding CLAUDE_CODE_GUEST_PACKAGES by name. */
  readonly packageDir: string;
}

export function claudeCodeTools(
  install: ClaudeCodeInstall,
  guest: GuestKind = "alpine",
  auth?: ClaudeCodeAuth,
): SandboxTool[] {
  const secretFile = auth?.mode === "secret-file";
  if (secretFile && guest !== "alpine")
    throw new ClaudeCodeUnsupportedError("secret-file mode on this guest");
  const binary = {
    hostPath: install.binary,
    guestPath: CLAUDE_CODE.guestPath,
    sha256: CLAUDE_CODE_BUILDS[guest].sha256,
  };
  if (guest === "debian") return [binary];
  return [
    binary,
    ...guestPackages(secretFile).map((item, index) => ({
      hostPath: `${install.packageDir}/${item.name}`,
      guestPath: `/tmp/apk-${index}.apk`,
      sha256: item.sha256,
    })),
  ];
}

/** The exact tool set each role sees (`--tools`), all pre-approved. Bash is
 * offered only to a Worker task that opts in with `shell: true`: the VM has
 * credentialed egress, and file tools are enough by default.
 * Pinning the set matters outside bare mode, where the CLI would otherwise
 * offer agents, workflows, scheduling and deferred tools. */
const roleTools = {
  // The Coordinator gets no tools: it answers with one JSON action that the
  // host router validates.
  Coordinator: { tools: [], mode: "default" },
  Planner: { tools: ["Read", "Glob", "Grep"], mode: "default" },
  Reviewer: { tools: ["Read", "Glob", "Grep"], mode: "default" },
  Worker: {
    tools: ["Read", "Glob", "Grep", "Edit", "Write"],
    mode: "acceptEdits",
  },
} as const;

export interface ClaudeCodeTask {
  readonly role: keyof typeof roleTools;
  /** Untrusted task text. Passed as one argv entry, never interpolated. */
  readonly prompt: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  /** Override for local fixtures, e.g. `https://host.microsandbox.internal:8443`. */
  readonly baseUrl?: string;
  /** Opt-in Bash for the Worker only. Pre-approved through `--allowedTools`. */
  readonly shell?: boolean;
  /** Emit a bounded result envelope to the host's existing Worker stderr hook. */
  readonly reportWorkerUsage?: boolean;
  /** Enable aggregate launcher diagnostics for an operator validation run. */
  readonly secretFileProbe?: boolean;
}

/** Verify the staged CLI and packages, install offline, and check the placeholder. */
export function claudeCodeGuestSetup(
  variable: string | undefined,
  guest: GuestKind,
  secretFile = false,
): string {
  if (variable !== undefined && !isSafeCredentialVariable(variable))
    throw new Error("Invalid credential variable");
  const packages = guestPackages(secretFile)
    .map((item, index) => `${item.sha256}  /tmp/apk-${index}.apk`)
    .join("\\n");
  const bashSetup =
    guest === "alpine"
      ? `    printf '${packages}\\n' | sha256sum -c - >/dev/null
    apk add --no-network --no-cache /tmp/apk-*.apk >/dev/null 2>&1 </dev/null
`
      : "";
  return `    printf '%s  ${CLAUDE_CODE.guestPath}\\n' '${CLAUDE_CODE_BUILDS[guest].sha256}' | sha256sum -c - >/dev/null
${bashSetup}    command -v bash >/dev/null
    chmod 700 ${CLAUDE_CODE.guestPath}
${
  variable
    ? `    test "$${variable}" = '$MSB_${variable}'
`
    : ""
}`;
}

export const CLAUDE_WORKER_USAGE_MARKER = "agent-bootstrap-claude-result ";

function secretFileSetup(cwd: string, worker: boolean): string {
  return `    umask 077
    test -f ${CLAUDE_MANAGED_STAGING}
    mkdir -p /etc/claude-code
    mv ${CLAUDE_MANAGED_STAGING} ${CLAUDE_MANAGED_PATH}
    chown root:root /etc/claude-code ${CLAUDE_MANAGED_PATH}
    chmod 755 /etc/claude-code
    chmod 644 ${CLAUDE_MANAGED_PATH}
    chmod 755 ${CLAUDE_CODE.guestPath}
    adduser -D -H -u 1000 -s /bin/sh agent
    ${worker ? `chown -hR agent:agent ${cwd}` : `chmod -R a+rX ${cwd}`}
    claude_home=${SECRET_TOOL_DIRS.home}
    claude_config=${SECRET_TOOL_DIRS.config}
    claude_tmp=${SECRET_TOOL_DIRS.tmp}
    mkdir -p "$claude_home" "$claude_config" "$claude_tmp"
    chmod 755 /home/agent /home/agent/run
    chown agent:agent "$claude_home" "$claude_config" "$claude_tmp"
    if test -d /workspace/.git; then
      chown -hR root:root /workspace/.git
      chmod -R a+rX,go-w,u-s,g-s /workspace/.git
    else
      mkdir -m 755 /workspace/.git
    fi
    chown root:root /workspace
    chmod 1777 /workspace
    mkdir -m 700 /run/secrets
    mount -t tmpfs -o mode=0700,nosuid,nodev,noexec,size=64k tmpfs /run/secrets
`;
}

const secretGitConfig = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.pager", "cat"],
  ["core.sshCommand", "false"],
  ["safe.directory", "/workspace"],
] as const;

const secretGitEnv = [
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_GLOBAL=/dev/null",
  `GIT_CONFIG_COUNT=${secretGitConfig.length}`,
  ...secretGitConfig.flatMap(([key, value], index) => [
    `GIT_CONFIG_KEY_${index}=${key}`,
    `GIT_CONFIG_VALUE_${index}=${value}`,
  ]),
].join(" ");

export const SECRET_PROBE_SCRIPT = SECRET_TOOL_DIRS.tmp + "/selftest.sh";
export const SECRET_PROBE_REPORT = "probe.txt";
export const SECRET_PROBE_HASH = "agent-probe-sha256";

// Matches the pinned CLI's sandbox placeholders. Recheck when the CLI pin changes.
export const SANDBOX_PLACEHOLDER_BASENAMES = [
  ".env",
  ".env.development",
  ".env.development.local",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
  ".gitmodules",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

export function secretFilePlaceholderCleanup(root = "/workspace"): string {
  const names = SANDBOX_PLACEHOLDER_BASENAMES.map((name) => `-name ${name}`);
  return String.raw`placeholder_root='${root.replaceAll("'", "'\\''")}'
placeholder_paths() {
  find "$placeholder_root" -xdev -path "$placeholder_root/.git" -prune -o \( ${names.join(" -o ")} \) "$@" -print0
}
snapshot_placeholders() {
  umask 077
  placeholders=$(mktemp -d /tmp/agent-placeholders.XXXXXX)
  trap 'rm -f -- "$placeholders/before" "$placeholders/after"; rmdir -- "$placeholders"' EXIT
  placeholder_paths > "$placeholders/before"
}
clean_placeholders() {
  placeholder_paths -type f -size 0 > "$placeholders/after" || return
  bash -ec '
    while IFS= read -r -d "" path; do
      while IFS= read -r -d "" prior; do
        if test "$prior" = "$path"; then continue 2; fi
      done < "$1/before"
      (
        # Anchor the removal in the physical parent and reject redirected paths.
        parent=${"$"}{path%/*}
        cd -P -- "$parent"
        test "$PWD" = "$parent"
        find "./${"$"}{path##*/}" -prune -type f -size 0 -exec rm -f -- {} +
      )
    done < "$1/after"
  ' tool-cleanup "$placeholders"
}`;
}

function secretFileLaunch(
  variable: string,
  probe: boolean,
  worker: boolean,
): string {
  // Keep the challenge script in the shell temp directory, outside file-tool access.
  const observe = probe
    ? String.raw`
        mv /workspace/selftest.sh ${SECRET_PROBE_SCRIPT}
        for dir in "$HOME" "$CLAUDE_CONFIG_DIR" "$TMPDIR"; do
          printf "fixture\n" > "$dir/.isolation-fixture"
          chmod 644 "$dir/.isolation-fixture"
        done
        printf "%s\n" "[core]" "fsmonitor=/workspace/.git/hooks/fsmonitor" "hooksPath=/workspace/.git/hooks" "pager=touch /workspace/pwned-pager" "sshCommand=touch /workspace/pwned-ssh" >> /workspace/.git/config
        crash_status=0
        /bin/busybox su -p -s /bin/sh -c "cd \"\$(mktemp -d \"\$TMPDIR/crash.XXXXXX\")\" && kill -SEGV \$\$" -- agent >/dev/null 2>&1 || crash_status=$?
        printf "agent-crash-status=%s\n" "$crash_status" >&2
        core_files=$(find /workspace /tmp /home/agent/run \( -name core -o -name "core.*" \) -type f | wc -l)
        printf "agent-core-files=%s\n" "$core_files" >&2
        samples=$(mktemp /tmp/agent-observer.XXXXXX)
        (
          while :; do
            for p in /proc/[0-9]*; do
              IFS= read -r comm < "$p/comm" || continue
              case "$comm" in *[!A-Za-z0-9_.:-]*|"") continue;; esac
              uid=$(awk "/^Uid:/ { print \$3 }" "$p/status") || continue
              test -n "$uid" || continue
              present=no
              tr "\\000" "\\n" < "$p/environ" 2>/dev/null | grep -q "^${variable}=" && present=yes
              printf "%s %s %s\n" "$comm" "$uid" "$present"
            done
            sleep 0.1
          done
        ) > "$samples" 2>/dev/null &
        observer=$!
`
    : "";
  const drop = String.raw`printf "%s\000" "$secret" |
          /bin/busybox su -p -s /bin/sh -c "IFS= read -r -d \"\" secret && test -n \"\$secret\" || exit 1
          export ${variable}=\"\$secret\"
          unset secret
          exec \"\$@\" </dev/null" -- agent tool-secret "$@" 2>/tmp/claude-err`;
  // Feed the privilege drop through a private pipe. Only the final tool
  // exec receives the variable in its initial process environment and writes
  // stderr separately from root's probe evidence.
  return String.raw`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
      CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 /bin/sh -ec '
        umask 077
        ulimit -Sc 0
        ulimit -Hc 0
        file=/run/secrets/${variable}
        trap "rm -f $file" EXIT
        : > "$file"
        chmod 400 "$file"
        socat -t 5 -T 15 VSOCK-CONNECT:2:${SECRET_FILE_PORT},connect-timeout=15 \
          SYSTEM:"len=\`dd bs=1 count=8 2>/dev/null\` && len=\`expr 0 + \$len\` && test \$len -gt 0 && test \$len -le 4096 && dd bs=1 count=\$len of=$file 2>/dev/null && test \"\`wc -c < $file\`\" -eq \$len && printf A"
        test -s "$file"
        secret=$(cat "$file" && printf .)
        secret=${"$"}{secret%.}
        rm "$file"
        if ! /bin/busybox su -p -s /bin/sh -c "exec bwrap --ro-bind / / --unshare-all --proc /proc --dev /dev /bin/true" -- agent >/dev/null 2>&1; then
          printf "%s\n" "${CLAUDE_BWRAP_FAILED}" >&2
          exit 1
        fi
        ${worker ? 'eval "$1"; shift; snapshot_placeholders' : ""}
        ${probe ? `printf "%s\\n" "${CLAUDE_BWRAP_OK}" >&2` : ""}
        ${observe}
        (
          ${drop}
        ) &
        tool=$!
        unset secret
        status=0
        wait "$tool" || status=$?
        ${
          probe
            ? String.raw`
        kill "$observer" 2>/dev/null || :
        wait "$observer" 2>/dev/null || :
        sort "$samples" | uniq -c | awk "{ print \"agent-proc\", \$2, \$3, \$4, \$1 }" >&2
        rm -f "$samples"`
            : ""
        }
        ${worker ? 'clean_placeholders || printf "%s\\n" "sandbox placeholder cleanup failed" >&2 || :' : ""}
        exit "$status"
      ' tool-secret${worker ? ' "$placeholder_cleanup"' : ""}`.replace(
    /^ +/gm,
    "",
  );
}

// Root reports the hash, while the bounded read runs with the agent's permissions.
const secretProbeEvidence = `if test -f /workspace/${SECRET_PROBE_REPORT} && test ! -L /workspace/${SECRET_PROBE_REPORT}; then
      hash=$(/bin/busybox su -p -s /bin/sh -c 'timeout 2 head -c 4097 /workspace/${SECRET_PROBE_REPORT}' -- agent | sha256sum)
      printf '%s %s\\n' '${SECRET_PROBE_HASH}' "\${hash%% *}" >&2
    fi`;

export function secretFileLauncherTemplate() {
  return [
    secretFileSetup("/workspace", true),
    secretFileSetup("/review", false),
    secretFileLaunch("FIXTURE_TOKEN", false, false),
    secretFileLaunch("FIXTURE_TOKEN", false, true),
    secretFileLaunch("FIXTURE_TOKEN", true, true),
    secretFilePlaceholderCleanup(),
    secretGitEnv,
    secretProbeEvidence,
  ];
}

/**
 * A guest command running the pinned CLI headlessly. Every flag is a constant
 * or a validated value; only the prompt is caller text, as `$1`.
 *
 * - Worker runs in `/workspace` and prints the bounded collect request on
 *   success, so the host collects the edited files.
 * - Planner and Reviewer run in `/review` and print the CLI's JSON result
 *   (at most 64 KiB) for `parseClaudeCodeResult`.
 */
export function claudeCodeCommand(
  task: ClaudeCodeTask,
  auth: ClaudeCodeAuth = { mode: "api-key", credential: "host-secret" },
  guest: GuestKind = "alpine",
): SandboxCommand {
  if (guest !== "alpine" && guest !== "debian")
    throw new Error("Invalid guest kind");
  const secretFile = auth.mode === "secret-file";
  if (
    secretFile &&
    (!isSafeCredentialVariable(auth.variable) ||
      auth.variable === "ANTHROPIC_API_KEY" ||
      guest !== "alpine" ||
      task.role === "Coordinator")
  )
    throw new Error("Invalid secret-file mode");
  const credential =
    auth.mode === "external" || secretFile ? undefined : credentialOf(auth);
  if (!Object.hasOwn(roleTools, task.role)) throw new Error("Invalid role");
  if (task.secretFileProbe && (!secretFile || task.role !== "Worker"))
    throw new Error("Secret self-test requires a Worker with a secret file");
  if (!/^[a-z0-9][a-z0-9.-]{0,80}$/.test(task.model))
    throw new Error("Invalid Claude model");
  if (
    !Number.isSafeInteger(task.maxTurns) ||
    task.maxTurns < 1 ||
    task.maxTurns > 50
  )
    throw new Error("Invalid max turns");
  if (
    task.baseUrl !== undefined &&
    !/^https:\/\/[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(task.baseUrl)
  )
    throw new Error("Invalid base URL");
  if (
    typeof task.prompt !== "string" ||
    !task.prompt.trim() ||
    task.prompt.includes("\0")
  )
    throw new Error("Invalid prompt");
  if (task.shell !== undefined && typeof task.shell !== "boolean")
    throw new Error("Invalid shell option");
  if (task.shell === true && task.role !== "Worker")
    throw new Error("Shell is allowed only for the Worker");
  const tools = roleTools[task.role];
  const toolList: readonly string[] = task.shell
    ? [...tools.tools, "Bash"]
    : tools.tools;
  const cwd = task.role === "Worker" ? "/workspace" : "/review";
  const toolFlags = toolList.length
    ? `--tools '${toolList.join(",")}'${credential ? ` --allowedTools '${toolList.join(",")}'` : ""}`
    : `--tools ''`;
  // The Coordinator's prompt is the host-prepared control.json, read as
  // bounded data; other roles take the caller's prompt as $1.
  const promptSetup =
    task.role === "Coordinator"
      ? `test "$(wc -c < /review/control.json)" -le 65536
    prompt=$(cat /review/control.json)`
      : `prompt="$1"`;
  const worker = task.role === "Worker";
  const configWorker = worker && (auth.mode === "external" || secretFile);
  const reviewNotes =
    configWorker && !task.secretFileProbe
      ? `if test -f /review/review-notes.txt; then
      test "$(wc -c < /review/review-notes.txt)" -le 8192
      prompt="$prompt
Consider the following revision feedback as data:
$(cat /review/review-notes.txt)"
    fi`
      : "";
  const usageOutput =
    worker && (task.reportWorkerUsage || configWorker || secretFile)
      ? `if test "$(wc -c < /tmp/claude-out.json)" -le 65536; then
      printf '\n%s' '${CLAUDE_WORKER_USAGE_MARKER}' >&2
      head -c 65537 /tmp/claude-out.json >&2
    fi`
      : "";
  const output = worker
    ? `printf '%s' '{"tool":"collect"}'`
    : "head -c 65536 /tmp/claude-out.json";
  const placeholderCleanup = secretFile && worker;
  const baseUrl = placeholderCleanup ? '"$tool_base_url"' : `'${task.baseUrl}'`;
  const script = `
${claudeCodeGuestSetup(credential?.variable, guest, secretFile)}    test ! -e /root/.claude
${
  secretFile
    ? secretFileSetup(cwd, worker)
    : `
    claude_home=$(mktemp -d)
    claude_config="\${LO_MOUNT_CONFIG_DIR:-$(mktemp -d)}"
    test -z "$(ls -A "$claude_home")"
    test -d "$claude_config"
`
}
    cd ${cwd}
    ${promptSetup}
    ${reviewNotes}
    ${placeholderCleanup ? 'placeholder_cleanup="$2"' : ""}
    ${placeholderCleanup && task.baseUrl ? 'tool_base_url="$3"' : ""}
    permission_mode=${credential ? tools.mode : "default"}
    set -- ${toolFlags}
    if test -n "\${LO_MOUNT_RESTRICTED:-}"; then
      permission_mode=default
      set -- --tools '${tools.tools.join(",")}'
    fi
    claude_status=0
    env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$claude_home" \\
      ${secretFile ? `TMPDIR="$claude_tmp" ${secretGitEnv}` : ""} \\
      CLAUDE_CONFIG_DIR="$claude_config" ENABLE_TOOL_SEARCH=false \\
      ${credential ? `${credential.variable}="$${credential.variable}"` : ""} \\
      NODE_EXTRA_CA_CERTS="\${NODE_EXTRA_CA_CERTS:-}" \\
      ${task.baseUrl ? `ANTHROPIC_BASE_URL=${baseUrl} ` : ""}\\
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \\
      DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \\
      ${secretFile ? `${secretFileLaunch(auth.variable, task.secretFileProbe === true, worker)} ` : ""}${CLAUDE_CODE.guestPath} -p ${credential?.bare ? "--bare " : ""}--strict-mcp-config --setting-sources '' \\
        --disable-slash-commands --no-session-persistence --output-format json \\
        --model '${task.model}' --max-turns ${task.maxTurns} \\
        --permission-mode "$permission_mode" \\
        "$@" \\
        -- "$prompt" </dev/null >/tmp/claude-out.json ${secretFile ? "" : "2>/tmp/claude-err "}|| claude_status=$?
    ${task.secretFileProbe ? secretProbeEvidence : secretFile ? "tail -c 8192 /tmp/claude-err >&2" : ""}
    ${usageOutput}
    if test "$claude_status" -ne 0; then
      if test -s /tmp/claude-out.json; then
        head -c 65536 /tmp/claude-out.json
      else
        head -c 8192 /tmp/claude-err
      fi
      exit "$claude_status"
    fi
    ${output}
  `;
  return {
    argv: [
      "/bin/sh",
      "-ec",
      script,
      "claude-code",
      task.prompt,
      // Keep the cleanup functions and optional endpoint within the argv limit.
      ...(placeholderCleanup ? [secretFilePlaceholderCleanup(cwd)] : []),
      ...(placeholderCleanup && task.baseUrl ? [task.baseUrl] : []),
    ],
    timeoutMs: task.timeoutMs,
    ...(secretFile ? { claudeSecretVariable: auth.variable } : {}),
    ...(task.shell ? { claudeShell: true } : {}),
    ...(task.secretFileProbe ? { secretFileProbe: true } : {}),
  };
}

export interface ClaudeCodeResult {
  readonly text: string;
  readonly isError: boolean;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
}

export function parseClaudeWorkerResult(
  bytes: Uint8Array,
): ClaudeCodeResult | null {
  const stderr = Buffer.from(bytes);
  const marker = Buffer.from("\n" + CLAUDE_WORKER_USAGE_MARKER);
  const start = stderr.lastIndexOf(marker);
  return start < 0
    ? null
    : parseClaudeCodeResult(stderr.subarray(start + marker.length));
}

export function claudeWorkerMessage(
  stderr: Uint8Array,
): Uint8Array | undefined {
  const answer = parseClaudeWorkerResult(stderr);
  if (!answer || answer.isError) return;
  try {
    const value: unknown = JSON.parse(answer.text);
    if (
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 1 &&
      "commitMessage" in value &&
      typeof value.commitMessage === "string"
    )
      return Buffer.from(value.commitMessage);
  } catch {}
}

export function readClaudeRunMetrics(value: unknown, attempts: 1 | 2 = 1) {
  const fields = value as Partial<ClaudeCodeResult> | null;
  const bounded = (value: unknown, max: number, integer = true) =>
    typeof value === "number" &&
    (integer ? Number.isSafeInteger(value) : Number.isFinite(value)) &&
    value >= 0 &&
    value <= max * attempts
      ? value
      : null;
  return {
    costUsd: bounded(fields?.costUsd, 10_000, false),
    numTurns: bounded(fields?.numTurns, 10_000),
    durationMs: bounded(fields?.durationMs, 86_400_000),
  };
}

/** Parse the CLI's `--output-format json` result. Untrusted guest data. */
export function parseClaudeCodeResult(
  bytes: Uint8Array | undefined,
): ClaudeCodeResult | null {
  if (!bytes?.length || bytes.length > 65_536) return null;
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as Record<string, unknown>;
    if (!value || typeof value !== "object" || typeof value.result !== "string")
      return null;
    const usage = value.usage as Record<string, unknown> | undefined;
    const count = (key: string) => {
      const number = usage?.[key];
      return typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= 0
        ? number
        : null;
    };
    return {
      text: value.result,
      isError: value.is_error === true,
      ...readClaudeRunMetrics({
        costUsd: value.total_cost_usd,
        numTurns: value.num_turns,
        durationMs: value.duration_ms,
      }),
      inputTokens: count("input_tokens"),
      outputTokens: count("output_tokens"),
      cacheReadInputTokens: count("cache_read_input_tokens"),
      cacheCreationInputTokens: count("cache_creation_input_tokens"),
    };
  } catch {
    return null;
  }
}
