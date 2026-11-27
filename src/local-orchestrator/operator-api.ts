import {
  GOAL_POLICIES,
  RULE_GATES,
  TASK_POLICIES,
  validateDelegationRules,
} from "./delegation.ts";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { basename, isAbsolute, join } from "node:path";
import { GitIntegrationError } from "../git-integration.ts";
import { privatePath } from "../config/layers.ts";
import { isTerminalSize } from "../sandbox-runtime.ts";
import { escapeTerminalControls } from "./analysis.ts";
import { ClaudeRunError } from "./claude-errors.ts";
import type { ConciergeTerminalHub } from "./concierge-terminal.ts";
import type { CredentialScanner } from "./credential-scan.ts";
import {
  changedInboxIds,
  inboxLimit,
  inboxSnapshot,
  projectInbox,
  type InboxSource,
} from "./inbox.ts";
import {
  ContractError,
  fields,
  GATES,
  gitCommit,
  identifier,
  integer,
  oneOf,
} from "./model.ts";
import {
  goalStatuses,
  operatorActivity,
  operatorActivityRevision,
  operatorGoal,
  operatorGoalList,
  operatorInbox,
  operatorProblems,
  operatorProposal,
  operatorStatus,
  operatorTask,
  operatorTaskList,
} from "./operator-read.ts";
import {
  answerFromPanel,
  answerManyFromPanel,
  parsePanelAnswer,
} from "./proposal-answer.ts";
import {
  MAX_TASK_RETRIES,
  OrchestratorStoreError,
  type OrchestratorStore,
  type StoreErrorCode,
} from "./store.ts";
import {
  previewGoalBranchExport,
  previewGoalBaseUpdate,
  previewGoalDiscard,
  readGoalBranchHead,
} from "./tasks.ts";
import {
  WorkplaceEnvironmentError,
  type WorkplaceEnvironment,
} from "./workplace-environment.ts";

interface OperatorApiOptions extends InboxSource {
  stateDirectory: string;
  repository?: { project: string; repositoryPath: string };
  scan?: CredentialScanner;
  maxLineBytes?: number;
  pollMs?: number;
  terminal?: ConciergeTerminalHub;
  workplace?: { signal: AbortSignal; stop(): void };
  environment?: WorkplaceEnvironment;
}

type GoalExportTarget = Pick<
  OperatorApiOptions,
  "target" | "repository" | "scan"
>;

type RequestId = string | number;
type ExportBlockReason = "branch-checked-out" | "non-fast-forward";
type OperatorGoalDetail = NonNullable<ReturnType<typeof operatorGoal>> & {
  head: string | null;
  headAvailable: boolean;
  exportPreview: {
    branch: string;
    from: string | null;
    to: string;
    target: string;
  } | null;
  exportBlockReason: ExportBlockReason | null;
  baseUpdatePreview?: { from: string; to: string };
};
type ErrorCode =
  | StoreErrorCode
  | "invalid-request"
  | "invalid-params"
  | "unknown-method"
  | "terminal-unavailable"
  | "terminal-exited"
  | "terminal-read-only"
  | "confirmation-mismatch"
  | "export-unavailable"
  | ExportBlockReason
  | "already-exported"
  | "credential-leak"
  | "workplace-unavailable"
  | "workplace-stopping"
  | WorkplaceEnvironmentError["code"]
  | "stale-base";
type Reply = { result: unknown } | { error: { code: ErrorCode } };
type Client = {
  subscribedSnapshot?: Map<string, string>;
  activityRevision?: string;
  send: Parameters<ConciergeTerminalHub["attach"]>[0];
  pendingBytes: number;
};

const failure = (code: ErrorCode): Reply => ({ error: { code } });
function exportBlockReason(error: unknown): ExportBlockReason | null {
  return error instanceof GitIntegrationError &&
    (error.code === "branch-checked-out" || error.code === "non-fast-forward")
    ? error.code
    : null;
}

