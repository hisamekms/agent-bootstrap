import { isCodexFailureCode } from "../codex-exec.ts";
import {
  GOAL_POLICIES,
  RULE_GATES,
  TASK_POLICIES,
  validateDelegationRules,
  type GoalPolicy,
  type RuleGate,
  type TaskPolicy,
} from "./delegation.ts";
import { loadConfig, mergeConfig } from "../config/layers.ts";
import { ConfigError } from "../config/messages.ts";
import {
  configuredCredentialScanner,
  recordedCredentialScanner,
  type CredentialScanner,
} from "./credential-scan.ts";
import { readPathViolations, type PathViolation } from "./path-violations.ts";
import { ClaudeRunError } from "./claude-errors.ts";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { PROFILE_LOCK_PATH, parseProfileLock } from "../profile-lock.ts";
import { ALPINE_3_23 } from "../image-recipes.ts";
import { userStateDirectory } from "../config/layers.ts";
import { secretTestFacts } from "./secret-test-record.ts";
import { operatorStatus, operatorTask } from "./operator-read.ts";
import {
  changedInboxIds,
  formatInboxItem,
  inboxSnapshot,
  projectInbox,
} from "./inbox.ts";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { GitIntegrationError } from "../git-integration.ts";
import {
  analyze,
  escapeTerminalControls,
  type AnalysisCommand,
} from "./analysis.ts";
import {
  ContractError,
  contentDigest,
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
import {
  previewGoalBaseUpdate,
  previewGoalDiscard,
  previewGoalBranchExport,
  reconciliationIntegrationHeads,
} from "./tasks.ts";
import { displayProposal, proposalDecisionPreview } from "./proposal-answer.ts";

import {
  prepareTargetDirectory,
  resolveTarget,
  bootstrapCheckout,
  rejectLegacyState,
} from "./target.ts";
import {
  parseVerificationConfig,
  readVerificationConfig,
  writeVerificationConfig,
  type VerificationConfig,
} from "./verification.ts";

export interface CliIo {
  json?(serialized: string): void;
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
const maxFieldLength = 4000;
const usage = `Usage: bun run src/local-orchestrator/cli.ts [--db <path>] [--target <path>] <command>
  bun run src/local-orchestrator/cli.ts [--target <path> | --all-targets] analyze [--audit <file>] [--out <dir>] [--sql <file>]
  bun run src/local-orchestrator/cli.ts [--target <path> | --all-targets] denials [--since <iso>] [--limit <1-1000>]
  reconcile
  status
  inbox [--all] [--json]
  watch
  retry-task <taskId>
  update-goal-base <goalId>
  discard-goal <goalId>
  export-goal-branch <goalId> [--target <checkout>]
  show-execution <executionId>
  proposals [--status <pending|approved|rejected|registered>]
  show <proposalId|goalId|taskId>
  approve <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]
  reject <proposalId> [--on-behalf --delegate-session <id> --authorization <text>]
  verification show
  verification set --profile <name> -- <argv...>
  verification clear
  policy show
  policy set <gate> <human|agent>
  policy rules set --file <json>
  policy goal <goalId> <task-registration|integration> <inherit|human|agent>
  policy task <taskId> <rule|human|agent>
  events [--subject <id>] [--limit <1-1000>]`;

type Command =
  | { kind: "status" | "policy-show" | "reconcile" | "watch" }
  | { kind: "inbox"; all: boolean; json: boolean }
  | AnalysisCommand
  | { kind: "proposals"; status?: ProposalStatus }
  | { kind: "show"; id: string }
  | {
      kind:
        "show-execution" | "retry-task" | "update-goal-base" | "discard-goal";
      id: string;
    }
  | { kind: "export-goal-branch"; id: string; checkout?: string }
  | {
      kind: "approve" | "reject";
      id: string;
      delegate?: ReturnType<typeof parseHumanDelegate>;
    }
  | { kind: "verification-show" | "verification-clear" }
  | { kind: "verification-set"; config: VerificationConfig }
  | { kind: "policy-set"; gate: Gate; value: Policy }
  | { kind: "policy-rules"; file: string }
  | { kind: "policy-goal"; id: string; gate: RuleGate; value: GoalPolicy }
  | { kind: "policy-task"; id: string; value: TaskPolicy }
  | { kind: "events"; subjectId?: string; limit: number };

function parseCommand([kind, ...args]: readonly string[]): Command {
  switch (kind) {
    case "analyze": {
      const command: Extract<AnalysisCommand, { kind: "analyze" }> = { kind };
      for (let i = 0; i < args.length; i += 2) {
        const flag = args[i];
        const value = args[i + 1];
        if (!value || value.startsWith("--") || value.includes("\0"))
          throw new ContractError();
        if (flag === "--out" && command.out === undefined) command.out = value;
        else if (flag === "--sql" && command.sql === undefined)
          command.sql = value;
        else if (flag === "--audit" && command.audit === undefined)
          command.audit = value;
        else throw new ContractError();
      }
      return command;
    }
    case "denials": {
      const command: Extract<AnalysisCommand, { kind: "denials" }> = { kind };
      for (let i = 0; i < args.length; i += 2) {
        const flag = args[i];
        const value = args[i + 1];
        if (
          flag === "--since" &&
          command.since === undefined &&
          value !== undefined &&
          /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
            value,
          )
        ) {
          const date = new Date(value);
          const day = value.slice(0, 10);
          const midnight = new Date(day);
          if (
            !Number.isFinite(date.getTime()) ||
            !Number.isFinite(midnight.getTime()) ||
            !midnight.toISOString().startsWith(day)
          )
            throw new ContractError();
          command.since =
            value.length === 10
              ? `${value}T00:00:00Z`
              : value.replace(/(T\d{2}:\d{2})(?=Z|[+-])/, "$1:00");
        } else if (
          flag === "--limit" &&
          command.limit === undefined &&
          value !== undefined &&
          /^[0-9]+$/.test(value)
        ) {
          command.limit = integer(Number(value), 1, 1000);
        } else throw new ContractError();
      }
      return command;
    }
    case "inbox":
      if (
        new Set(args).size === args.length &&
        args.every((flag) => flag === "--all" || flag === "--json")
      )
        return {
          kind,
          all: args.includes("--all"),
          json: args.includes("--json"),
        };
      break;
    case "watch":
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
    case "update-goal-base":
    case "discard-goal":
      if (args.length === 1) return { kind, id: identifier(args[0]) };
      break;
    case "export-goal-branch": {
      const id = identifier(args[0]);
      if (args.length === 1) return { kind, id };
      const checkout = args[2];
      if (
        args.length === 3 &&
        isTargetFlag(args[1]) &&
        checkout &&
        !checkout.startsWith("--") &&
        !checkout.includes("\0")
      )
        return { kind, id, checkout };
      break;
    }
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
    case "verification":
      if (args.length === 1 && args[0] === "show")
        return { kind: "verification-show" };
      if (args.length === 1 && args[0] === "clear")
        return { kind: "verification-clear" };
      if (args[0] === "set" && args[1] === "--profile" && args[3] === "--")
        return {
          kind: "verification-set",
          config: parseVerificationConfig({
            profile: args[2],
            argv: args.slice(4),
          }),
        };
      break;
    case "policy":
      if (args.length === 1 && args[0] === "show")
        return { kind: "policy-show" };
      if (
        args.length === 4 &&
        args[0] === "rules" &&
        args[1] === "set" &&
        args[2] === "--file" &&
        args[3]
      )
        return { kind: "policy-rules", file: args[3] };
      if (args.length === 4 && args[0] === "goal")
        return {
          kind: "policy-goal",
          id: identifier(args[1]),
          gate: oneOf(args[2], RULE_GATES),
          value: oneOf(args[3], GOAL_POLICIES),
        };
      if (args.length === 3 && args[0] === "task")
        return {
          kind: "policy-task",
          id: identifier(args[1]),
          value: oneOf(args[2], TASK_POLICIES),
        };
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
  if (io.json) io.json(output);
  else io.stdout.write(`${output}\n`);
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
  command: Exclude<Command, AnalysisCommand>,
  directory: string | undefined,
  repoRoot: string,
  scan?: CredentialScanner,
  configDirectory?: string,
  env = process.env,
  bootstrapRoot = bootstrapCheckout,
): Promise<0 | 1> {
  const writeCheckedJson = async (value: unknown) => {
    await scan?.(JSON.stringify(value));
    writeJson(io, value);
  };
  const writePathSummary = (paths: readonly PathViolation[] | undefined) => {
    if (io.json || !paths) return;
    const [first] = paths;
    if (first)
      io.stdout.write(
        `Rejected path ${first.path}${first.symlink ? " (symlink)" : ""}${paths.length > 1 ? ` and ${paths.length - 1} more listed` : ""}\n`,
      );
  };
  switch (command.kind) {
    case "verification-show":
      await writeCheckedJson(readVerificationConfig(configDirectory!, env));
      return 0;
    case "verification-clear":
    case "verification-set": {
      const config =
        command.kind === "verification-set" ? command.config : null;
      const preview = () => {
        const layers = loadConfig(env, configDirectory);
        const { verification: localVerification, ...local } = layers.local;
        return {
          current: layers.config.verification ?? null,
          local: localVerification ?? null,
          verification:
            config ??
            mergeConfig(
              layers.user,
              layers.approved?.config,
              local,
              env,
              configDirectory,
            ).config.verification ??
            null,
        };
      };
      const previous = preview();
      const digest = config === null ? null : contentDigest(config);
      await writeCheckedJson({
        target: repoRoot,
        current: previous.current,
        verification: previous.verification,
      });
      const phrase =
        config === null
          ? "verification clear"
          : `verification set ${contentDigest(config).slice(0, 12)}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      const previousDigest = contentDigest(previous);
      const applied = store.changeVerification(digest, () => {
        if (contentDigest(preview()) !== previousDigest) return false;
        writeVerificationConfig(configDirectory!, config, env);
        return true;
      });
      if (!applied)
        return refuse(
          io,
          "Verification changed. Review the current configuration.",
        );
      return 0;
    }
    case "update-goal-base": {
      if (directory === undefined)
        return refuse(
          io,
          "update-goal-base with --db requires --target <path>.",
        );
      const { from, to, apply } = await previewGoalBaseUpdate(
        store,
        repoRoot,
        directory,
        command.id,
      );
      await writeCheckedJson({ goalId: command.id, from, to });
      const phrase = `update-goal-base ${command.id} ${to.slice(0, 12)}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      await apply();
      await writeCheckedJson(store.getGoal(command.id));
      return 0;
    }
    case "discard-goal": {
      if (directory === undefined)
        return refuse(io, "discard-goal with --db requires --target <path>.");
      const { branch, head, apply } = await previewGoalDiscard(
        store,
        directory,
        command.id,
      );
      await writeCheckedJson({ goalId: command.id, branch, head });
      const phrase = `discard-goal ${command.id} ${head?.slice(0, 12) ?? "none"}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      await apply();
      await writeCheckedJson(store.getGoal(command.id));
      return 0;
    }
    case "export-goal-branch": {
      const checkout = resolve(command.checkout ?? repoRoot);
      const { from, to, branch, apply } = await previewGoalBranchExport(
        store,
        checkout,
        directory!,
        command.id,
        scan,
      );
      await writeCheckedJson({
        goalId: command.id,
        checkout,
        branch,
        from,
        to,
      });
      const phrase = `export-goal-branch ${command.id} ${to.slice(0, 12)}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      await apply();
      io.stdout.write(
        `Review ${branch} in the operator checkout. When ready, push ${branch} and open a pull request to main.\n`,
      );
      return 0;
    }
    case "retry-task": {
      const task = store.getTask(command.id);
      if (!task) return refuse(io, "Task was not found.");
      if (task.status !== "failed")
        return refuse(io, "Only failed Tasks can be retried.");
      if (task.retries >= MAX_TASK_RETRIES)
        return refuse(io, "Task retry limit reached.");
      const phrase = `retry-task ${command.id === task.id ? task.id : task.ref}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      await writeCheckedJson(store.retryTask(task.id, task.retries));
      return 0;
    }
    case "show-execution": {
      const execution = store.getExecution(command.id);
      if (!execution) return refuse(io, "Execution was not found.");
      await writeCheckedJson(execution);
      const result = execution.result as {
        code?: string;
        rejectedPaths?: unknown;
        next?: unknown;
      } | null;
      if (result?.code === "path-violation")
        writePathSummary(readPathViolations(result.rejectedPaths));
      if (
        !io.json &&
        (result?.code === "secret-test-required" ||
          result?.code === "env-missing" ||
          isCodexFailureCode(result?.code)) &&
        typeof result.next === "string"
      )
        io.stdout.write(
          `next: ${escapeTerminalControls(boundField(result.next))}\n`,
        );
      return 0;
    }
    case "reconcile": {
      const rows = store.reconciliationPreview();
      const count =
        rows.sessions.length + rows.executions.length + rows.tasks.length;
      if (count > 0) {
        await writeCheckedJson({ pending: rows });
        const phrase = `reconcile ${count}`;
        if (
          (await io.prompt(
            `Stop the launcher first. Type "${phrase}" to confirm: `,
          )) !== phrase
        )
          return refuse(io, "Confirmation did not match. Operation cancelled.");
      }
      const reconciled =
        count === 0
          ? rows
          : store.reconcile(
              rows,
              await reconciliationIntegrationHeads(
                store,
                directory,
                rows.tasks,
              ),
            );
      await writeCheckedJson({ reconciled });
      return 0;
    }
    case "inbox":
    case "watch": {
      const read = () =>
        projectInbox(
          {
            store,
            target: repoRoot,
            secretTests: () => {
              if (!directory) return [];
              const { config } = loadConfig(env, configDirectory);
              if (!Object.keys(config.secretEnv ?? {}).length) return [];
              const lock = parseProfileLock(
                readFileSync(join(bootstrapRoot, PROFILE_LOCK_PATH), "utf8"),
              );
              return secretTestFacts(
                config.secretEnv,
                userStateDirectory(env),
                lock.base ?? ALPINE_3_23.reference,
              );
            },
          },
          {
            includeResolved:
              command.kind === "watch" ||
              (command.kind === "inbox" && command.all),
          },
        );
      if (command.kind === "inbox") {
        const items = read();
        if (command.json || io.json) {
          const output = JSON.stringify(items, null, 2);
          await scan?.(output);
          if (io.json) io.json(output);
          else io.stdout.write(output + "\n");
        } else {
          const output = items.map(formatInboxItem).join("");
          await scan?.(output);
          if (output) io.stdout.write(output);
        }
        return 0;
      }

      const stop = new AbortController();
      const interrupt = () => stop.abort();
      process.on("SIGINT", interrupt);
      try {
        let previous = new Map<string, string>();
        while (!stop.signal.aborted) {
          const items = read();
          const current = inboxSnapshot(items);
          const changed = new Set(changedInboxIds(previous, current));
          const output = items
            .filter(
              (item) =>
                changed.has(item.id) &&
                (item.state !== "resolved" || previous.has(item.id)),
            )
            .map(formatInboxItem)
            .join("");
          if (output) {
            await scan?.(output);
            io.stdout.write(output);
          }
          previous = current;
          await delay(2000, undefined, { signal: stop.signal });
        }
      } catch (error) {
        if (!stop.signal.aborted) throw error;
      } finally {
        process.off("SIGINT", interrupt);
      }
      return 0;
    }
    case "status": {
      await writeCheckedJson(operatorStatus(store));
      return 0;
    }
    case "proposals": {
      const proposals = store.listProposals(
        command.status === undefined ? {} : { status: command.status },
      );
      await writeCheckedJson(
        proposals.map(({ id }) =>
          displayProposal(requireProposalDetails(store, id)),
        ),
      );
      return 0;
    }
    case "show":
    case "approve":
    case "reject": {
      if (command.kind === "show") {
        const goal = store.getGoal(command.id);
        if (goal) {
          await writeCheckedJson(goal);
          return 0;
        }
        const task = store.getTask(command.id);
        if (task) {
          const usage = store.taskUsage(task.id);
          const failure =
            task.status === "failed"
              ? operatorTask(store, task.id)?.failure
              : undefined;
          const rejectedPaths =
            task.status === "failed"
              ? store.taskPathViolations(task.id)
              : undefined;
          await writeCheckedJson({
            ...task,
            ...usage,
            budgetTokens: usage.tokens,
            totalTokens: store.taskTokens(task.id),
            ...(rejectedPaths && { rejectedPaths }),
            ...(failure?.code === "env-missing" && {
              code: failure.code,
              next: failure.next,
            }),
          });
          writePathSummary(rejectedPaths);
          return 0;
        }
      }
      const proposal = store.getProposalDetails(command.id, {
        includeDelegation: command.kind === "show",
      });
      if (!proposal) return refuse(io, "Proposal was not found.");
      if (proposal.kind === "integration" && directory === undefined)
        return refuse(
          io,
          "Integration proposals with --db also require --target <path>.",
        );
      await writeCheckedJson({
        ...(await proposalDecisionPreview(
          directory,
          proposal,
          command.kind,
          scan,
        )),
        ...(command.kind === "show" &&
        proposal.kind === "goal" &&
        proposal.status === "approved"
          ? {
              baseCommit:
                store
                  .listGoals()
                  .find((goal) => goal.proposalId === proposal.id)
                  ?.baseCommit ?? null,
            }
          : {}),
      });
      if (command.kind === "show") return 0;
      if (proposal.status !== "pending")
        return refuse(io, "Proposal is no longer pending.");
      await scan?.(JSON.stringify(command));
      const { digest } = proposal;
      if (!/^[a-f0-9]{64}$/.test(digest))
        return refuse(io, "Proposal digest is invalid.");

      const phrase = `${command.kind} ${digest.slice(0, 12)}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      await writeCheckedJson(
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
    case "policy-show": {
      const { defaults, rules } = store.policySettings();
      await writeCheckedJson({
        ...defaults,
        rules,
        overrides: store.policyOverrides(),
      });
      return 0;
    }
    case "policy-rules": {
      const rules = validateDelegationRules(
        JSON.parse(readFileSync(command.file, "utf8")),
      );
      await scan?.(JSON.stringify(rules));
      if (
        (await io.prompt(
          'Type "set rules" to replace the delegation rule list: ',
        )) !== "set rules"
      )
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      store.setRules(rules, "cli");
      io.stdout.write("Delegation rules updated.\n");
      return 0;
    }
    case "policy-goal":
    case "policy-task": {
      if (
        command.value !== "human" &&
        (await io.prompt(
          'Type "set policy" to confirm this setting can allow eligible AI answers: ',
        )) !== "set policy"
      )
        return refuse(io, "Confirmation did not match. Operation cancelled.");
      if (command.kind === "policy-goal")
        store.setGoalPolicy(command.id, command.gate, command.value, "cli");
      else store.setTaskIntegrationPolicy(command.id, command.value, "cli");
      io.stdout.write("Delegation override updated.\n");
      return 0;
    }
    case "policy-set":
      store.setProjectDefaults(
        { [command.gate]: command.value },
        { kind: "operator" },
      );
      io.stdout.write("Project default updated.\n");
      return 0;
    case "events": {
      const { kind: _kind, ...options } = command;
      await writeCheckedJson(store.listEvents(options));
      return 0;
    }
  }
}

function isTargetFlag(flag: string | undefined): boolean {
  return flag === "--target" || flag === "--repo";
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  bootstrapRoot = bootstrapCheckout,
  env = process.env,
): Promise<0 | 1 | 2> {
  let db: string | undefined;
  let targetPath: string | undefined;
  let allTargets = false;
  let command: Command;
  try {
    let i = 0;
    while (
      argv[i] === "--db" ||
      argv[i] === "--all-targets" ||
      isTargetFlag(argv[i])
    ) {
      const flag = argv[i++];
      if (flag === "--all-targets" && !allTargets) {
        allTargets = true;
        continue;
      }
      const value = argv[i++];
      if (!value || value.startsWith("--") || value.includes("\0"))
        throw new ContractError();
      if (flag === "--db" && db === undefined) db = value;
      else if (isTargetFlag(flag) && targetPath === undefined)
        targetPath = value;
      else throw new ContractError();
    }
    command = parseCommand(argv.slice(i));
    const analysis = command.kind === "analyze" || command.kind === "denials";
    if (
      (allTargets && (targetPath !== undefined || !analysis)) ||
      (db !== undefined && analysis) ||
      (allTargets && command.kind === "analyze" && command.audit !== undefined)
    )
      throw new ContractError();
  } catch {
    io.stderr.write(`${usage}\n`);
    return 2;
  }

  if (
    [
      "approve",
      "reject",
      "policy-set",
      "policy-rules",
      "policy-goal",
      "policy-task",
      "reconcile",
      "retry-task",
      "update-goal-base",
      "discard-goal",
      "export-goal-branch",
      "verification-set",
      "verification-clear",
    ].includes(command.kind) &&
    !io.isTTY
  )
    return refuse(io, "This command requires a terminal on stdin and stdout.");

  if (
    command.kind === "export-goal-branch" &&
    db !== undefined &&
    targetPath === undefined
  )
    return refuse(
      io,
      "With a custom --db, pass --target for the launcher target before the command.",
    );

  if (db !== undefined && command.kind.startsWith("verification-"))
    return refuse(io, "Verification commands use the target's state database.");

  try {
    const custom = db !== undefined && targetPath === undefined;
    if (custom) await rejectLegacyState(bootstrapRoot);
    const target = custom
      ? undefined
      : await resolveTarget(targetPath, bootstrapRoot, env);
    if (command.kind === "analyze" || command.kind === "denials")
      return await analyze(target!, allTargets, command, io);
    const repoRoot = target?.repoRoot ?? bootstrapRoot;
    const directory = target?.directory;
    if (command.kind === "policy-set") {
      if (command.value === "agent")
        io.stdout.write(
          "Warning: setting this gate to agent allows eligible agent answers.\n",
        );
      const phrase = `set ${command.gate} ${command.value}`;
      if ((await io.prompt(`Type "${phrase}" to confirm: `)) !== phrase)
        return refuse(io, "Confirmation did not match. Operation cancelled.");
    }
    if (db === undefined)
      await prepareTargetDirectory(bootstrapRoot, directory, env);
    const store = OrchestratorStore.open(db ?? join(directory!, "state.db"));
    try {
      const note = (message: string) => io.stderr.write(message + "\n");
      const targetScan = configuredCredentialScanner(
        directory,
        note,
        env,
        undefined,
        target?.configDirectory,
      );
      const dbScan =
        db && dirname(resolve(db)) !== directory
          ? recordedCredentialScanner(dirname(resolve(db)), note)
          : undefined;
      const scan: CredentialScanner | undefined =
        targetScan && dbScan
          ? async (...text) => {
              await targetScan(...text);
              await dbScan(...text);
            }
          : (targetScan ?? dbScan);
      return await execute(
        io,
        store,
        command,
        db !== undefined && targetPath === undefined ? undefined : directory,
        repoRoot,
        scan,
        target?.configDirectory,
        env,
        bootstrapRoot,
      );
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof ClaudeRunError) return refuse(io, error.code);
    if (error instanceof ConfigError)
      return refuse(io, `${error.message}\nnext: ${error.next}`);
    if (command.kind === "analyze" || command.kind === "denials")
      return refuse(io, "Local orchestrator analysis export failed.");
    if (
      command.kind === "export-goal-branch" &&
      error instanceof GitIntegrationError
    )
      return refuse(io, `Goal branch export refused (${error.code}).`);
    if (
      command.kind === "export-goal-branch" &&
      error instanceof OrchestratorStoreError
    ) {
      if (
        error.code === "export-head-mismatch" ||
        error.code === "goal-inactive"
      )
        return refuse(io, `Goal branch export refused (${error.code}).`);
      if (error.code === "goal-export-record-failed")
        return refuse(
          io,
          "The local branch was updated, but recording goal.exported failed. Inspect the local branch and audit before retrying.",
        );
      if (error.code === "integration-uncertain")
        return refuse(
          io,
          "Goal branch export paused during integration. Use reconcile if the launcher stopped.",
        );
    }
    if (
      command.kind === "reconcile" &&
      error instanceof OrchestratorStoreError &&
      error.code === "integration-uncertain"
    )
      return refuse(
        io,
        "Integration is still uncertain. Inspect the private Goal branch and integration journal. With a custom --db, pass --target for the launcher target.",
      );
    if (command.kind === "update-goal-base") {
      if (
        error instanceof OrchestratorStoreError &&
        error.code === "goal-base-ineligible"
      )
        return refuse(io, "Goal base update refused (ineligible).");
      if (
        error instanceof OrchestratorStoreError &&
        error.code === "goal-inactive"
      )
        return refuse(io, "Goal base update refused (goal-inactive).");
      if (
        (error instanceof OrchestratorStoreError &&
          error.code === "goal-base-stale") ||
        (error instanceof GitIntegrationError && error.code === "stale-base")
      )
        return refuse(io, "Goal base update refused (stale-base).");
      if (
        error instanceof GitIntegrationError &&
        error.code === "unsafe-repository"
      )
        return refuse(io, "Goal base update refused (unsafe-repository).");
      if (
        error instanceof OrchestratorStoreError &&
        error.code === "goal-base-record-failed"
      )
        return refuse(
          io,
          "Goal branch update completed, but recording the base and audit event failed. Inspect the branch and store before retrying.",
        );
      if (
        error instanceof GitIntegrationError &&
        error.code === "ambiguous-update"
      )
        return refuse(
          io,
          "Goal branch update outcome is unknown. Inspect the branch and store before retrying.",
        );
    }
    if (command.kind === "discard-goal") {
      if (
        error instanceof OrchestratorStoreError &&
        error.code === "goal-discard-record-failed"
      )
        return refuse(
          io,
          "The Git step completed, but recording the Goal cancellation failed. Inspect the branch and store before retrying.",
        );
      if (
        error instanceof GitIntegrationError &&
        error.code === "ambiguous-update"
      )
        return refuse(
          io,
          "Goal branch deletion outcome is unknown. Inspect the branch and store before retrying.",
        );
      if (
        error instanceof OrchestratorStoreError ||
        error instanceof GitIntegrationError
      )
        return refuse(io, `Goal discard refused (${error.code}).`);
    }
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
      error.code === "goal-inactive"
    )
      return refuse(io, "Task retry refused (goal-inactive).");
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
