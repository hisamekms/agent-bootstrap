import { configureClaude, provisionKeychain } from "./prerequisites.ts";

export const exitCodes = {
  0: "Success",
  1: "Command failed or was refused",
  2: "Invalid command or arguments",
  3: "Required prerequisites are missing",
} as const;

const humanRepo =
  "The operator updates local main, pushes branches, and opens pull requests.";
const humanGate =
  "The operator answers human-policy gates unless they explicitly delegate a terminal answer.";
const exampleTarget = "/path/to/project";
const target = `agent-bootstrap --target ${exampleTarget}`;
const launch = `agent-bootstrap concierge --target ${exampleTarget}`;

interface Topic {
  purpose: string;
  prerequisites: string;
  commands: string[];
  output: string;
  next: string;
  human: string;
}

export const helpTopics = {
  start: {
    purpose:
      "Install the linked command and check this machine and a project checkout.",
    prerequisites:
      "An agent-bootstrap checkout, macOS arm64, Bun 1.4.4, and a local SHA-1 Git target with local main.",
    commands: [
      "bun install --frozen-lockfile --ignore-scripts && bun link",
      "agent-bootstrap doctor --json",
      `agent-bootstrap doctor --target ${exampleTarget}`,
    ],
    output:
      "Doctor reports ok, missing, wrong, or skipped for each check and prints one next action. DuckDB, db and browser assets, and target verification are optional.",
    next: "Run agent-bootstrap help setup, then repeat doctor after setup.",
    human: humanRepo,
  },
  setup: {
    purpose:
      "Stage SHA-256-pinned guest artifacts and build the locked Concierge and Bun images.",
    prerequisites:
      "Use doctor to prepare Bun, mise, Microsandbox 0.7.16, installed checkout dependencies, and a short absolute MSB_HOME.",
    commands: [
      'mkdir -p "$HOME/.msb"',
      'export MSB_HOME="$HOME/.msb"',
      "mise --no-config --no-env --no-hooks install microsandbox@0.7.16",
      "agent-bootstrap setup --json",
      "agent-bootstrap setup --allow-network",
      "agent-bootstrap setup --allow-network --profiles",
      ...configureClaude,
      provisionKeychain,
    ],
    output:
      "Default setup prints pinned URLs, hashes and image references. Applying setup downloads missing inputs and builds missing images sequentially. The optional browser build pulls a pinned Debian base and uses the existing Debian snapshot recipe over HTTP with signed and hash-pinned release metadata. A digest mismatch stops setup before the image is published under its locked reference.",
    next: "API-key mode is the default. Enter the API key at the Keychain prompt, then run agent-bootstrap doctor.",
    human:
      "Authorize network access and VM builds. Agents may pass --allow-network --yes only with explicit authorization. Provision Keychain from the operator terminal.",
  },
  concierge: {
    purpose:
      "Open or resume the interactive Concierge that drafts plans and runs the local actor queue.",
    prerequisites:
      "Passing launch prerequisites, an operator TTY, and OSC 52 clipboard access disabled.",
    commands: [launch, `${launch} --continue`, `${launch} --mode default`],
    output:
      "The launcher prints its session ID and audit database path and opens Claude Code. In JSON mode the interactive stream uses stderr and stdout receives a final status object.",
    next: "Describe the desired Goal in the Concierge and inspect proposals from a second host terminal.",
    human: `The operator starts the session and reviews provider access and costs. ${humanRepo}`,
  },
  goals: {
    purpose:
      "Use the Concierge to draft Goals and Tasks, then inspect their progress through the operator CLI.",
    prerequisites:
      "An active Concierge session and the same target in both terminals.",
    commands: [
      `${target} status --json`,
      `${target} proposals --status pending --json`,
      `${target} show "$proposal_id" --json`,
      `${target} show "$goal_id" --json`,
      `${target} show "$task_id" --json`,
    ],
    output:
      "Ask the Concierge to request goal-design from the Planner and present the Goal proposal. Once registered, ask the Concierge to request task planning for that Goal and draft Tasks with acceptance criteria, scoped paths, and dependencies. Eligible Tasks run in the actor queue and a passing review creates an integration proposal.",
    next: "Use agent-bootstrap help approve to review gate decisions. Check status again after the runner consumes them.",
    human: humanGate,
  },
  approve: {
    purpose:
      "Review a pinned proposal, record an answer, and export the completed Goal branch locally.",
    prerequisites:
      "A proposal ID from status or proposals and a host TTY for decisions or export.",
    commands: [
      `${target} policy show --json`,
      `${target} show "$proposal_id" --json`,
      `${target} approve "$proposal_id"`,
      `${target} reject "$proposal_id"`,
      `${target} approve "$proposal_id" --on-behalf --delegate-session "$session_id" --authorization "$authorization"`,
      `${target} export-goal-branch "$goal_id"`,
    ],
    output:
      "Review the digest, effective policy and integration diff stat, choose approve or reject, and type the exact confirmation phrase. Export previews the destination and heads before confirmation.",
    next: "Wait for integration in status. Review the exported lo/goal-* branch before the operator pushes it and opens a PR.",
    human: `${humanGate} ${humanRepo}`,
  },
  audit: {
    purpose:
      "Follow proposal decisions, actor executions, and network denials.",
    prerequisites:
      "A prior or active run for this target and DuckDB 1.5.6 for denial summaries.",
    commands: [
      `${target} events --subject "$task_id" --limit 50 --json`,
      `${target} show-execution "$execution_id" --json`,
      `${target} denials --limit 20 --json`,
      "agent-bootstrap --all-targets denials --since 2026-11-23 --limit 20",
    ],
    output:
      "Events and executions provide IDs and outcomes, and denials provide grouped reasons plus requested detail rows. The launcher records trusted-host evidence in audit.sqlite.",
    next: "Join execution IDs to audit invocation IDs. Inspect the integration journal for an uncertain private Git update.",
    human:
      "Get operator authorization before sharing audit, telemetry, or model output.",
  },
  performance: {
    purpose:
      "Export trace, audit, and orchestrator data and query latency, outcomes, usage, and cost.",
    prerequisites:
      "Locally recorded runs. The export works without DuckDB, while report queries use mise's DuckDB 1.5.6. To install it, run mise --no-config --no-env --no-hooks install duckdb@1.5.6.",
    commands: [
      `${target} analyze --json`,
      "agent-bootstrap --all-targets analyze --out ./private-analysis",
      "agent-bootstrap --all-targets analyze --out ./private-analysis --sql ./report.sql",
    ],
    output:
      "The CLI creates a private export and prints input issues, actor_summary, goal_summary, gate_latency, and a manual DuckDB command for load.sql.",
    next: "Inspect input_issues and sample counts before comparing latency or cost across actors or targets.",
    human: "Use SQL and export destinations authorized by the operator.",
  },
  targets: {
    purpose:
      "Select a repository and configure a pinned candidate verification command.",
    prerequisites:
      "A SHA-1 Git worktree root with local main, outside .local, and a locked, installed verification profile.",
    commands: [
      `agent-bootstrap doctor --target ${exampleTarget}`,
      `${target} verification set --profile bun -- bun test`,
      `${target} verification show --json`,
      `${target} verification clear`,
      `${target} update-goal-base "$goal_id"`,
    ],
    output:
      "Verification show returns its configuration or null. Set and clear require confirmation. Base updates require an eligible, untouched Goal and preview both commits.",
    next: "Launch with the same target. Keep verification configured until its integration proposals are resolved.",
    human: `The operator confirms verification changes and eligible base updates from a host TTY. ${humanRepo}`,
  },
  troubleshoot: {
    purpose:
      "Diagnose missing prerequisites, interrupted sessions, and failed Tasks.",
    prerequisites:
      "Use the same target and database as the launcher. Stop the launcher before reconciling.",
    commands: [
      `agent-bootstrap doctor --target ${exampleTarget}`,
      `${target} reconcile`,
      `${target} show-execution "$execution_id" --json`,
      `${target} retry-task "$task_id"`,
      `${launch} --continue --mode default`,
    ],
    output:
      "Reconcile previews unfinished records before confirmation. Retry registers a failed Task with a new attempt. Claude failures can include a fixed code and next action. Doctor reports the effective authentication mode and its source.",
    next: "Check status for the new attempt. If integration remains uncertain, inspect the private ref and integration journal before retrying.",
    human: "The operator confirms reconciliation and retries from a host TTY.",
  },
  safety: {
    purpose:
      "Keep host credentials, repository integration, and human approvals inside their intended trust boundaries.",
    prerequisites:
      "An operator who controls Keychain, target selection, terminal settings, and gate policy.",
    commands: [
      `${target} policy show --json`,
      `${target} proposals --status pending --json`,
      "agent-bootstrap setup --json",
    ],
    output:
      "Policy reports goal-registration, task-registration, and integration defaults. Proposals carry the effective policy and human-answer requirement.",
    next: "Review the proposed paths, verification result, digest, and policy before answering each gate.",
    human: `${humanRepo} ${humanGate} Keep API keys in Keychain. In config-dir mode, processes inside a Claude VM can read the mounted group directory. Researcher and verification receive neither the directory nor its egress policy.`,
  },
  credentials: {
    purpose:
      "Manage the encrypted volume for persistent Claude Code configuration directories per actor group, signed in with the CLI's own /login.",
    prerequisites:
      "A private config.json with the volume path, Keychain service name and actor groups. API-key mode remains the default.",
    commands: [],
    output:
      "Status reports attachment, active leases and stale state. Init creates the encrypted image and stores its passphrase in Keychain. Attach prepares the volume for a run. Detach clears a stale attachment when no run still holds it.",
    next: "If integrity fails, inspect the evidence path and use credentials verify --accept from an operator terminal. Use the same target and authentication options as the failing run.",
    human:
      "The operator inspects and accepts any intended changes to the group's configuration.",
  },
  login: {
    purpose:
      "Open Claude Code in an audited terminal for a configured actor group.",
    prerequisites:
      "Config-dir mode and a configured encrypted volume. Use a terminal with OSC 52 clipboard access disabled.",
    commands: [],
    output:
      "The CLI can reach the group's configured hosts and its additional login hosts.",
    next: "Use the Claude Code CLI's own /login, then exit the CLI.",
    human: "The operator signs in from the Claude Code CLI.",
  },
} satisfies Record<string, Topic>;