class ConfirmationMismatchError extends Error {}
const maxClients = 8;
const maxPendingBytes = 1024 * 1024;
const maxTerminalInputBytes = 16 * 1024;
const maxDraftCharacters = 2000;
const shutdownBlockedMethods = new Set([
  "task.retry",
  "goal.discard",
  "goal.export",
  "goal.updateBase",
  "proposal.answer",
  "proposal.answerMany",
  "environment.build",
  "workplace.stop",
  "inbox.markSeen",
  "goal.setPolicy",
  "task.setIntegrationPolicy",
  "policy.setDefault",
  "policy.setRules",
  "concierge.draft",
  "concierge.input",
  "concierge.resize",
]);

export function draftToConcierge(
  store: OrchestratorStore,
  terminal: ConciergeTerminalHub | undefined,
  client: Parameters<ConciergeTerminalHub["attach"]>[0],
  params: unknown,
): Reply {
  if (!terminal) return failure("terminal-unavailable");
  if (terminal.status !== "ready") return failure(terminal.status);
  if (!terminal.ownsInput(client)) return failure("terminal-read-only");
  try {
    const { text } = fields(params, ["text"]);
    if (typeof text !== "string") throw new ContractError();
    const characters = Array.from(
      text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ""),
    ).slice(0, maxDraftCharacters);
    if (!characters.length) throw new ContractError();
    const sanitized = characters.join("");
    const sha256 = createHash("sha256").update(sanitized).digest("hex");
    store.recordConciergeDraft(characters.length, sha256);
    terminal.write(Buffer.from(`\x1b[200~${sanitized}\x1b[201~`));
    return { result: { characters: characters.length } };
  } catch (error) {
    return failure(
      error instanceof ContractError ? "invalid-params" : "write-failed",
    );
  }
}

export async function readOperatorGoal(
  store: OrchestratorStore,
  stateDirectory: string,
  id: string,
  destination?: GoalExportTarget,
): Promise<OperatorGoalDetail | null> {
  const goal = operatorGoal(store, id);
  if (!goal) return null;
  const head = await readGoalBranchHead(stateDirectory, goal.id).then(
    (head) => ({ head, headAvailable: true }),
    () => ({ head: null, headAvailable: false }),
  );
  const baseUpdate =
    destination && goal.status === "active" && head.head
      ? await previewGoalBaseUpdate(
          store,
          destination.target,
          stateDirectory,
          goal.id,
        )
          .then(({ from, to }) =>
            from === to ? {} : { baseUpdatePreview: { from, to } },
          )
          .catch(() => ({}))
      : {};
  if (destination?.scan && goal.turn.reason.kind === "exportable") {
    try {
      const { branch, from, to } = await previewGoalBranchExport(
        store,
        destination.target,
        stateDirectory,
        goal.id,
      );
      const target = escapeTerminalControls(
        destination.repository?.project ?? basename(destination.target),
      );
      return {
        ...goal,
        ...head,
        exportPreview: { branch, from, to, target },
        exportBlockReason: null,
      };
    } catch (error) {
      return {
        ...goal,
        ...head,
        exportPreview: null,
        exportBlockReason: exportBlockReason(error),
      };
    }
  }
  return {
    ...goal,
    ...head,
    ...baseUpdate,
    exportPreview: null,
    exportBlockReason: null,
  };
}

