import {
  isSafeCredentialVariable,
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

/** Claude Code needs bash; the pinned Alpine 3.23 image has none. These are
 * Alpine's signed packages, verified by `apk` with the image's own keys. */
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

/**
 * Authentication for the official `claude` CLI in a disposable VM. In every
 * supported mode the trusted host holds the credential: the guest variable
 * contains only Microsandbox's placeholder, and the backend substitutes the
 * real value into one request header on requests to the provider host.
 *
 * - `api-key` with `host-secret`: `ANTHROPIC_API_KEY` in `x-api-key`, with
 *   `--bare`, which reads no other credential source.
 * - `operator-credential`: a guest variable and header that the operator
 *   chooses for a credential the CLI reads from the environment (for
 *   example `ANTHROPIC_AUTH_TOKEN` in `authorization`). Bare mode reads only
 *   API keys, so this mode runs without `--bare` and relies on explicit
 *   isolation flags instead. The repository supplies, stores, collects and
 *   refreshes no credential; the operator must be permitted to use the
 *   credential this way under the provider's terms.
 * - `native-cli`: CLI-managed login. Unsupported here: a disposable VM has no
 *   session, and host profiles are never mounted implicitly.
 */
export type ClaudeCodeAuth =
  | { readonly mode: "api-key"; readonly credential: "host-secret" }
  | {
      readonly mode: "operator-credential";
      readonly variable: string;
      readonly header: "authorization" | "x-api-key";
    }
  | { readonly mode: "native-cli" };

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
    // The CLI reads these two variables into fixed headers; a different
    // header would leave the placeholder unsubstituted and fail late.
    const fixed: Record<string, string> = {
      ANTHROPIC_API_KEY: "x-api-key",
      ANTHROPIC_AUTH_TOKEN: "authorization",
    };
    if (
      !isSafeCredentialVariable(auth.variable) ||
      (auth.header !== "authorization" && auth.header !== "x-api-key") ||
      (Object.hasOwn(fixed, auth.variable) &&
        fixed[auth.variable] !== auth.header)
    )
      throw new Error("Invalid operator credential");
    return { variable: auth.variable, header: auth.header, bare: false };
  }
  throw new ClaudeCodeUnsupportedError("native CLI authentication");
}

/** Provider egress for the Anthropic API host. */
export function claudeCodeProvider(
  auth: ClaudeCodeAuth,
  fixture?: { host: string; port: number; upstreamCaCertPath: string },
): SandboxProvider {
  const { variable, header } = credentialOf(auth);
  return {
    host: fixture?.host ?? "api.anthropic.com",
    secretEnv: variable,
    header,
    ...(fixture
      ? { port: fixture.port, upstreamCaCertPath: fixture.upstreamCaCertPath }
      : {}),
  };
}

/** Host paths of the verified CLI binary and guest packages. */
export interface ClaudeCodeInstall {
  readonly binary: string;
  /** Directory holding CLAUDE_CODE_GUEST_PACKAGES by name. */
  readonly packageDir: string;
}

export function claudeCodeTools(install: ClaudeCodeInstall): SandboxTool[] {
  return [
    {
      hostPath: install.binary,
      guestPath: CLAUDE_CODE.guestPath,
      sha256: CLAUDE_CODE.sha256,
    },
    ...CLAUDE_CODE_GUEST_PACKAGES.map((item, index) => ({
      hostPath: `${install.packageDir}/${item.name}`,
      guestPath: `/tmp/apk-${index}.apk`,
      sha256: item.sha256,
    })),
  ];
}

/** The exact tool set each role sees (`--tools`), all pre-approved. Bash is
 * never offered: the VM has credentialed egress, and file tools are enough.
 * Pinning the set matters outside bare mode, where the CLI would otherwise
 * offer agents, workflows, scheduling and deferred tools. */
const roleTools = {
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
): SandboxCommand {
  const credential = credentialOf(auth);
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
  const tools = roleTools[task.role];
  const cwd = task.role === "Worker" ? "/workspace" : "/review";
  const packages = CLAUDE_CODE_GUEST_PACKAGES.map(
    (item, index) => `${item.sha256}  /tmp/apk-${index}.apk`,
  ).join("\\n");
  const output =
    task.role === "Worker"
      ? `printf '%s' '{"tool":"collect"}'`
      : "head -c 65536 /tmp/claude-out.json";
  const script = `
    printf '%s  ${CLAUDE_CODE.guestPath}\\n' '${CLAUDE_CODE.sha256}' | sha256sum -c - >/dev/null
    printf '${packages}\\n' | sha256sum -c - >/dev/null
    apk add --no-network --no-cache /tmp/apk-*.apk >/dev/null 2>&1 </dev/null
    command -v bash >/dev/null
    chmod 700 ${CLAUDE_CODE.guestPath}
    # The guest holds only the backend placeholder, never the credential.
    test "$${credential.variable}" = '$MSB_${credential.variable}'
    # No managed policy or pre-seeded CLI state: config and home are fresh.
    # One check per line: under sh -e, a failure inside an && list does not
    # stop the script.
    test ! -e /root/.claude
    test ! -e /etc/claude-code
    claude_home=$(mktemp -d)
    claude_config=$(mktemp -d)
    test -z "$(ls -A "$claude_home")"
    test -z "$(ls -A "$claude_config")"
    cd ${cwd}
    env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$claude_home" \\
      CLAUDE_CONFIG_DIR="$claude_config" ENABLE_TOOL_SEARCH=false \\
      ${credential.variable}="$${credential.variable}" \\
      NODE_EXTRA_CA_CERTS="\${NODE_EXTRA_CA_CERTS:-}" \\
      ${task.baseUrl ? `ANTHROPIC_BASE_URL='${task.baseUrl}' ` : ""}\\
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \\
      DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \\
      ${CLAUDE_CODE.guestPath} -p ${credential.bare ? "--bare " : ""}--strict-mcp-config --setting-sources '' \\
        --disable-slash-commands --no-session-persistence --output-format json \\
        --model '${task.model}' --max-turns ${task.maxTurns} \\
        --permission-mode ${tools.mode} \\
        --tools '${tools.tools.join(",")}' --allowedTools '${tools.tools.join(",")}' \\
        -- "$1" </dev/null >/tmp/claude-out.json 2>/dev/null
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
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
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
      costUsd:
        typeof value.total_cost_usd === "number" &&
        Number.isFinite(value.total_cost_usd)
          ? value.total_cost_usd
          : null,
      inputTokens: count("input_tokens"),
      outputTokens: count("output_tokens"),
    };
  } catch {
    return null;
  }
}