export const operatorOutputs = {
  status: {
    usage: "status",
    json: "{ counts, pending, recentExecutions, recentTasks }",
    next: "Inspect pending proposals with show <proposalId>.",
  },
  proposals: {
    usage: "proposals [--status <pending|approved|rejected|registered>]",
    json: "Array of proposals with effective policy.",
    next: "Review a proposal with show <proposalId>.",
  },
  show: {
    usage: "show <proposalId|goalId|taskId>",
    json: "One proposal, Goal, or Task object.",
    next: "Review agent-bootstrap help approve for gate decisions.",
  },
  approve: {
    usage:
      "approve <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]",
    json: "{ preview, result } with proposal preview and recorded decision.",
    next: "Check status while the Concierge processes the decision.",
  },
  reject: {
    usage:
      "reject <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]",
    json: "{ preview, result } with proposal preview and recorded decision.",
    next: "Check status and revise the plan if needed.",
  },
  policy: {
    usage: "policy show | policy set <gate> <human|agent>",
    json: "Gate-to-policy map for show. { updated: true } for set.",
    next: "Check effective policy on individual proposals.",
  },
  events: {
    usage: "events [--subject <id>] [--limit <1-1000>]",
    json: "Array of event records.",
    next: "Inspect a related execution with show-execution <executionId>.",
  },
  "show-execution": {
    usage: "show-execution <executionId>",
    json: "One execution record with available outcome and usage.",
    next: "Use agent-bootstrap help troubleshoot for a failed execution.",
  },
  "retry-task": {
    usage: "retry-task <taskId>",
    json: "Updated Task record.",
    next: "Check status during an active Concierge session.",
  },
  reconcile: {
    usage: "reconcile",
    json: "{ reconciled } with sessions, executions, and tasks.",
    next: "Use status to inspect any pending proposals.",
  },
  "update-goal-base": {
    usage: "update-goal-base <goalId>",
    json: "{ preview, result } with old and new commits and updated Goal.",
    next: "Check the Goal's base and retry eligible failed Tasks.",
  },
  verification: {
    usage:
      "verification show | verification clear | verification set --profile <name> -- <argv...>",
    json: "{ profile, argv } or null for show. { target, current, verification } for set or clear.",
    next: "Run doctor --target <path> and use the same target for Concierge.",
  },
  "export-goal-branch": {
    usage: "export-goal-branch <goalId> [--target <checkout>]",
    json: "{ goalId, checkout, branch, from, to } for the completed export.",
    next: "Review the exported local branch before the operator pushes and opens a PR.",
  },
  analyze: {
    usage: "analyze [--audit <file>] [--out <dir>] [--sql <file>]",
    json: "{ report } with human-readable tables, export path, and manual DuckDB command.",
    next: "Inspect input_issues and query the generated load.sql.",
  },
  denials: {
    usage: "denials [--since <iso>] [--limit <1-1000>]",
    json: "{ report } with human-readable summary and export details.",
    next: "Inspect the denial reason codes for the affected execution.",
  },
} as const;

