import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  GATES,
  identifier,
  integer,
  oneOf,
  type Gate,
  type Policy,
} from "./model.ts";
import {
  MAX_TASK_RETRIES,
  OrchestratorStore,
  OrchestratorStoreError,
  parseHumanDelegate,
} from "./store.ts";
import { candidateDiffStat } from "./tasks.ts";

interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  isTTY: boolean;
  prompt(question: string): string | undefined | Promise<string | undefined>;
}

type ProposalDetails = NonNullable<
  ReturnType<OrchestratorStore["getProposalDetails"]>
>;
type ProposalStatus = ProposalDetails["status"];
const statuses = ["pending", "approved", "rejected", "registered"] as const;
const defaultRepo = fileURLToPath(new URL("../../", import.meta.url));
const maxFieldLength = 4000;
const usage = `Usage: bun run src/local-orchestrator/cli.ts [--db <path>] [--repo <root>] <command>
  reconcile
  status
  retry-task <taskId>
  show-execution <executionId>
  proposals [--status <pending|approved|rejected|registered>]
  show <proposalId>
  approve <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]
  reject <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]
  policy show
  policy set <gate> <human|agent>
  events [--subject <id>] [--limit <1-1000>]`;

type Command =
  | { kind: "status" | "policy-show" | "reconcile" }
  | { kind: "proposals"; status?: ProposalStatus }
  | { kind: "show"; id: string }
  | { kind: "show-execution" | "retry-task"; id: string }
  | {
      kind: "approve" | "reject";
      id: string;
      delegate?: ReturnType<typeof parseHumanDelegate>;
    }
  | { kind: "policy-set"; gate: Gate; value: Policy }
  | { kind: "events"; subjectId?: string; limit: number };

function parseCommand([kind, ...args]: readonly string[]): Command {
  switch (kind) {
    case "status":
    case "reconcile":
      if (args.length === 0) return { kind };
      break;
    case "proposals":
      if (args.length === 0) return { kind };
      if (args.length === 2 && args[0] === "--status")
        return { kind, status: oneOf(args[1], statuses) };
      break;
    case "show":
    case "show-execution":
    case "retry-task":
      if (args.length === 1) return { kind, id: identifier(args[0]) };
      break;
    case "approve":
    case "reject": {
      const [proposalId, ...flags] = args;
      const id = identifier(proposalId);
      if (flags.length === 0) return { kind, id };
      let onBehalf = false;
      let session: string | undefined;
      let authorization: string | undefined;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--on-behalf" && !onBehalf) onBehalf = true;
        else if (flags[i] === "--delegate-session" && session === undefined)
          session = flags[++i];
        else if (flags[i] === "--authorization" && authorization === undefined)
          authorization = flags[++i];
        else throw new ContractError();
      }
      if (!onBehalf) throw new ContractError();
      return {
        kind,
        id,
        delegate: parseHumanDelegate({
          agent: "claude-code",
          session,
          authorization,
        }),
      };
    }
    case "policy":
      if (args.length === 1 && args[0] === "show")
        return { kind: "policy-show" };
      if (args.length === 3 && args[0] === "set")
        return {
          kind: "policy-set",
          gate: oneOf(args[1], GATES),
          value: oneOf(args[2], ["human", "agent"]),
        };
      break;
    case "events": {
      let subjectId: string | undefined;
      let limit: number | undefined;
      for (let i = 0; i < args.length; i += 2) {
        const option = args[i];
        const value = args[i + 1];
        if (option === "--subject" && subjectId === undefined) {
          subjectId = identifier(value);
        } else if (
          option === "--limit" &&
          limit === undefined &&
          value !== undefined &&
          /^[0-9]+$/.test(value)
        ) {
          limit = integer(Number(value), 1, 1000);
        } else {
          throw new ContractError();
        }
      }
      return { kind, limit: limit ?? 50, ...(subjectId && { subjectId }) };
    }
  }
  throw new ContractError();
}

function escapeTerminalControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

function boundField(value: string): string {
  // Bound the displayed string even when escaping expands its contents.
  const length = (text: string) =>
    escapeTerminalControls(JSON.stringify(text)).length;
  let end = Math.min(value.length, maxFieldLength);
  if (end === value.length && length(value) <= maxFieldLength) return value;

  let start = 0;
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (length(`${value.slice(0, middle)}…`) <= maxFieldLength) start = middle;
    else end = middle - 1;
  }
  return `${value.slice(0, start)}…`;
}

