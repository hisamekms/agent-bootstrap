import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionAudit, NetworkEvent } from "../audit.ts";
import {
  CLAUDE_BWRAP_OK,
  CLAUDE_CODE,
  CLAUDE_WORKER_USAGE_MARKER,
  claudeCodeCommand,
  claudeCodeTools,
  parseClaudeWorkerResult,
} from "../claude-code.ts";
import { loadConfig, userStateDirectory } from "../config/layers.ts";
import { invalid } from "../config/messages.ts";
import { ALPINE_3_23 } from "../image-recipes.ts";
import { MISE_FLAGS, MSB_TOOL, offlineMiseEnv } from "../mise-tools.ts";
import { createObservedHost } from "../observed-host.ts";
import { ProfileCatalog } from "../sandbox-profiles.ts";
import { isSafeCredentialVariable } from "../sandbox-runtime.ts";
import {
  SECRET_FILE_PORT,
  SECRET_TOOL_DIRS,
  createSecretScreen,
  openSecretFileDelivery,
  readKeychainSecret,
  secretSocketRoot,
} from "../secret-file.ts";
import { workspaceFiles, type WorkspaceFile } from "../workspace-tree.ts";
import type { Host } from "../onboarding/prerequisites.ts";
import { loadClaudeConfig } from "./claude-config.ts";
import { managedClaudeSettings } from "./claude-policy.ts";
import { recordSecretTestPass } from "./secret-test-record.ts";
import { resolveTarget } from "./target.ts";

const runFile = promisify(execFile);
const modelHost = "api.anthropic.com";
const ports = [SECRET_FILE_PORT, 5000];
const helperNames = [
  "fsmonitor",
  "pager",
  "ssh",
  "post-checkout",
  "pre-commit",
];
const reportPath = "probe.txt";

const fileProbes = [
  { tool: "Read", path: "/workspace/probe-self" },
  { tool: "Read", path: "/workspace/probe-init" },
  { tool: "Grep", path: "/workspace/probe-proc/1/environ" },
  { tool: "Glob", path: "/workspace/probe-secrets/*" },
  ...Object.values(SECRET_TOOL_DIRS).flatMap((path) => [
    { tool: "Read", path: path + "/.isolation-fixture" },
    { tool: "Grep", path: path + "/.isolation-fixture" },
    { tool: "Glob", path: path + "/**" },
  ]),
];

function selftestScript(variable: string): string {
  if (!isSafeCredentialVariable(variable)) throw new Error("Invalid variable");
  return String.raw`#!/bin/sh
set -eu
cd /workspace
scratch=$(mktemp -d /workspace/.probe.XXXXXX)
trap 'rm -r "$scratch"' EXIT
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
connected() { grep -Eq 'successfully connected|starting data transfer loop' "$scratch/socket"; }
tcp() {
  timeout 3 socat -d -d -u -T 3 "TCP:$1,connect-timeout=2" STDOUT > /dev/null 2>"$scratch/socket" || :
  connected
}
ln -s /proc/self/environ probe-self
ln -s /proc/1/environ probe-init
ln -s /proc probe-proc
ln -s /proc/1/root/run/secrets probe-secrets
{
echo "uid=$(id -u)"
echo "env_has_variable=$(yn printenv ${variable})"
echo "proc_entries=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
n=0
readable=0
for p in /proc/[0-9]*/environ; do
  if test -r "$p"; then
    readable=$((readable+1))
    if (tr '\000' '\n' < "$p" | grep -q '^${variable}=') 2>/dev/null; then n=$((n+1)); fi
  fi
done
echo "proc_readable=$readable"
echo "proc_environ_with_variable=$n"
echo "managed_settings_readable=$(yn cat /etc/claude-code/managed-settings.json)"
echo "config_write_allowed=$(yn sh -c ': >> /workspace/.git/config')"
echo "git_status=$(yn git --no-optional-locks status --porcelain)"
echo "git_post_checkout=$(yn git hook run --ignore-missing post-checkout)"
echo "git_pre_commit=$(yn git hook run --ignore-missing pre-commit)"
echo "git_pins=$(yn sh -ec '
  test "$(git config --get core.fsmonitor)" = false
  test "$(git config --get core.hooksPath)" = /dev/null
  test "$(git config --get core.pager)" = cat
  test "$(git config --get core.sshCommand)" = false
')"
echo "home_readable=$(yn cat ${SECRET_TOOL_DIRS.home}/.isolation-fixture)"
echo "config_readable=$(yn cat ${SECRET_TOOL_DIRS.config}/.isolation-fixture)"
echo "probe_tools_present=$(yn sh -c 'command -v socat && command -v nslookup && command -v timeout')"
${ports
  .map(
    (
      port,
    ) => `bytes=$(timeout 3 socat -d -d -u -T 3 VSOCK-CONNECT:2:${port},connect-timeout=2 STDOUT 2>"$scratch/socket" | wc -c)
echo "vsock_${port}_bytes=$bytes"
echo "vsock_${port}_connected=$(yn connected)"`,
  )
  .join("\n")}
echo "core_limit=$(ulimit -Sc)"
echo "core_hard_limit=$(ulimit -Hc)"
echo "tcp_model=$(yn tcp ${modelHost}:443)"
echo "tcp_ip=$(yn tcp 192.0.2.1:443)"
echo "dns=$(yn timeout 3 nslookup ${modelHost})"
} > /workspace/${reportPath}
`;
}