export const onboardingOutputs = {
  help: {
    usage: "help [topic] [--json] | help --agent",
    json: "{ topics, commands, exitCodes }",
  },
  doctor: {
    usage:
      "doctor [--target <path>] [--claude-auth <api-key|config-dir>] [--json]",
    json: "Array of { id, status, detail, fix, needsNetwork, needsHuman }. Exit 3 also returns the array. The next action goes to stderr.",
  },
  setup: {
    usage: "setup [--allow-network] [--yes] [--profiles] [--json]",
    json: "{ mode, artifacts, images, keychain, next } and result when applied. Output paths are relative to the bootstrap checkout.",
  },
  concierge: {
    usage:
      "concierge [--target <path>] [--claude-auth <api-key|config-dir>] [--continue] [--mode <m>] [--json]",
    json: "{ status, next } after an interactive TTY session. Transcript goes to stderr.",
  },
  credentials: {
    usage:
      "credentials <status|init|attach|detach|verify --accept [--group <name>]> [--target <path>] [--claude-auth <mode>] [--json]",
    json: "{ mounted, active, stale } for status or { status } after a completed action.",
  },
  login: {
    usage:
      "login --group <name> [--target <path>] [--claude-auth <mode>] [--json]",
    json: "{ status } after a successful interactive session. Transcript goes to stderr in JSON mode.",
  },
} as const;