function writeJson(io: CliIo, value: unknown): void {
  const json = JSON.stringify(
    value,
    (_key: string, field: unknown) =>
      typeof field === "string" ? boundField(field) : field,
    2,
  );
  // JSON escapes ASCII control characters. Escape C1 and Unicode formatting
  // characters in both keys and values, preserving JSON's own newlines.
  const output = json.split("\n").map(escapeTerminalControls).join("\n");
  io.stdout.write(`${output}\n`);
}

function projectDefaults(store: OrchestratorStore): Record<Gate, Policy> {
  return {
    "goal-registration": store.effectivePolicy("goal-registration").policy,
    "task-registration": store.effectivePolicy("task-registration").policy,
    integration: store.effectivePolicy("integration").policy,
  };
}

function proposalPolicy({
  gate,
  policy,
  source,
  loosening,
  humanApprovalRequired,
  humanAnswerRequired,
}: ProposalDetails) {
  return {
    gate,
    effectivePolicy: policy,
    policySource: source,
    loosening,
    humanApprovalRequired,
    humanAnswerRequired,
  };
}

function displayProposal({
  policy: effectivePolicy,
  source: policySource,
  ...proposal
}: ProposalDetails) {
  return { ...proposal, effectivePolicy, policySource };
}

function requireProposalDetails(store: OrchestratorStore, id: string) {
  const proposal = store.getProposalDetails(id);
  if (!proposal) throw new OrchestratorStoreError("not-found");
  return proposal;
}

function refuse(io: CliIo, message: string): 1 {
  io.stderr.write(`${message}\n`);
  return 1;
}

