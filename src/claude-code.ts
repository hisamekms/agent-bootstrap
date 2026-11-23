import {
  isSafeCredentialVariable,
  permitsProviderHeader,
  type SandboxCommand,
  type SandboxProvider,
  type SandboxTool,
} from "./sandbox-runtime.ts";

/** The pinned official Claude Code CLI build for Alpine/musl arm64 guests.
 * Checksum from https://downloads.claude.ai/claude-code-releases/2.1.330/manifest.json */
export const CLAUDE_CODE = {
  version: "2.1.330",
  platform: "linux-arm64-musl",
  sha256: "986b83557cbd428273c37f35fc08a44fc786077deeb391660884833bc581348a",
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
    sha256: "6016f90cac783e367fb1aa97c768a2efb94a0128a5b46b70fb3d8fcbbd9dd444",
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

/** API keys are held by the host. Persistent Claude Code configuration
 * directories are kept on an encrypted volume per actor group and signed in
 * with the CLI's own /login. */
export const CLAUDE_GROUP_PATH = "/claude-config";
export const CLAUDE_MANAGED_PATH = "/etc/claude-code/managed-settings.json";

export type ClaudeCodeAuth =
  | { readonly mode: "api-key"; readonly credential: "host-secret" }
  | {
      readonly mode: "operator-credential";
      readonly variable: string;
      readonly header: "authorization" | "x-api-key";
    }
  | { readonly mode: "native-cli" | "config-dir" };

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
): SandboxProvider {
  const { variable, header } = credentialOf(auth);
  const provider = {
    host: fixture?.host ?? "api.anthropic.com",
    secretEnv: variable,
    header,
    ...(fixture
      ? { port: fixture.port, upstreamCaCertPath: fixture.upstreamCaCertPath }
      : {}),
  };
  if (!permitsProviderHeader(provider))
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
): SandboxTool[] {
  const binary = {
    hostPath: install.binary,
    guestPath: CLAUDE_CODE.guestPath,
    sha256: CLAUDE_CODE_BUILDS[guest].sha256,
  };
  if (guest === "debian") return [binary];
  return [
    binary,
    ...CLAUDE_CODE_GUEST_PACKAGES.map((item, index) => ({
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
}

/** Verify the staged CLI and packages, install offline, and check the placeholder. */
export function claudeCodeGuestSetup(
  variable: string | undefined,
  guest: GuestKind,
): string {
  if (variable !== undefined && !isSafeCredentialVariable(variable))
    throw new Error("Invalid credential variable");
  const packages = CLAUDE_CODE_GUEST_PACKAGES.map(
    (item, index) => `${item.sha256}  /tmp/apk-${index}.apk`,
  ).join("\\n");
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
  const credential =
    auth.mode === "config-dir" ? undefined : credentialOf(auth);
  if (!Object.hasOwn(roleTools, task.role)) throw new Error("Invalid role");
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
    ? `--tools '${toolList.join(",")}' --allowedTools '${toolList.join(",")}'`
    : `--tools ''`;
  // The Coordinator's prompt is the host-prepared control.json, read as
  // bounded data; other roles take the caller's prompt as $1.
  const promptSetup =
    task.role === "Coordinator"
      ? `test "$(wc -c < /review/control.json)" -le 65536
    prompt=$(cat /review/control.json)`
      : `prompt="$1"`;
  const worker = task.role === "Worker";
  const usageOutput =
    worker && task.reportWorkerUsage
      ? `if test "$(wc -c < /tmp/claude-out.json)" -le 65536; then
      printf '\n%s' '${CLAUDE_WORKER_USAGE_MARKER}' >&2
      head -c 65537 /tmp/claude-out.json >&2
    fi`
      : "";
  const output = worker
    ? `printf '%s' '{"tool":"collect"}'`
    : "head -c 65536 /tmp/claude-out.json";
  const script = `
${claudeCodeGuestSetup(credential?.variable, guest)}    test ! -e /root/.claude
    claude_home=$(mktemp -d)
    claude_config=${credential ? "$(mktemp -d)" : CLAUDE_GROUP_PATH}
    test -z "$(ls -A "$claude_home")"
    ${credential ? 'test -z "$(ls -A "$claude_config")"' : 'test -d "$claude_config"'}
    cd ${cwd}
    ${promptSetup}
    claude_status=0
    env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$claude_home" \\
      CLAUDE_CONFIG_DIR="$claude_config" ENABLE_TOOL_SEARCH=false \\
      ${credential ? `${credential.variable}="$${credential.variable}"` : ""} \\
      NODE_EXTRA_CA_CERTS="\${NODE_EXTRA_CA_CERTS:-}" \\
      ${task.baseUrl ? `ANTHROPIC_BASE_URL='${task.baseUrl}' ` : ""}\\
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \\
      DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \\
      ${CLAUDE_CODE.guestPath} -p ${credential?.bare ? "--bare " : ""}--strict-mcp-config --setting-sources '' \\
        --disable-slash-commands --no-session-persistence --output-format json \\
        --model '${task.model}' --max-turns ${task.maxTurns} \\
        --permission-mode ${tools.mode} \\
        ${toolFlags} \\
        -- "$prompt" </dev/null >/tmp/claude-out.json 2>/tmp/claude-err || claude_status=$?
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
    argv: ["/bin/sh", "-ec", script, "claude-code", task.prompt],
    timeoutMs: task.timeoutMs,
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
