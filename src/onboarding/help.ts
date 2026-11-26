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
      "An agent-bootstrap checkout, macOS arm64, Bun 1.4.5, and a local SHA-1 Git target with local main.",
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
      "Use doctor to prepare Bun, mise, Microsandbox 0.7.16, checkout dependencies, and a Microsandbox home with an absolute real path of at most 40 bytes. The default is $HOME/.msb. Override it with microsandbox.home in the user config or with MSB_HOME, which takes precedence.",
    commands: [
      'mkdir -p "$HOME/.msb"',
      "mise --no-config --no-env --no-hooks install microsandbox@0.7.16",
      "agent-bootstrap setup --json",
      "agent-bootstrap setup --allow-network",
      "agent-bootstrap setup --allow-network --profiles",
      ...configureClaude,
      provisionKeychain,
    ],
    output:
      "Default setup prints pinned URLs, hashes and image references. Applying setup downloads missing inputs and builds missing images sequentially. Additional secret-file packages are included when the effective configuration grants a secret. Use --target to select a registered project's configuration. Build VMs use an audited gateway limited to recipe destinations. The browser build uses a pinned Debian base and signed, hash-pinned snapshot metadata. Setup lists the build audit database and allowlist for each profile. A digest mismatch stops setup before the image is published under its locked reference.",
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
  workplace: {
    purpose:
      "Start the Concierge and the target's operator API for a separate client.",
    prerequisites:
      "A registered target and passing Concierge launch prerequisites.",
    commands: [
      `${target} workplace`,
      `agent-bootstrap workplace --target ${exampleTarget} --dev-bridge`,
    ],
    output:
      "The launcher prints the session ID and audit database path. With --dev-bridge it also prints a private loopback URL.",
    next: "Open the printed URL when using the development bridge. Answer eligible gates in the host panel or use the operator CLI. Use 任せ方 to manage delegation.",
    human:
      "Keep the URL private. Stop the workplace process to end the session.",
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
  inbox: {
    purpose: "Inspect operator actions and recent progress from local state.",
    prerequisites: "A registered target.",
    commands: [
      `${target} inbox`,
      `${target} inbox --all --json`,
      `${target} watch`,
    ],
    output:
      "Inbox prints current items with their state and next command. Add --all to include resolved items. Watch prints new and changed items every two seconds. Press Ctrl-C to exit.",
    next: "Use the command shown with each item to inspect it or take action.",
    human: humanGate,
  },
  watch: {
    purpose: "Follow new and changed inbox items in a terminal or a script.",
    prerequisites: "A registered target.",
    commands: [`${target} watch`],
    output: "One line per new or changed item. Press Ctrl-C to exit.",
    next: "Use inbox --all to review recent resolved items.",
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
      "A registered SHA-1 Git worktree root with local main and a locked, installed verification profile.",
    commands: [
      `agent-bootstrap project add ${exampleTarget}`,
      `agent-bootstrap doctor --target ${exampleTarget}`,
      `${target} verification set --profile bun -- bun test`,
      `${target} verification show --json`,
      `${target} verification clear`,
      `${target} update-goal-base "$goal_id"`,
    ],
    output:
      "Verification show returns the effective command or null. Set and clear edit the local layer after confirmation. Base updates require an eligible, untouched Goal and preview both commits.",
    next: "Launch with the same target. Keep verification configured until its integration proposals are resolved.",
    human: `The operator confirms verification changes and eligible base updates from a host TTY. ${humanRepo}`,
  },
  configuration: {
    purpose:
      "Register projects, review repository requests, and edit operator settings.",
    prerequisites:
      "A Git worktree root and an operator terminal for project approval.",
    commands: [
      `agent-bootstrap project add ${exampleTarget} --name dagq-lite`,
      "agent-bootstrap project list",
      "agent-bootstrap project show dagq-lite",
      "agent-bootstrap project approve dagq-lite",
      "agent-bootstrap config edit --project dagq-lite",
      `agent-bootstrap doctor --target ${exampleTarget}`,
      `agent-bootstrap project move dagq-lite ${exampleTarget}`,
      "agent-bootstrap project remove dagq-lite",
      "agent-bootstrap migrate",
    ],
    output:
      "Doctor shows effective configuration keys and their layer sources and reports declaration drift. Local settings take precedence for single values, followed by approved and user settings. Lists of grants are combined. Concierge chooses its Claude model from LO_CLAUDE_MODEL, then the effective claude.model setting, then the launcher default. Removal preserves state.",
    next: "Use config edit for user settings. For legacy external targets, pass the original worktree paths to migrate.",
    human:
      "Review the declaration at local main and the approval summary, then type the project name to accept the declaration.",
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
      "agent-bootstrap sandbox shell --json",
      "agent-bootstrap sandbox shell --profile base --run",
    ],
    output:
      "Reconcile previews unfinished records before confirmation. Retry registers a failed Task with a new attempt. For path-violation, inspect the rejected paths with show or show-execution. For unsafe-input-symlink, use relative links inside the repository and retry with the corrected commit. For secret-test-required, run the self-test command printed by doctor or the launcher. Launcher codes identify configuration, volume, runtime home or version, audit store, Git integration, state store, and gateway startup failures. Follow the displayed next action and keep the audit database for diagnosis.",
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
      "agent-bootstrap sandbox shell --allow example.com:443 --json",
    ],
    output:
      "Policy reports gate defaults, ordered rules, and Goal and Task overrides. Proposals carry the effective policy and human-answer requirement. Product VMs are offline or use the audited gateway. The operator sandbox shell uses only explicitly allowed DNS names on ports 80 and 443. It runs for up to five minutes and has no provider credentials or actor configuration.",
    next: "Review the proposed paths, verification result, digest, and policy before answering each gate.",
    human: `${humanRepo} ${humanGate} Keep API keys in Keychain. Review mount and egress grants separately.`,
  },
  volume: {
    purpose:
      "Manage encrypted volumes and open an audited operator shell for a declared mount.",
    prerequisites:
      "Define volumes in the user config. The shell requires an operator terminal.",
    commands: [
      "agent-bootstrap volume init <name>",
      "agent-bootstrap volume status <name>",
      "agent-bootstrap volume shell <mount> [--target <path>]",
    ],
    output:
      "Status reports attachment, active leases and stale state. The shell takes an exclusive lease and mounts the directory read-write.",
    next: "For stale state, run doctor. Confirm no VM is running before using volume detach <name> --force.",
    human:
      "Declare read-write mounts in a project's local.json for one actor and a dedicated directory.",
  },
  secrets: {
    purpose: "Check VM containment for a variable granted through secretEnv.",
    prerequisites:
      "Define the Keychain source under secrets in the user config. Grant the variable through secretEnv and select external authentication. Prepare the pinned guest image and CLI.",
    commands: [
      'agent-bootstrap secrets test "$variable"',
      `agent-bootstrap secrets test "$variable" --target ${exampleTarget} --json`,
    ],
    output:
      "The self-test runs a disposable Worker and reports check results and counts. A pass applies to the granted variable, pinned CLI version and current containment configuration.",
    next: "Set $variable to the granted variable name. Use --target for a project-local grant. Repeat the test when doctor reports that a current pass is required.",
    human:
      "Provision the configured Keychain entry and authorize model API access before running the test.",
  },
} satisfies Record<string, Topic>;