export type HelpTopic = keyof typeof helpTopics;

export function renderHelpTopic(topic: HelpTopic): string {
  const { purpose, prerequisites, commands, output, next, human } =
    helpTopics[topic];
  const hardBreak = commands.length ? "  " : "\n";
  return [
    `## ${topic}`,
    "",
    purpose,
    "",
    `**Prerequisites**${hardBreak}`,
    prerequisites,
    "",
    ...(commands.length ? ["```sh", ...commands, "```", ""] : []),
    `**Expected output**${hardBreak}`,
    output,
    "",
    `**Next action**${hardBreak}`,
    next,
    "",
    `**Human involvement**${hardBreak}`,
    human,
    "",
  ].join("\n");
}

export function renderAgentGuide(): string {
  return [
    "# agent-bootstrap operator manual",
    "",
    "Run these commands on the operator host. Paste this manual into the agent's context when it will drive the workflow.",
    "",
    "Use a leading `--target <path>` for operator commands. Use `--all-targets` for analyze or denials. Put `--target <path>` after doctor, concierge, credentials, or login. Custom databases use leading `--db <file>` where supported. Put `--json` before the verification command's `--` delimiter.",
    "",
    "Replace shell variables such as `$task_id` with full IDs from status and use the same target throughout.",
    "",
    "Machine-readable errors use `{ error, next }` unless a completed doctor run reports prerequisite checks. Other next hints may appear on stderr.",
    "",
    ...Object.entries(exitCodes).map(
      ([code, label]) => `- \`${code}\` ${label}.`,
    ),
    "",
    ...Object.keys(helpTopics).map((topic) =>
      renderHelpTopic(topic as HelpTopic),
    ),
    "## Command reference",
    "",
    ...Object.values({ ...onboardingOutputs, ...operatorOutputs }).map(
      ({ usage, json }) => `- \`agent-bootstrap ${usage}\` → ${json}`,
    ),
    "",
  ].join("\n");
}