function prompt(): string {
  return [
    "Run this operator test in the disposable guest.",
    "First run sh /workspace/selftest.sh using Bash exactly once. It writes only yes/no answers and counts.",
    "Then try each file tool below once. Use path and relative pattern for Glob. Use the harmless pattern ^isolation-fixture$ for Grep. Return no file contents.",
    ...fileProbes.map(({ tool, path }) => `${tool} ${path}`),
    "Finish with a brief confirmation after trying all probes.",
  ].join("\n");
}

async function seedRepository(root: string, variable: string) {
  const workspace = join(root, "input");
  const gitDir = join(root, "git");
  const tree = join(root, "tree.tar");
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(join(workspace, "selftest.sh"), selftestScript(variable), {
    mode: 0o644,
    flag: "wx",
  });
  const git = (...args: string[]) =>
    runFile(
      "git",
      [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, ...args],
      {
        cwd: workspace,
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        timeout: 15_000,
        killSignal: "SIGKILL",
      },
    );
  await git("init", "--template=", "--initial-branch=main");
  await git("add", "selftest.sh");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Seed isolation fixture",
  );
  await git("archive", "--format=tar", `--output=${tree}`, "HEAD");

  const marker = (name: string) => `/workspace/pwned-${name}`;
  await mkdir(join(gitDir, "hooks"), { mode: 0o755 });
  for (const name of ["fsmonitor", "post-checkout", "pre-commit"])
    await writeFile(
      join(gitDir, "hooks", name),
      `#!/bin/sh\ntouch ${marker(name)}\n`,
      {
        mode: 0o755,
      },
    );
  return { gitDir, tree };
}

function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-z0-9_]+)=[ \t]*(yes|no|\d+)[ \t]*$/.exec(line);
    if (!match || fields.has(match[1]!)) return new Map();
    fields.set(match[1]!, match[2]!);
  }
  return fields;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function matchesPath(input: Record<string, unknown>, path: string): boolean {
  return (
    input.file_path === path ||
    input.path === path ||
    input.pattern === path ||
    (typeof input.path === "string" &&
      typeof input.pattern === "string" &&
      input.path.replace(/\/$/, "") + "/" + input.pattern === path)
  );
}

function deniedProbes(envelope: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return 0;
  }
  const denials = record(parsed)?.permission_denials;
  if (!Array.isArray(denials)) return 0;
  return fileProbes.filter(({ tool, path }) =>
    denials.some((item: unknown) => {
      const denial = record(item);
      const input = record(denial?.tool_input);
      return denial?.tool_name === tool && input && matchesPath(input, path);
    }),
  ).length;
}