export async function operatorAction(
  store: OrchestratorStore,
  stateDirectory: string,
  method: "task.retry" | "goal.discard" | "goal.export" | "goal.updateBase",
  params: unknown,
  destination?: GoalExportTarget,
): Promise<Reply> {
  try {
    if (method === "task.retry") {
      const { id, expectedRetries } = fields(params, ["id", "expectedRetries"]);
      return {
        result: store.retryTask(
          identifier(id),
          integer(expectedRetries, 0, MAX_TASK_RETRIES),
          "operator-ui",
        ),
      };
    }
    if (method === "goal.updateBase") {
      const input = fields(params, ["id", "confirm", "from", "to"]);
      const id = identifier(input.id);
      const expectedFrom = gitCommit(input.from);
      const expectedTo = gitCommit(input.to);
      if (typeof input.confirm !== "string") throw new ContractError();
      if (!destination) return failure("workplace-unavailable");
      const goal = store.getGoal(id);
      if (!goal) return failure("not-found");
      const { from, to, apply } = await previewGoalBaseUpdate(
        store,
        destination.target,
        stateDirectory,
        goal.id,
        "operator-ui",
      );
      if (from !== expectedFrom || to !== expectedTo || from === to)
        return failure("stale-base");
      if (input.confirm !== `update-goal-base ${goal.ref} ${to.slice(0, 12)}`)
        return failure("confirmation-mismatch");
      await apply();
      return { result: { id: goal.id, ref: goal.ref, from, to } };
    }
    const { id, confirm, expectedHead } = fields(params, [
      "id",
      "confirm",
      "expectedHead",
    ]);
    if (typeof confirm !== "string") throw new ContractError();
    const expected =
      method === "goal.discard" && expectedHead === null
        ? null
        : gitCommit(expectedHead);
    const goal = store.getGoal(identifier(id));
    if (!goal) return failure("not-found");
    if (method === "goal.export") {
      if (!destination?.scan) return failure("export-unavailable");
      const { branch, from, to, apply } = await previewGoalBranchExport(
        store,
        destination.target,
        stateDirectory,
        goal.id,
        destination.scan,
        (to) => {
          if (expected !== to) throw new GitIntegrationError("stale-base");
          if (confirm !== `export-goal-branch ${goal.ref} ${to.slice(0, 12)}`)
            throw new ConfirmationMismatchError();
        },
      );
      await apply();
      return { result: { id: goal.id, ref: goal.ref, branch, from, to } };
    }
    if (confirm !== goal.ref) return failure("confirmation-mismatch");
    const { head, apply } = await previewGoalDiscard(
      store,
      stateDirectory,
      goal.id,
      "operator-ui",
    );
    if (head !== expected) return failure("stale-base");
    await apply();
    return { result: { id: goal.id, ref: goal.ref, status: "cancelled" } };
  } catch (error) {
    if (error instanceof ContractError) return failure("invalid-params");
    if (error instanceof ConfirmationMismatchError)
      return failure("confirmation-mismatch");
    if (error instanceof OrchestratorStoreError)
      return failure(
        error.code === "export-head-mismatch" ? "stale-base" : error.code,
      );
    if (
      error instanceof GitIntegrationError &&
      (error.code === "stale-base" || error.code === "export-head-mismatch")
    )
      return failure("stale-base");
    if (method === "goal.export") {
      const reason = exportBlockReason(error);
      if (reason) return failure(reason);
      if (
        error instanceof GitIntegrationError &&
        error.code === "already-exported"
      )
        return failure(error.code);
    }
    if (error instanceof ClaudeRunError && error.code === "credential-leak")
      return failure("credential-leak");
    return failure("write-failed");
  }
}

export function workplaceStopAction(
  store: OrchestratorStore,
  workplace: OperatorApiOptions["workplace"],
  method: "workplace.stopPreview" | "workplace.stop",
  params: unknown,
): Reply {
  try {
    const input = fields(
      params,
      method === "workplace.stop" ? ["confirm", "revision"] : [],
    );
    if (!workplace) return failure("workplace-unavailable");
    if (workplace.signal.aborted) return failure("workplace-stopping");
    if (method === "workplace.stopPreview")
      return { result: store.workplaceStopPreview() };
    if (
      typeof input.confirm !== "string" ||
      typeof input.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.revision)
    )
      throw new ContractError();
    if (input.confirm !== "Workplace を終える")
      return failure("confirmation-mismatch");
    try {
      store.recordWorkplaceStop(input.revision);
    } catch (error) {
      if (
        error instanceof OrchestratorStoreError &&
        error.code === "stale-confirmation"
      )
        return failure(error.code);
      return failure("write-failed");
    }
    workplace.stop();
    return { result: { stopping: true } };
  } catch (error) {
    return failure(
      error instanceof ContractError
        ? "invalid-params"
        : error instanceof OrchestratorStoreError
          ? error.code
          : "write-failed",
    );
  }
}