async function execute(
  io: CliIo,
  store: OrchestratorStore,
  command: Command,
  directory: string | undefined,
): Promise<0 | 1> {
  switch (command.kind) {
    case "retry-task": {
      const task = store.getTask(command.id);
      if (!task) return refuse(io, "Task was not found.");
      if (task.status !== "failed")
        return refuse(io, "Only failed Tasks can be retried.");
      if (task.retries >= MAX_TASK_RETRIES)
        return refuse(io, "Task retry limit reached.");
      const phrase = `retry-task ${task.id}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      writeJson(io, store.retryTask(task.id, task.retries));
      return 0;
    }
    case "show-execution": {
      const execution = store.getExecution(command.id);
      if (!execution) return refuse(io, "Execution was not found.");
      writeJson(io, execution);
      return 0;
    }
    case "reconcile": {
      const rows = store.reconciliationPreview();
      const count =
        rows.sessions.length + rows.executions.length + rows.tasks.length;
      if (count > 0) {
        writeJson(io, { pending: rows });
        const phrase = `reconcile ${count}`;
        if (
          (await io.prompt(
            `Stop the launcher first. Type "${phrase}" to confirm: `,
          )) !== phrase
        )
          return refuse(io, "Confirmation did not match. Operation cancelled.");
      }
      writeJson(io, { reconciled: count === 0 ? rows : store.reconcile(rows) });
      return 0;
    }
    case "status": {
      const proposals = store.listProposals();
      const goals = store.listGoals();
      const pending = proposals
        .filter(({ status }) => status === "pending")
        .map((proposal) => ({
          id: proposal.id,
          kind: proposal.kind,
          ...(proposal.kind === "integration"
            ? {
                goalId: proposal.content.goalId,
                taskId: proposal.content.taskId,
              }
            : { title: proposal.content.title }),
          ...proposalPolicy(requireProposalDetails(store, proposal.id)),
        }));
      writeJson(io, {
        counts: {
          goals: goals.length,
          tasks: goals.reduce(
            (count, goal) => count + store.listTasks(goal.id).length,
            0,
          ),
          proposals: proposals.length,
          pending: pending.length,
        },
        pending,
      });
      return 0;
    }
    case "proposals": {
      const proposals = store.listProposals(
        command.status === undefined ? {} : { status: command.status },
      );
      writeJson(
        io,
        proposals.map(({ id }) =>
          displayProposal(requireProposalDetails(store, id)),
        ),
      );
      return 0;
    }
    case "show":
    case "approve":
    case "reject": {
      const proposal = store.getProposalDetails(command.id, {
        includeDelegation: command.kind === "show",
      });
      if (!proposal) return refuse(io, "Proposal was not found.");
      let diffStat: string | undefined;
      if (proposal.kind === "integration") {
        if (directory === undefined)
          return refuse(
            io,
            "Integration proposals with --db also require --repo <root>.",
          );
        diffStat = await candidateDiffStat(directory, proposal.content);
      }
      writeJson(io, {
        ...displayProposal(proposal),
        ...(diffStat === undefined ? {} : { diffStat }),
      });
      if (command.kind === "show") return 0;
      if (proposal.status !== "pending")
        return refuse(io, "Proposal is no longer pending.");
      const { digest } = proposal;
      if (!/^[a-f0-9]{64}$/.test(digest))
        return refuse(io, "Proposal digest is invalid.");

      const phrase = `${command.kind} ${digest.slice(0, 12)}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      writeJson(
        io,
        store.decide(proposal.id, {
          digest,
          decision: command.kind,
          answerer: {
            kind: "human",
            ...(command.delegate && { delegate: command.delegate }),
          },
        }),
      );
      if (command.delegate) io.stdout.write("Answer recorded as delegated.\n");
      return 0;
    }
    case "policy-show":
      writeJson(io, projectDefaults(store));
      return 0;
    case "policy-set":
      store.setProjectDefaults(
        { [command.gate]: command.value },
        { kind: "operator" },
      );
      io.stdout.write("Project default updated.\n");
      return 0;
    case "events": {
      const { kind: _kind, ...options } = command;
      writeJson(io, store.listEvents(options));
      return 0;
    }
  }
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<0 | 1 | 2> {
  let db: string | undefined;
  let repo: string | undefined;
  let command: Command;
  try {
    let i = 0;
    while (argv[i] === "--db" || argv[i] === "--repo") {
      const flag = argv[i++];
      const value = argv[i++];
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new ContractError();
      if (flag === "--db" && db === undefined) db = value;
      else if (flag === "--repo" && repo === undefined) repo = value;
      else throw new ContractError();
    }
    command = parseCommand(argv.slice(i));
  } catch {
    io.stderr.write(`${usage}\n`);
    return 2;
  }

  if (
    ["approve", "reject", "policy-set", "reconcile", "retry-task"].includes(
      command.kind,
    ) &&
    !io.isTTY
  )
    return refuse(io, "This command requires a terminal on stdin and stdout.");

  try {
    if (command.kind === "policy-set") {
      if (command.value === "agent")
        io.stdout.write(
          "Warning: setting this gate to agent allows eligible agent answers.\n",
        );
      const phrase = `set ${command.gate} ${command.value}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
    }
    const directory = join(
      resolve(repo ?? defaultRepo),
      ".local",
      "local-orchestrator",
    );
    if (db === undefined)
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const store = OrchestratorStore.open(db ?? join(directory, "state.db"));
    try {
      return await execute(
        io,
        store,
        command,
        db !== undefined && repo === undefined ? undefined : directory,
      );
    } finally {
      store.close();
    }
  } catch (error) {
    if (
      error instanceof OrchestratorStoreError &&
      error.code === "stale-digest"
    )
      return refuse(io, "Proposal content changed. Review the proposal again.");
    if (
      error instanceof OrchestratorStoreError &&
      error.code === "reconcile-changed"
    )
      return refuse(
        io,
        "The reconciliation list changed. Run reconcile again.",
      );
    if (
      command.kind === "retry-task" &&
      error instanceof OrchestratorStoreError &&
      ["invalid-transition", "task-retry-changed"].includes(error.code)
    )
      return refuse(
        io,
        "Task changed. Run retry-task again to check its status.",
      );
    return refuse(io, "Local orchestrator command failed.");
  }
}

async function promptOnTerminal(question: string): Promise<string | undefined> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise((resolve) => {
      terminal.once("close", () => resolve(undefined));
      terminal.question(question, resolve);
    });
  } finally {
    terminal.close();
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: promptOnTerminal,
  });
}