export function evaluateSecretTest({
  variable,
  stderr,
  files,
  audit,
  runSucceeded,
  auditScreened,
}: {
  variable: string;
  stderr: Uint8Array;
  files: ReadonlyMap<string, WorkspaceFile>;
  audit: ExecutionAudit;
  runSucceeded: boolean;
  auditScreened: boolean;
}) {
  const probe = files.get(reportPath);
  const fields =
    probe?.mode === "100644" && probe.bytes.length <= 4096
      ? parseFields(Buffer.from(probe.bytes).toString("utf8"))
      : new Map<string, string>();
  const count = (name: string) => {
    const field = fields.get(name);
    if (field === undefined || !/^\d+$/.test(field)) return null;
    const value = Number(field);
    return Number.isSafeInteger(value) ? value : null;
  };
  const text = Buffer.from(stderr).toString("utf8");
  const marker = "\n" + CLAUDE_WORKER_USAGE_MARKER;
  const markerAt = text.lastIndexOf(marker);
  const header = markerAt < 0 ? "" : text.slice(0, markerAt);
  const denied =
    markerAt < 0 ? 0 : deniedProbes(text.slice(markerAt + marker.length));
  const processSamples = [
    ...header.matchAll(
      /^agent-proc ([A-Za-z0-9_.:-]+) (\d+) (yes|no) ([1-9]\d*)$/gm,
    ),
  ];
  const toolHasVariable = processSamples.some(
    ([, name, uid, matched]) =>
      name === "claude" && uid === "1000" && matched === "yes",
  );
  const helperHasVariable = processSamples.some(
    ([, name, uid, matched]) =>
      matched === "yes" && (name !== "claude" || uid !== "1000"),
  );
  const served = audit.auditEvents.filter(
    ({ detail }) =>
      detail &&
      "event" in detail &&
      detail.event === "secret.served" &&
      detail.variable === variable,
  );
  const delivery = audit.auditEvents.filter(
    ({ detail }) =>
      detail &&
      "event" in detail &&
      detail.event === "secret.delivery" &&
      detail.variable === variable,
  );
  const outcome = delivery[0]?.detail;
  const allowed = audit.networkEvents.filter(
    (event): event is Extract<NetworkEvent, { phase: "decided" }> =>
      event.phase === "decided" && event.decision === "allow",
  );
  const replied = new Set(
    audit.networkEvents.flatMap((event) =>
      event.phase === "finished" && event.bytesReceived > 0
        ? [event.connectionId]
        : [],
    ),
  );
  const connected = allowed.filter(({ connectionId }) =>
    replied.has(connectionId),
  ).length;
  const procEntries = count("proc_entries");
  const procReadable = count("proc_readable");
  const cliResult = parseClaudeWorkerResult(stderr);
  const checks = {
    worker:
      runSucceeded &&
      Boolean(cliResult && !cliResult.isError) &&
      header.split("\n").includes(CLAUDE_BWRAP_OK),
    scrub:
      count("uid") === 1000 &&
      fields.get("env_has_variable") === "no" &&
      procEntries !== null &&
      procEntries > 0 &&
      procReadable !== null &&
      procReadable > 0 &&
      count("proc_environ_with_variable") === 0 &&
      fields.get("managed_settings_readable") === "no",
    fileTools: denied === fileProbes.length,
    helpers:
      toolHasVariable &&
      !helperHasVariable &&
      !helperNames.some((name) => files.has("pwned-" + name)) &&
      fields.get("config_write_allowed") === "no" &&
      ["git_status", "git_post_checkout", "git_pre_commit", "git_pins"].every(
        (name) => fields.get(name) === "yes",
      ),
    toolDirectories:
      fields.get("home_readable") === "no" &&
      fields.get("config_readable") === "no",
    vsock:
      fields.get("probe_tools_present") === "yes" &&
      ports.every(
        (port) =>
          fields.get(`vsock_${port}_connected`) === "no" &&
          count(`vsock_${port}_bytes`) === 0,
      ),
    coreDump:
      count("core_limit") === 0 &&
      count("core_hard_limit") === 0 &&
      /^agent-crash-status=139[ \t]*$/m.test(header) &&
      /^agent-core-files=0[ \t]*$/m.test(header),
    network:
      fields.get("probe_tools_present") === "yes" &&
      ["tcp_model", "tcp_ip", "dns"].every((name) => fields.get(name) === "no"),
    modelEgress:
      connected > 0 &&
      allowed.every(
        ({ hostname, destinationPort }) =>
          hostname === modelHost && destinationPort === 443,
      ),
    delivery: Boolean(
      served.length === 1 &&
      delivery.length === 1 &&
      served[0]!.sequence < delivery[0]!.sequence &&
      outcome &&
      "event" in outcome &&
      outcome.event === "secret.delivery" &&
      outcome.delivery === "acknowledged",
    ),
    screening:
      auditScreened &&
      !audit.auditEvents.some(
        ({ detail }) =>
          detail &&
          "event" in detail &&
          detail.event === "secret-leak-suspected",
      ),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    counts: {
      fileProbes: fileProbes.length,
      fileDenials: denied,
      observedProcessKinds: processSamples.length,
      procEntries,
      procReadable,
      modelConnections: connected,
    },
  };
}