export async function workplaceEnvironmentAction(
  environment: WorkplaceEnvironment | undefined,
  method:
    "environment.status" | "environment.buildPreview" | "environment.build",
  params: unknown,
): Promise<Reply> {
  try {
    const { confirmation } = fields(
      params,
      method === "environment.build" ? ["confirmation"] : [],
    );
    if (
      method === "environment.build" &&
      (typeof confirmation !== "string" || !/^[a-f0-9]{64}$/.test(confirmation))
    )
      throw new ContractError();
    if (!environment) return failure("environment-unavailable");
    if (method === "environment.status")
      return { result: await environment.status() };
    if (method === "environment.buildPreview")
      return { result: await environment.preview() };
    return { result: await environment.start(confirmation as string) };
  } catch (error) {
    return failure(
      error instanceof ContractError
        ? "invalid-params"
        : error instanceof WorkplaceEnvironmentError
          ? error.code
          : "write-failed",
    );
  }
}

function requestId(value: unknown): RequestId {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : identifier(value);
}

function write(socket: Socket, client: Client, message: object) {
  if (socket.destroyed) return Promise.resolve();
  const line = JSON.stringify(message) + "\n";
  const bytes = Buffer.byteLength(line);
  if (client.pendingBytes + bytes > maxPendingBytes) {
    socket.destroy();
    return Promise.resolve();
  }
  client.pendingBytes += bytes;
  return new Promise<void>((resolve, reject) => {
    socket.write(line, (error) => {
      client.pendingBytes -= bytes;
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Remove a socket left by a launcher that exited without cleanup. A socket
 * that still accepts connections belongs to a running launcher. */
async function removeStaleSocket(path: string) {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.())
    throw new Error("Operator socket path already exists");
  const live = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error("Operator API already running");
  unlinkSync(path);
}

export async function dispatchPolicy(
  store: OrchestratorStore,
  method: string,
  params: unknown,
  scan?: CredentialScanner,
): Promise<Reply | undefined> {
  const origin = "operator-ui";
  try {
    switch (method) {
      case "policy.get":
        fields(params, []);
        return { result: store.policySettings() };
      case "decision.history": {
        const { limit } = fields(params, ["limit"]);
        return {
          result: store.decisionHistory(
            limit === undefined ? undefined : integer(limit, 1, 200),
          ),
        };
      }
      case "policy.setDefault": {
        const { gate, policy } = fields(params, ["gate", "policy"]);
        store.setProjectDefaults(
          { [oneOf(gate, GATES)]: oneOf(policy, ["human", "agent"]) },
          { kind: "operator" },
          origin,
        );
        break;
      }
      case "policy.setRules": {
        const { rules, expectedRevision } = fields(params, [
          "rules",
          "expectedRevision",
        ]);
        if (
          expectedRevision !== undefined &&
          (typeof expectedRevision !== "string" ||
            !/^[a-f0-9]{64}$/.test(expectedRevision))
        )
          throw new ContractError();
        const validated = validateDelegationRules(rules);
        await scan?.(JSON.stringify(validated));
        store.setRules(validated, origin, expectedRevision);
        break;
      }
      case "goal.setPolicy": {
        const { goalId, gate, value, expected } = fields(params, [
          "goalId",
          "gate",
          "value",
          "expected",
        ]);
        store.setGoalPolicy(
          identifier(goalId),
          oneOf(gate, RULE_GATES),
          oneOf(value, GOAL_POLICIES),
          origin,
          expected === undefined ? undefined : oneOf(expected, GOAL_POLICIES),
        );
        break;
      }
      case "task.setIntegrationPolicy": {
        const { taskId, value, expected } = fields(params, [
          "taskId",
          "value",
          "expected",
        ]);
        store.setTaskIntegrationPolicy(
          identifier(taskId),
          oneOf(value, TASK_POLICIES),
          origin,
          expected === undefined ? undefined : oneOf(expected, TASK_POLICIES),
        );
        break;
      }
      default:
        return undefined;
    }
    return { result: { ok: true } };
  } catch (error) {
    if (error instanceof ContractError) return failure("invalid-params");
    if (error instanceof OrchestratorStoreError) return failure(error.code);
    return failure("write-failed");
  }
}

export async function listenOperatorApi(options: OperatorApiOptions) {
  const { stateDirectory, store, scan, terminal } = options;
  const maxLine = integer(options.maxLineBytes ?? 64 * 1024, 1, 1024 * 1024);
  const pollMs = integer(options.pollMs ?? 1000, 1, 60_000);
  const directory = join(stateDirectory, "operator");
  const path = join(directory, "api.sock");
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    Buffer.byteLength(path) >= (process.platform === "darwin" ? 104 : 108)
  )
    throw new Error("Invalid operator socket path");
  privatePath(stateDirectory, stateDirectory);
  privatePath(directory, stateDirectory, true);
  await removeStaleSocket(path);

  const clients = new Map<Socket, Client>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const project = (includeResolved = false) =>
    operatorInbox(store, projectInbox(options, { includeResolved }));

  function terminalRequest(
    method: string,
    params: unknown,
    client: Client,
  ): Reply | undefined {
    if (method === "concierge.draft")
      return draftToConcierge(store, terminal, client.send, params);
    if (
      method !== "concierge.attach" &&
      method !== "concierge.input" &&
      method !== "concierge.resize"
    )
      return undefined;
    if (!terminal) return failure("terminal-unavailable");
    const status = terminal.status;
    if (status !== "ready") return failure(status);
    try {
      if (method === "concierge.attach") {
        fields(params, []);
        return { result: { replay: terminal.attach(client.send) } };
      }
      if (!terminal.ownsInput(client.send))
        return failure("terminal-read-only");
      if (method === "concierge.input") {
        const { data } = fields(params, ["data"]);
        if (
          typeof data !== "string" ||
          data.length > 4 * Math.ceil(maxTerminalInputBytes / 3)
        )
          throw new ContractError();
        const input = Buffer.from(data, "base64");
        if (
          input.length > maxTerminalInputBytes ||
          input.toString("base64") !== data
        )
          throw new ContractError();
        terminal.write(input);
      } else {
        const { cols, rows } = fields(params, ["cols", "rows"]);
        if (
          typeof cols !== "number" ||
          typeof rows !== "number" ||
          !isTerminalSize(cols, rows)
        )
          throw new ContractError();
        terminal.resize(cols, rows);
      }
      return { result: {} };
    } catch (error) {
      return failure(
        error instanceof ContractError ? "invalid-params" : "write-failed",
      );
    }
  }

  async function dispatch(method: string, params: unknown): Promise<Reply> {
    try {
      switch (method) {
        case "task.retry":
        case "goal.discard":
        case "goal.export":
        case "goal.updateBase":
          return operatorAction(store, stateDirectory, method, params, options);
        case "workplace.stopPreview":
        case "workplace.stop":
          return workplaceStopAction(store, options.workplace, method, params);
        case "environment.status":
        case "environment.buildPreview":
        case "environment.build":
          return workplaceEnvironmentAction(
            options.environment,
            method,
            params,
          );
        case "activity.get":
          fields(params, []);
          return { result: operatorActivity(options) };
        case "activity.subscribe":
          fields(params, []);
          return { result: { subscribed: true } };
        case "inbox.list":
        case "problem.list": {
          const { includeResolved } = fields(params, ["includeResolved"]);
          if (
            includeResolved !== undefined &&
            typeof includeResolved !== "boolean"
          )
            throw new ContractError();
          return {
            result:
              method === "inbox.list"
                ? project(includeResolved)
                : operatorProblems(store, includeResolved),
          };
        }
        case "inbox.markSeen": {
          const { ids } = fields(params, ["ids"]);
          if (!Array.isArray(ids) || ids.length > inboxLimit)
            throw new ContractError();
          const requested = new Set(ids.map(identifier));
          const known = project()
            .filter(({ id }) => requested.has(id))
            .map(({ id }) => id);
          store.markInboxSeen(known);
          return { result: { marked: known.length } };
        }
        case "status":
          fields(params, []);
          return {
            result: {
              ...operatorStatus(store),
              ...(options.repository && {
                project: options.repository.project,
                repositoryPath: escapeTerminalControls(
                  options.repository.repositoryPath,
                ),
              }),
            },
          };
        case "goal.list": {
          const { status } = fields(params, ["status"]);
          return {
            result: operatorGoalList(
              store,
              status === undefined ? undefined : oneOf(status, goalStatuses),
            ),
          };
        }
        case "goal.get": {
          const { id } = fields(params, ["id"]);
          const result = await readOperatorGoal(
            store,
            stateDirectory,
            identifier(id),
            options,
          );
          return result ? { result } : failure("not-found");
        }
        case "task.get": {
          const { id } = fields(params, ["id"]);
          const result = operatorTask(store, identifier(id));
          return result ? { result } : failure("not-found");
        }
        case "task.list": {
          const { goalId } = fields(params, ["goalId"]);
          const result = operatorTaskList(store, identifier(goalId));
          return result ? { result } : failure("not-found");
        }
        case "proposal.get": {
          const { id } = fields(params, ["id"]);
          const proposal = await operatorProposal(
            store,
            stateDirectory,
            identifier(id),
            scan,
          );
          return proposal ? { result: proposal } : failure("not-found");
        }
        case "proposal.answer": {
          const result = await answerFromPanel(
            store,
            stateDirectory,
            parsePanelAnswer(params),
            scan,
          );
          return "error" in result ? { error: result.error } : { result };
        }
        case "proposal.answerMany":
          return {
            result: await answerManyFromPanel(
              store,
              stateDirectory,
              params,
              scan,
            ),
          };
        case "inbox.subscribe":
          fields(params, []);
          return { result: { subscribed: true } };
        default:
          return (
            (await dispatchPolicy(store, method, params, scan)) ??
            failure("unknown-method")
          );
      }
    } catch (error) {
      if (error instanceof ContractError) return failure("invalid-params");
      return failure(
        method === "inbox.markSeen" || method === "proposal.answerMany"
          ? "write-failed"
          : "read-failed",
      );
    }
  }

  let writesStopped = false;
  const pendingWrites = new Set<Promise<Reply>>();
  function dispatchRequest(method: string, params: unknown) {
    if (!shutdownBlockedMethods.has(method)) return dispatch(method, params);
    const result = dispatch(method, params).finally(() =>
      pendingWrites.delete(result),
    );
    pendingWrites.add(result);
    return result;
  }

  async function stopWrites() {
    writesStopped = true;
    await Promise.all(pendingWrites);
  }

  async function serve(socket: Socket, client: Client) {
    const line = Buffer.allocUnsafe(maxLine);
    let length = 0;
    let invalid = 0;
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length && !socket.destroyed) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (length + end - offset > maxLine) return;
        length += chunk.copy(line, length, offset, end);
        if (newline < 0) break;
        offset = newline + 1;
        let id: RequestId | null = null;
        let reply: Reply;
        let subscribedSnapshot: Client["subscribedSnapshot"];
        let subscribedActivityRevision: Client["activityRevision"];
        try {
          const message = fields(
            JSON.parse(decoder.decode(line.subarray(0, length))),
            ["id", "method", "params"],
          );
          id = requestId(message.id);
          if (
            typeof message.method !== "string" ||
            !Object.hasOwn(message, "params")
          )
            throw new ContractError();
          const terminalReply =
            (writesStopped || options.workplace?.signal.aborted) &&
            shutdownBlockedMethods.has(message.method)
              ? failure("workplace-stopping")
              : terminalRequest(message.method, message.params, client);
          if (terminalReply) {
            // Send the replay without yielding to live output first.
            reply = terminalReply;
          } else {
            reply = await dispatchRequest(message.method, message.params);
            if ("result" in reply) {
              try {
                if (message.method === "inbox.subscribe")
                  subscribedSnapshot = inboxSnapshot(project(true));
                else if (message.method === "activity.subscribe")
                  subscribedActivityRevision =
                    operatorActivityRevision(options);
                // Screen decision inputs before writing. Operator action
                // receipts contain host-generated IDs, refs and commits.
                else if (
                  message.method !== "inbox.markSeen" &&
                  message.method !== "proposal.answer" &&
                  message.method !== "proposal.answerMany" &&
                  message.method !== "task.retry" &&
                  message.method !== "goal.discard" &&
                  message.method !== "goal.export" &&
                  message.method !== "goal.updateBase" &&
                  message.method !== "workplace.stop" &&
                  message.method !== "environment.build"
                ) {
                  const serialized = JSON.stringify(reply.result);
                  if (Buffer.byteLength(serialized) > maxPendingBytes - 1024)
                    reply = failure("read-failed");
                  // Proposal text is screened field by field before escaping.
                  else if (message.method !== "proposal.get")
                    await scan?.(serialized);
                }
              } catch {
                reply = failure("read-failed");
              }
            }
          }
        } catch {
          reply = failure("invalid-request");
          invalid++;
        }
        length = 0;
        await write(socket, client, { id, ...reply });
        if (subscribedSnapshot) client.subscribedSnapshot = subscribedSnapshot;
        if (subscribedActivityRevision !== undefined)
          client.activityRevision = subscribedActivityRevision;
        if (invalid >= 3) return;
      }
    }
  }

  const requests = new Set<Promise<void>>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => {});
    if (clients.size >= maxClients) {
      socket.destroy();
      return;
    }
    const client: Client = {
      pendingBytes: 0,
      send: (message) =>
        void write(socket, client, message).catch(() => socket.destroy()),
    };
    clients.set(socket, client);
    socket.once("close", () => {
      terminal?.detach(client.send);
      clients.delete(socket);
    });
    const serving = serve(socket, client)
      .catch(() => {})
      .finally(() => {
        requests.delete(serving);
        socket.destroy();
      });
    requests.add(serving);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const identity = lstatSync(path, { throwIfNoEntry: false });
  function removeSocket() {
    const current = lstatSync(path, { throwIfNoEntry: false });
    if (
      identity &&
      current?.isSocket() &&
      current.ino === identity.ino &&
      current.dev === identity.dev
    )
      unlinkSync(path);
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= new Promise<void>((resolve, reject) => {
      clearInterval(timer);
      for (const socket of clients.keys()) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    })
      .then(async () => {
        await Promise.all(requests);
      })
      .finally(removeSocket);
    return closing;
  }
  server.on("error", () => void close().catch(() => {}));
  try {
    if (!identity?.isSocket()) throw new Error("Operator socket unavailable");
    chmodSync(path, 0o600);
    timer = setInterval(() => {
      if (
        [...clients.values()].some(
          ({ activityRevision }) => activityRevision !== undefined,
        )
      ) {
        try {
          const revision = operatorActivityRevision(options);
          for (const [socket, client] of clients) {
            if (
              client.activityRevision === undefined ||
              client.activityRevision === revision
            )
              continue;
            client.activityRevision = revision;
            void write(socket, client, {
              method: "activity.changed",
              params: {},
            }).catch(() => socket.destroy());
          }
        } catch {
          // Allow another tick to read the journal.
        }
      }
      if (
        ![...clients.values()].some(
          ({ subscribedSnapshot }) => subscribedSnapshot,
        )
      )
        return;
      let current: Map<string, string>;
      try {
        current = inboxSnapshot(project(true));
      } catch {
        return;
      }
      for (const [socket, client] of clients) {
        if (!client.subscribedSnapshot) continue;
        const ids = changedInboxIds(client.subscribedSnapshot, current);
        client.subscribedSnapshot = current;
        if (!ids.length) continue;
        void write(socket, client, {
          method: "inbox.changed",
          params: { ids },
        }).catch(() => socket.destroy());
      }
    }, pollMs);
    timer.unref();
    return { path, close, stopWrites };
  } catch (error) {
    await close();
    throw error;
  }
}