export const operatorOutputs = {
  status: {
    usage: "status",
    json: "{ counts, pending, recentExecutions, recentTasks }",
    next: "Inspect pending proposals with show <proposalId>.",
  },
  inbox: {
    usage: "inbox [--all] [--json]",
    json: "Array of inbox items with subject IDs, state and the next command.",
    next: "Use watch to follow new and changed items.",
  },
  watch: {
    usage: "watch",
    json: "Streams human-readable inbox lines until Ctrl-C.",
    next: "Use inbox to inspect the current items.",
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
    usage:
      "policy show | policy set <gate> <human|agent> | policy rules set --file <json> | policy goal <goalId> <task-registration|integration> <inherit|human|agent> | policy task <taskId> <rule|human|agent>",
    json: "Gate defaults, ordered rules with recent hits, and Goal and Task overrides for show.",
    next: "Check the effective answerer and its source on individual proposals.",
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
  "discard-goal": {
    usage: "discard-goal <goalId>",
    json: "{ goalId, branch, head } preview, followed by the cancelled Goal record on confirmation.",
    next: "Use events --subject <goalId> to inspect the cancellation.",
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
      "doctor [--target <path>] [--claude-auth <api-key|external>] [--json]",
    json: "Array of checks with layer sources, actor harnesses, and Sign in with ChatGPT grant presence. Exit 3 also returns the array. The next action goes to stderr.",
  },
  codex: {
    usage: "codex authorize | codex forget [--json]",
    json: "Grant management on the macOS host. Authorize requires a TTY and browser consent. JSON success is { status }.",
  },
  setup: {
    usage:
      "setup [--target <path>] [--allow-network] [--yes] [--profiles] [--json]",
    json: "{ mode, artifacts, images, keychain, next } and result when applied. Output paths are relative to the bootstrap checkout.",
  },
  concierge: {
    usage:
      "concierge [--target <path>] [--claude-auth <api-key|external>] [--continue] [--mode <m>] [--json]",
    json: "{ status, next } after an interactive TTY session. Transcript goes to stderr.",
  },
  workplace: {
    usage:
      "workplace --target <path> [--claude-auth <api-key|external>] [--continue] [--mode <m>] [--dev-bridge]",
    json: "Text output with the optional loopback URL.",
  },
  sandbox: {
    usage:
      "sandbox shell [--profile <name>] [--allow <host:port>]... [--mount-dir <host>:<guest>[:ro]]... [--json | --run]",
    json: "A plan with the pinned image, egress allowlist, requested mounts, lifetime and audit path. Use --run from an operator TTY to start the VM.",
  },
  project: {
    usage:
      "project add <path> [--name <name>] | project list | project show <name> | project move <name> <path> | project remove <name> | project approve <name>",
    json: "Project record, list of records, or a confirmation object.",
  },
  config: {
    usage: "config edit [--project <name>]",
    json: "{ edited: true } after the editor exits and file validation succeeds.",
  },
  migrate: {
    usage: "migrate [<original-target-path>...]",
    json: "{ projects, orphanedVolumes, volumeMigration? } with project names, legacy Concierge volume names and any mount migration guidance.",
  },
  volume: {
    usage:
      "volume <init|attach|detach|status> <name> [--force for detach] | volume shell <mount> [--target <path>]",
    json: "{ mounted, active, stale } for status or { status } after a completed action.",
  },
  secrets: {
    usage: "secrets test <variable> [--target <path>] [--json]",
    json: "{ pass, checks, counts }. Exit 1 can also return the failed check report.",
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
    "Use a leading `--target <path>` for operator commands. Use `--all-targets` for analyze or denials. Put `--target <path>` after doctor, setup, concierge, volume shell, or secrets test. Custom databases use leading `--db <file>` where supported. Put `--json` before the verification command's `--` delimiter.",
    "",
    "Replace shell variables such as `$task_id` with full IDs from status and use the same target throughout.",
    "",
    "Machine-readable errors use `{ error, next }`. Sign in with ChatGPT errors include `code` and actor configuration errors include `code` and `key`. Completed doctor and secrets test runs report check results. Other next hints may appear on stderr.",
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