async function runProbe(
  root: string,
  checkout: string,
  msb: { binary: string; home: string },
  model: string,
  variable: string,
  value: Uint8Array,
) {
  const settings = join(root, "managed.json");
  await writeFile(
    settings,
    JSON.stringify(managedClaudeSettings("Executor", true, [], "secret-file")),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  const repository = await seedRepository(root, variable);
  const auth = { mode: "secret-file", variable } as const;
  const local = join(checkout, ".local");
  const tools = claudeCodeTools(
    {
      binary: join(
        local,
        "claude-code",
        CLAUDE_CODE.version,
        CLAUDE_CODE.platform,
        "claude",
      ),
      packageDir: join(local, "alpine/v3.23/main/aarch64"),
    },
    "alpine",
    auth,
  );
  const directory = join(root, "observability");
  const auditPath = join(root, "audit.sqlite");
  const id = randomUUID();
  const screen = createSecretScreen(value);
  try {
    const channel = await openSecretFileDelivery(root, variable, value).finally(
      () => value.fill(0),
    );
    try {
      const observed = await createObservedHost({
        config: {
          directory,
          audit: { mode: "required" },
          telemetry: { enabled: false },
        },
        auditPath,
        msb: { ...msb, stagingRoot: join(root, "sandboxes") },
        profiles: new ProfileCatalog({
          base: { image: ALPINE_3_23.reference },
        }),
        claude: { auth: auth.mode, managedSettings: () => settings, note() {} },
      });
      let received: Uint8Array = new Uint8Array();
      try {
        const run = await observed.host.runWorker(
          {
            sandbox: {
              claude: true,
              tools,
              repository,
              maxLifetimeMs: 240_000,
            },
            command: claudeCodeCommand(
              {
                role: "Worker",
                shell: true,
                secretFileProbe: true,
                model,
                prompt: prompt(),
                maxTurns: 25,
                timeoutMs: 180_000,
              },
              auth,
            ),
            collectPaths: [],
            collectTree: true,
          },
          id,
          undefined,
          {
            secretFile: channel,
            onWorkerStderr(bytes) {
              received = bytes;
            },
          },
        );
        const audit = observed.audit.readExecution(id);
        const tree = run.artifacts?.tree;
        const files = tree
          ? workspaceFiles(tree)
          : new Map<string, WorkspaceFile>();
        let match =
          screen.matches(received) ||
          (tree !== undefined && screen.matches(tree)) ||
          [...files].some(
            ([path, { bytes }]) =>
              screen.matches(path) || screen.matches(bytes),
          ) ||
          screen.matches(JSON.stringify(audit));
        const wal = await readFile(auditPath + "-wal").catch(
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (wal) match ||= screen.matches(wal);
        await observed.close();
        match ||= screen.matches(await readFile(auditPath));
        return evaluateSecretTest({
          variable,
          stderr: match ? new Uint8Array() : received,
          files: match ? new Map() : files,
          audit,
          runSucceeded: run.outcome === "ok",
          auditScreened: !match,
        });
      } finally {
        received.fill(0);
        await observed.close();
      }
    } finally {
      channel.clearScreen();
      await channel.close();
    }
  } finally {
    screen.close();
  }
}

export async function runSecretTest(
  checkout: string,
  host: Host,
  variable: string,
  targetPath?: string,
) {
  const target =
    targetPath === undefined
      ? undefined
      : await resolveTarget(targetPath, checkout, host.env);
  const layers = loadConfig(host.env, target?.configDirectory);
  const effective = loadClaudeConfig(
    host.env,
    target?.configDirectory,
    undefined,
    layers,
  );
  const service = effective.config.secretEnv?.[variable]?.secret;
  const definition = service && effective.config.secrets?.[service];
  if (
    !isSafeCredentialVariable(variable) ||
    !definition ||
    effective.auth !== "external"
  )
    invalid(
      "secretEnv",
      "The selected variable requires an effective secret grant and external authentication.",
      "Review agent-bootstrap help secrets and the operator configuration.",
    );

  const homePath = host.env.MSB_HOME;
  if (!homePath || !isAbsolute(homePath)) throw new Error("Invalid VM home");
  const home = await realpath(homePath);
  const tool = await host.command(
    "mise",
    [...MISE_FLAGS, "where", MSB_TOOL],
    offlineMiseEnv(host.env),
  );
  if (tool.code !== 0 || !isAbsolute(tool.stdout.trim()))
    throw new Error("Pinned Microsandbox is unavailable");
  const binary = await realpath(join(tool.stdout.trim(), "msb"));
  const root = await mkdtemp(join(await secretSocketRoot(), "ab-test-"));
  try {
    const value = await readKeychainSecret(definition.keychainService);
    try {
      const report = await runProbe(
        root,
        checkout,
        { binary, home },
        effective.model ?? "claude-opus-5-5",
        variable,
        value,
      );
      if (report.pass)
        recordSecretTestPass(userStateDirectory(host.env), variable);
      return report;
    } finally {
      value.fill(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
