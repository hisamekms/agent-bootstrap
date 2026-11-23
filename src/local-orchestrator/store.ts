import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import {
  ACTOR_KINDS,
  GATES,
  ContractError,
  canonicalJson,
  contentDigest,
  fields,
  fitsScope,
  freeze,
  identifier,
  integer,
  oneOf,
  requestedLoosening,
  resolvePolicy,
  taskLimitReasons,
  validateGoalContent,
  validatePolicies,
  validateTaskContent,
  type ActorKind,
  type Gate,
  type GoalContent,
  type PolicyLayers,
  type PolicySet,
  type TaskContent,
} from "./model.ts";

export type Operator = { kind: "operator" };
export type Origin =
  | Operator
  | { kind: "host" }
  | {
      kind: "actor";
      actor: ActorKind;
      sessionId?: string;
      executionId?: string;
    };
export type Answerer =
  { kind: "human" } | { kind: "agent"; executionId: string; model: string };

type Binding = string | number | null;
interface Connection {
  exec(sql: string): unknown;
  query<T>(sql: string): {
    get(...values: Binding[]): T | null;
    all(...values: Binding[]): T[];
    run(...values: Binding[]): { changes: number };
  };
  transaction<T>(work: () => T): { immediate(): T; deferred(): T };
  close(): void;
}
// Bun provides SQLite at runtime. The project has no downloaded Bun types.
const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (
    filename: string,
    options: { create: boolean; strict: boolean },
  ) => Connection;
};

type ErrorCode =
  | "open-failed"
  | "closed"
  | "write-failed"
  | "read-failed"
  | "not-found"
  | "stale-digest"
  | "invalid-transition"
  | "approval-forbidden"
  | "goal-inactive"
  | "task-constraints"
  | "context-mismatch";

export class OrchestratorStoreError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(`Local orchestrator store: ${code}`);
    this.name = "OrchestratorStoreError";
    this.code = code;
  }
}

export const proposalStatuses = Object.freeze([
  "pending",
  "approved",
  "rejected",
  "registered",
] as const);
type ProposalStatus = (typeof proposalStatuses)[number];
const finalExecutionStatuses = [
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
] as const;
type FinalExecutionStatus = (typeof finalExecutionStatuses)[number];
type ExecutionStatus = "queued" | "running" | FinalExecutionStatus;
type Decision = "approve" | "reject";
type ApprovalPolicy = ReturnType<typeof resolvePolicy>;

const applicationId = 0x4c4f5231;
const schema = `
  CREATE TABLE project_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1), policies_json TEXT NOT NULL
  ) STRICT;
  INSERT INTO project_policy VALUES (1, '{"goal-registration":"human","task-registration":"human","integration":"human"}');
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('goal', 'task')),
    content_json TEXT NOT NULL, digest TEXT NOT NULL, source_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'registered')),
    created_at TEXT NOT NULL, decided_at TEXT
  ) STRICT;
  CREATE TABLE goals (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    content_json TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')), created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
    proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    content_json TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('registered', 'running', 'succeeded', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0), created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX tasks_goal ON tasks(goal_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    gate TEXT NOT NULL CHECK (gate IN ('goal-registration', 'task-registration', 'integration')),
    digest TEXT NOT NULL, policy TEXT NOT NULL CHECK (policy IN ('human', 'agent')),
    policy_source TEXT NOT NULL CHECK (policy_source IN ('default', 'request', 'goal', 'task')),
    answerer_kind TEXT NOT NULL CHECK (answerer_kind IN ('human', 'agent')), answerer_json TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')), at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE executions (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, mode TEXT NOT NULL, requested_by_json TEXT NOT NULL,
    goal_id TEXT REFERENCES goals(id), task_id TEXT REFERENCES tasks(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed-out', 'cancelled')),
    result_json TEXT, started_at TEXT, finished_at TEXT
  ) STRICT;
  CREATE TABLE actor_sessions (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, runtime_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'ended')), started_at TEXT NOT NULL, ended_at TEXT
  ) STRICT;
  CREATE TABLE events (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL, session_id TEXT, execution_id TEXT,
    data TEXT NOT NULL CHECK (length(CAST(data AS BLOB)) <= 4096 AND json_valid(data))
  ) STRICT;
  CREATE INDEX events_subject ON events(subject_id);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER events_no_replace BEFORE INSERT ON events
    WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id OR rowid = NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;

function required<T>(row: T | null): T {
  if (row === null) throw new OrchestratorStoreError("not-found");
  return row;
}

function parseOrigin(value: unknown): Origin {
  const input = fields(value, ["kind", "actor", "sessionId", "executionId"]);
  if (input.kind === "operator" || input.kind === "host") {
    fields(input, ["kind"]);
    return { kind: input.kind };
  }
  return {
    kind: oneOf(input.kind, ["actor"]),
    actor: oneOf(input.actor, ACTOR_KINDS),
    ...(Object.hasOwn(input, "sessionId")
      ? { sessionId: identifier(input.sessionId) }
      : {}),
    ...(Object.hasOwn(input, "executionId")
      ? { executionId: identifier(input.executionId) }
      : {}),
  };
}

function parseAnswerer(value: unknown): Answerer {
  const input = fields(value, ["kind", "executionId", "model"]);
  if (input.kind === "human") {
    fields(input, ["kind"]);
    return { kind: "human" };
  }
  return {
    kind: oneOf(input.kind, ["agent"]),
    executionId: identifier(input.executionId),
    model: identifier(input.model),
  };
}

type ProposalRow = {
  id: string;
  kind: "goal" | "task";
  contentJson: string;
  digest: string;
  sourceJson: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
};
type RegisteredRow = {
  id: string;
  proposalId: string;
  contentJson: string;
  digest: string;
  createdAt: string;
};
type GoalRow = RegisteredRow & { status: "active" | "done" | "cancelled" };
type TaskRow = RegisteredRow & {
  goalId: string;
  status: "registered" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
};
type ExecutionRow = {
  id: string;
  actor: ActorKind;
  mode: string;
  requestedByJson: string;
  goalId: string | null;
  taskId: string | null;
  status: ExecutionStatus;
  resultJson: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};
type EventRow = {
  id: string;
  at: string;
  kind: string;
  subjectKind: string;
  subjectId: string;
  sessionId: string | null;
  executionId: string | null;
  data: string;
};

const proposalColumns =
  "id, kind, content_json AS contentJson, digest, source_json AS sourceJson, status, created_at AS createdAt, decided_at AS decidedAt";
const registeredColumns =
  "id, proposal_id AS proposalId, content_json AS contentJson, digest, status, created_at AS createdAt";
const taskColumns = `${registeredColumns}, goal_id AS goalId, attempts`;
const executionColumns =
  "id, actor, mode, requested_by_json AS requestedByJson, goal_id AS goalId, task_id AS taskId, status, result_json AS resultJson, started_at AS startedAt, finished_at AS finishedAt";
const eventColumns =
  "id, at, kind, subject_kind AS subjectKind, subject_id AS subjectId, session_id AS sessionId, execution_id AS executionId, data";

function proposalRecord({
  contentJson,
  sourceJson,
  kind,
  ...row
}: ProposalRow) {
  const raw: unknown = JSON.parse(contentJson);
  const source = parseOrigin(JSON.parse(sourceJson));
  return kind === "goal"
    ? freeze({ ...row, kind, source, content: validateGoalContent(raw) })
    : freeze({ ...row, kind, source, content: validateTaskContent(raw) });
}

function goalRecord({ contentJson, ...row }: GoalRow) {
  return freeze({
    ...row,
    content: validateGoalContent(JSON.parse(contentJson)),
  });
}

function taskRecord({ contentJson, ...row }: TaskRow) {
  return freeze({
    ...row,
    content: validateTaskContent(JSON.parse(contentJson)),
  });
}

type ProposalReceipt = Readonly<{
  id: string;
  digest: string;
  loosening: readonly Gate[];
}>;
type PendingReceipt = ProposalReceipt &
  ApprovalPolicy &
  Readonly<{
    status: "pending";
    gate: "task-registration";
    reasons: readonly string[];
  }>;
type DecisionReceipt = Readonly<{
  status: "approved" | "rejected";
  goalId?: string;
  taskId?: string;
}>;
type GoalReceipt = ProposalReceipt &
  ApprovalPolicy &
  Readonly<{ gate: "goal-registration" }>;
type RegisteredReceipt = ProposalReceipt &
  Readonly<{
    status: "registered";
    taskId: string;
    reasons: readonly string[];
  }>;

export class OrchestratorStore {
  readonly #db: Connection;
  #closed = false;
  #writeFailed = false;

  private constructor(db: Connection) {
    this.#db = db;
  }

  static open(filename: string): OrchestratorStore {
    let db: Connection | undefined;
    try {
      if (
        typeof filename !== "string" ||
        filename === "" ||
        filename === ":memory:" ||
        filename.startsWith("file:") ||
        filename.includes("\0")
      )
        throw new Error();
      try {
        closeSync(openSync(filename, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const file = lstatSync(filename);
      if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error();
      const connection = new Database(filename, {
        create: false,
        strict: true,
      });
      db = connection;
      connection.exec(
        "PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL",
      );
      connection
        .transaction(() => {
          const id = connection
            .query<{ application_id: number }>("PRAGMA application_id")
            .get()?.application_id;
          if (
            id === 0 &&
            !connection.query("SELECT name FROM sqlite_schema LIMIT 1").get()
          ) {
            connection.exec(`${schema} PRAGMA application_id=${applicationId}`);
          } else if (id !== applicationId) {
            throw new Error();
          }
        })
        .immediate();
      if (
        connection
          .query<{ journal_mode: string }>("PRAGMA journal_mode=WAL")
          .get()?.journal_mode !== "wal"
      )
        throw new Error();
      return new OrchestratorStore(connection);
    } catch {
      try {
        db?.close();
      } catch {
        /* Keep SQLite diagnostics private. */
      }
      throw new OrchestratorStoreError("open-failed");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } catch {
      throw new OrchestratorStoreError("closed");
    }
  }

  #read<T>(read: () => T): T {
    if (this.#closed) throw new OrchestratorStoreError("closed");
    try {
      return read();
    } catch (error) {
      if (error instanceof OrchestratorStoreError) throw error;
      throw new OrchestratorStoreError("read-failed");
    }
  }

  #write<T>(write: (at: string) => T): T {
    if (this.#closed) throw new OrchestratorStoreError("closed");
    if (this.#writeFailed) throw new OrchestratorStoreError("write-failed");
    try {
      return this.#db
        .transaction(() => write(new Date().toISOString()))
        .immediate();
    } catch (error) {
      if (error instanceof OrchestratorStoreError) throw error;
      // SQLite rolls back callback failures. Quarantine the writer if a commit failed ambiguously.
      this.#writeFailed = true;
      throw new OrchestratorStoreError("write-failed");
    }
  }

  #run(sql: string, ...values: Binding[]): void {
    if (this.#db.query(sql).run(...values).changes !== 1) throw new Error();
  }

  #event(
    at: string,
    kind: string,
    subjectKind: string,
    subjectId: string,
    data: object,
    correlation: { sessionId?: string; executionId?: string } = {},
  ): void {
    this.#run(
      "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      randomUUID(),
      at,
      kind,
      subjectKind,
      subjectId,
      correlation.sessionId ?? null,
      correlation.executionId ?? null,
      canonicalJson(data, 4096),
    );
  }

  recordApiCall(
    sessionId: string,
    event:
      | { kind: "connected" | "disconnected"; durationMs: number }
      | { kind: "authorized"; callId: string; tool: string; durationMs: number }
      | {
          kind: "call";
          callId: string;
          tool: string;
          outcome: "ok" | "denied" | "error";
          code: string;
          durationMs: number;
          executionId?: string;
        },
  ): void {
    const id = identifier(sessionId);
    const { kind, ...data } = event;
    const executionId = event.kind === "call" ? event.executionId : undefined;
    if ("executionId" in data) delete data.executionId;
    this.#write((at) => {
      this.#event(at, `host-api.${kind}`, "session", id, data, {
        sessionId: id,
        ...(executionId === undefined ? {} : { executionId }),
      });
    });
  }

  isActiveConciergeSession(sessionId: string): boolean {
    const id = identifier(sessionId);
    return this.#read(
      () =>
        this.#db
          .query(
            "SELECT id FROM actor_sessions WHERE id = ? AND actor = 'Concierge' AND status = 'active'",
          )
          .get(id) !== null,
    );
  }

  #defaults(): PolicySet {
    const row = required(
      this.#db
        .query<{ policies_json: string }>(
          "SELECT policies_json FROM project_policy WHERE id = 1",
        )
        .get(),
    );
    return validatePolicies(JSON.parse(row.policies_json));
  }

  setProjectDefaults(policies: PolicySet, by: Operator): void {
    const requested = validatePolicies(policies);
    if (parseOrigin(by).kind !== "operator") throw new ContractError();
    this.#write((at) => {
      const defaults = { ...this.#defaults(), ...requested };
      this.#run(
        "UPDATE project_policy SET policies_json = ? WHERE id = 1",
        canonicalJson(defaults),
      );
      this.#event(at, "project.defaults-set", "project", "project", {
        defaults,
      });
    });
  }

  #newProposal(
    kind: ProposalRow["kind"],
    content: GoalContent | TaskContent,
    source: Origin,
    status: ProposalStatus,
    at: string,
  ): ProposalRow {
    const row: ProposalRow = {
      id: randomUUID(),
      kind,
      contentJson: canonicalJson(content),
      digest: contentDigest(content),
      sourceJson: canonicalJson(source),
      status,
      createdAt: at,
      decidedAt: status === "registered" ? at : null,
    };
    this.#run(
      "INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      kind,
      row.contentJson,
      row.digest,
      row.sourceJson,
      status,
      at,
      row.decidedAt,
    );
    return row;
  }

  #goalPolicy(content: GoalContent) {
    const gate = "goal-registration";
    const layers = { defaults: this.#defaults() };
    const request = content.policies ?? {};
    const loosening = requestedLoosening(layers, request);
    return {
      gate,
      loosening,
      ...resolvePolicy(
        gate,
        loosening.includes(gate) ? layers : { ...layers, request },
      ),
    } as const;
  }

  #goalLayers(goal: GoalContent): PolicyLayers {
    return { defaults: this.#defaults(), goal: goal.policies ?? {} };
  }

  #taskPolicy(task: TaskContent, goal: GoalContent) {
    const gate = "task-registration";
    const layers = this.#goalLayers(goal);
    return {
      gate,
      loosening: requestedLoosening(layers, task.policies ?? {}),
      ...resolvePolicy(gate, layers),
    } as const;
  }

  proposeGoal(content: unknown, origin: Origin): GoalReceipt {
    const goal = validateGoalContent(content);
    const source = parseOrigin(origin);
    return this.#write((at) => {
      const policy = this.#goalPolicy(goal);
      const row = this.#newProposal("goal", goal, source, "pending", at);
      this.#event(
        at,
        "goal.proposed",
        "proposal",
        row.id,
        { digest: row.digest, ...policy },
        source.kind === "actor" ? source : {},
      );
      return freeze({
        id: row.id,
        digest: row.digest,
        ...policy,
      });
    });
  }

  #goal(id: string) {
    return this.#db
      .query<GoalRow>(`SELECT ${registeredColumns} FROM goals WHERE id = ?`)
      .get(id);
  }

  #task(id: string) {
    return this.#db
      .query<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE id = ?`)
      .get(id);
  }

  #activeGoal(id: string): GoalContent {
    const row = required(this.#goal(id));
    if (row.status !== "active")
      throw new OrchestratorStoreError("goal-inactive");
    return goalRecord(row).content;
  }

  #taskCount(goalId: string): number {
    return required(
      this.#db
        .query<{ count: number }>(
          "SELECT count(*) AS count FROM tasks WHERE goal_id = ?",
        )
        .get(goalId),
    ).count;
  }

  #hasDependencies(task: TaskContent): boolean {
    const query = this.#db.query(
      "SELECT id FROM tasks WHERE id = ? AND goal_id = ?",
    );
    return task.dependsOn.every((id) => query.get(id, task.goalId) !== null);
  }

  #registerTask(row: ProposalRow, task: TaskContent, at: string): string {
    const id = randomUUID();
    this.#run(
      "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, 'registered', 0, ?)",
      id,
      task.goalId,
      row.id,
      row.contentJson,
      row.digest,
      at,
    );
    return id;
  }

  proposeTask(
    content: unknown,
    origin: Origin,
  ): PendingReceipt | RegisteredReceipt {
    const task = validateTaskContent(content);
    const source = parseOrigin(origin);
    return this.#write((at) => {
      const goal = this.#activeGoal(task.goalId);
      const { gate, loosening, ...policy } = this.#taskPolicy(task, goal);
      const scope = fitsScope(goal, task, this.#taskCount(task.goalId));
      const reasons = scope.ok ? [] : scope.reasons;
      if (!this.#hasDependencies(task)) reasons.push("dependsOn");
      if (loosening.length !== 0) reasons.push("policy-loosening");
      if (reasons.length === 0) {
        const row = this.#newProposal("task", task, source, "registered", at);
        const taskId = this.#registerTask(row, task, at);
        this.#event(
          at,
          "task.auto-registered",
          "task",
          taskId,
          { proposalId: row.id, goalId: task.goalId, digest: row.digest },
          source.kind === "actor" ? source : {},
        );
        return freeze({
          id: row.id,
          digest: row.digest,
          status: "registered",
          taskId,
          loosening,
          reasons,
        });
      }
      const row = this.#newProposal("task", task, source, "pending", at);
      this.#event(
        at,
        "task.proposed",
        "proposal",
        row.id,
        { digest: row.digest, gate, ...policy, loosening, reasons },
        source.kind === "actor" ? source : {},
      );
      return freeze({
        id: row.id,
        digest: row.digest,
        status: "pending",
        gate,
        ...policy,
        loosening,
        reasons,
      });
    });
  }

  decide(
    proposalId: string,
    answer: { digest: string; decision: Decision; answerer: Answerer },
  ): DecisionReceipt {
    const id = identifier(proposalId);
    const input = fields(answer, ["digest", "decision", "answerer"]);
    if (typeof input.digest !== "string") throw new ContractError();
    const decision = oneOf(input.decision, ["approve", "reject"]);
    const answerer = parseAnswerer(input.answerer);
    return this.#write((at) => {
      const row = required(this.#proposal(id));
      if (row.digest !== input.digest)
        throw new OrchestratorStoreError("stale-digest");
      if (row.status !== "pending")
        throw new OrchestratorStoreError("invalid-transition");
      const proposal = proposalRecord(row);
      if (contentDigest(proposal.content) !== row.digest)
        throw new OrchestratorStoreError("stale-digest");
      const goal =
        proposal.kind === "task"
          ? goalRecord(required(this.#goal(proposal.content.goalId)))
          : undefined;
      const { gate, policy, source, loosening } =
        proposal.kind === "goal"
          ? this.#goalPolicy(proposal.content)
          : this.#taskPolicy(proposal.content, goal!.content);
      const task = proposal.kind === "task" ? proposal.content : undefined;
      const origin = proposal.source;
      if (answerer.kind === "agent") {
        const execution = this.#execution(answerer.executionId);
        if (
          policy === "human" ||
          task?.policies?.["task-registration"] === "human" ||
          (decision === "approve" && loosening.length > 0) ||
          (origin.kind === "actor" &&
            (origin.actor === "Concierge" ||
              origin.executionId === answerer.executionId)) ||
          execution?.actor !== "Reviewer" ||
          execution.mode !== "approval" ||
          execution.status !== "running" ||
          parseOrigin(JSON.parse(execution.requestedByJson)).kind !== "host" ||
          (task && execution.goalId !== task.goalId)
        )
          throw new OrchestratorStoreError("approval-forbidden");
      }

      if (decision === "approve" && task) {
        if (goal?.status !== "active")
          throw new OrchestratorStoreError("goal-inactive");
        if (
          taskLimitReasons(goal.content, task, this.#taskCount(task.goalId))
            .length !== 0 ||
          !this.#hasDependencies(task)
        )
          throw new OrchestratorStoreError("task-constraints");
      }
      const status = decision === "approve" ? "approved" : "rejected";
      const approvalId = randomUUID();
      this.#run(
        "UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?",
        status,
        at,
        id,
      );
      this.#run(
        "INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        approvalId,
        id,
        gate,
        row.digest,
        policy,
        source,
        answerer.kind,
        canonicalJson(answerer),
        decision,
        at,
      );
      const correlation = {
        ...(origin.kind === "actor" && origin.sessionId !== undefined
          ? { sessionId: origin.sessionId }
          : {}),
        ...(answerer.kind === "agent"
          ? { executionId: answerer.executionId }
          : origin.kind === "actor" && origin.executionId !== undefined
            ? { executionId: origin.executionId }
            : {}),
      };
      this.#event(
        at,
        "proposal.decided",
        "proposal",
        id,
        {
          approvalId,
          digest: row.digest,
          gate,
          policy,
          source,
          decision,
          answererKind: answerer.kind,
        },
        correlation,
      );
      if (decision === "reject") return freeze({ status });
      if (task) {
        const taskId = this.#registerTask(row, task, at);
        this.#event(
          at,
          "task.registered",
          "task",
          taskId,
          { proposalId: id, goalId: task.goalId },
          correlation,
        );
        return freeze({ status, taskId });
      }
      const goalId = randomUUID();
      this.#run(
        "INSERT INTO goals VALUES (?, ?, ?, ?, 'active', ?)",
        goalId,
        id,
        row.contentJson,
        row.digest,
        at,
      );
      this.#event(
        at,
        "goal.registered",
        "goal",
        goalId,
        { proposalId: id },
        correlation,
      );
      return freeze({ status, goalId });
    });
  }

  createExecution(request: {
    actor: ActorKind;
    mode: string;
    requestedBy: Origin;
    goalId?: string;
    taskId?: string;
  }) {
    const input = fields(request, [
      "actor",
      "mode",
      "requestedBy",
      "goalId",
      "taskId",
    ]);
    const actor = oneOf(input.actor, ACTOR_KINDS);
    const mode = identifier(input.mode);
    const origin = parseOrigin(input.requestedBy);
    if (
      mode === "approval" &&
      origin.kind !== "host" &&
      (actor === "Reviewer" || origin.kind === "actor")
    )
      throw new OrchestratorStoreError("approval-forbidden");
    const taskId = Object.hasOwn(input, "taskId")
      ? identifier(input.taskId)
      : null;
    const requestedGoalId = Object.hasOwn(input, "goalId")
      ? identifier(input.goalId)
      : null;
    return this.#write((at) => {
      const task = taskId === null ? null : required(this.#task(taskId));
      if (task && requestedGoalId !== null && requestedGoalId !== task.goalId)
        throw new OrchestratorStoreError("context-mismatch");
      const goalId = task?.goalId ?? requestedGoalId;
      if (goalId !== null) required(this.#goal(goalId));
      const id = randomUUID();
      this.#run(
        "INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL)",
        id,
        actor,
        mode,
        canonicalJson(origin),
        goalId,
        taskId,
      );
      this.#event(
        at,
        "execution.queued",
        "execution",
        id,
        { actor, goalId, taskId },
        { ...origin, executionId: id },
      );
      return freeze({ id, status: "queued" as const });
    });
  }

  #execution(id: string) {
    return this.#db
      .query<ExecutionRow>(
        `SELECT ${executionColumns} FROM executions WHERE id = ?`,
      )
      .get(id);
  }

  startExecution(executionId: string): void {
    const id = identifier(executionId);
    this.#write((at) => {
      const row = required(this.#execution(id));
      if (row.status !== "queued")
        throw new OrchestratorStoreError("invalid-transition");
      this.#run(
        "UPDATE executions SET status = 'running', started_at = ? WHERE id = ?",
        at,
        id,
      );
      this.#event(
        at,
        "execution.started",
        "execution",
        id,
        {},
        { ...parseOrigin(JSON.parse(row.requestedByJson)), executionId: id },
      );
    });
  }

  finishExecution(
    executionId: string,
    status: FinalExecutionStatus,
    result?: unknown,
  ): void {
    const id = identifier(executionId);
    const next = oneOf(status, finalExecutionStatuses);
    const resultJson =
      result === undefined ? null : canonicalJson(result, 256 * 1024);
    this.#write((at) => {
      const row = required(this.#execution(id));
      if (
        row.status !== "running" &&
        !(row.status === "queued" && next === "cancelled")
      )
        throw new OrchestratorStoreError("invalid-transition");
      this.#run(
        "UPDATE executions SET status = ?, result_json = ?, finished_at = ? WHERE id = ?",
        next,
        resultJson,
        at,
        id,
      );
      this.#event(
        at,
        "execution.finished",
        "execution",
        id,
        { status: next },
        { ...parseOrigin(JSON.parse(row.requestedByJson)), executionId: id },
      );
    });
  }

  startSession(actor: ActorKind, runtimeId: string) {
    const kind = oneOf(actor, ACTOR_KINDS);
    const runtime = identifier(runtimeId);
    return this.#write((at) => {
      const id = randomUUID();
      this.#run(
        "INSERT INTO actor_sessions VALUES (?, ?, ?, 'active', ?, NULL)",
        id,
        kind,
        runtime,
        at,
      );
      this.#event(
        at,
        "session.started",
        "session",
        id,
        { actor: kind },
        { sessionId: id },
      );
      return freeze({ id, status: "active" as const });
    });
  }

  endSession(sessionId: string): void {
    const id = identifier(sessionId);
    this.#write((at) => {
      const row = required(
        this.#db
          .query<{ status: string }>(
            "SELECT status FROM actor_sessions WHERE id = ?",
          )
          .get(id),
      );
      if (row.status !== "active")
        throw new OrchestratorStoreError("invalid-transition");
      this.#run(
        "UPDATE actor_sessions SET status = 'ended', ended_at = ? WHERE id = ?",
        at,
        id,
      );
      this.#event(at, "session.ended", "session", id, {}, { sessionId: id });
    });
  }

  #proposal(id: string) {
    return this.#db
      .query<ProposalRow>(
        `SELECT ${proposalColumns} FROM proposals WHERE id = ?`,
      )
      .get(id);
  }

  getProposal(proposalId: string) {
    const id = identifier(proposalId);
    return this.#read(() => {
      const row = this.#proposal(id);
      return row === null ? null : proposalRecord(row);
    });
  }

  #proposalGate(proposal: ReturnType<typeof proposalRecord>) {
    if (proposal.kind === "goal") return this.#goalPolicy(proposal.content);
    if (proposal.status === "registered")
      return { gate: null, policy: null, source: null, loosening: [] };
    const goal = goalRecord(required(this.#goal(proposal.content.goalId)));
    return this.#taskPolicy(proposal.content, goal.content);
  }

  getProposalDetails(proposalId: string) {
    const id = identifier(proposalId);
    return this.#read(() => {
      const row = this.#proposal(id);
      if (!row) return null;
      const proposal = proposalRecord(row);
      const decision = this.#db
        .query<{
          gate: Gate;
          policy: ApprovalPolicy["policy"];
          source: ApprovalPolicy["source"];
        }>(
          "SELECT gate, policy, policy_source AS source FROM approvals WHERE proposal_id = ?",
        )
        .get(id);
      return freeze({
        ...proposal,
        ...this.#proposalGate(proposal),
        ...decision,
        origin: proposal.source,
      });
    });
  }

  getHostApiStatus() {
    return this.#read(() =>
      this.#db
        .transaction(() => {
          const counts = (table: "goals" | "tasks" | "proposals") =>
            Object.fromEntries(
              this.#db
                .query<{ status: string; count: number }>(
                  `SELECT status, count(*) AS count FROM ${table} GROUP BY status`,
                )
                .all()
                .map(({ status, count }) => [status, count]),
            );
          const pendingProposals = this.#db
            .query<ProposalRow>(
              `SELECT ${proposalColumns} FROM proposals WHERE status = 'pending' ORDER BY rowid DESC LIMIT 20`,
            )
            .all()
            .map((row) => {
              const proposal = proposalRecord(row);
              const { gate, policy } = this.#proposalGate(proposal);
              return {
                id: proposal.id,
                kind: proposal.kind,
                title: proposal.content.title,
                gate,
                policy,
              };
            });
          const recentExecutions = this.#db
            .query<Pick<ExecutionRow, "id" | "actor" | "mode" | "status">>(
              "SELECT id, actor, mode, status FROM executions ORDER BY rowid DESC LIMIT 20",
            )
            .all();
          return freeze({
            goals: counts("goals"),
            tasks: counts("tasks"),
            proposals: counts("proposals"),
            pendingProposals,
            recentExecutions,
          });
        })
        .deferred(),
    );
  }

  listProposals(options: { status?: ProposalStatus } = {}) {
    const input = fields(options, ["status"]);
    const status = Object.hasOwn(input, "status")
      ? oneOf(input.status, proposalStatuses)
      : null;
    return this.#read(() =>
      freeze(
        this.#db
          .query<ProposalRow>(
            `SELECT ${proposalColumns} FROM proposals WHERE (? IS NULL OR status = ?) ORDER BY rowid`,
          )
          .all(status, status)
          .map(proposalRecord),
      ),
    );
  }

  getGoal(goalId: string) {
    const id = identifier(goalId);
    return this.#read(() => {
      const row = this.#goal(id);
      return row === null ? null : goalRecord(row);
    });
  }

  listGoals() {
    return this.#read(() =>
      freeze(
        this.#db
          .query<GoalRow>(
            `SELECT ${registeredColumns} FROM goals ORDER BY rowid`,
          )
          .all()
          .map(goalRecord),
      ),
    );
  }

  listTasks(goalId: string) {
    const id = identifier(goalId);
    return this.#read(() =>
      freeze(
        this.#db
          .query<TaskRow>(
            `SELECT ${taskColumns} FROM tasks WHERE goal_id = ? ORDER BY rowid`,
          )
          .all(id)
          .map(taskRecord),
      ),
    );
  }

  getExecution(executionId: string) {
    const id = identifier(executionId);
    return this.#read(() => {
      const row = this.#execution(id);
      if (!row) return null;
      const { requestedByJson, resultJson, ...execution } = row;
      const result: unknown =
        resultJson === null ? null : JSON.parse(resultJson);
      return freeze({
        ...execution,
        requestedBy: parseOrigin(JSON.parse(requestedByJson)),
        result,
      });
    });
  }

  listEvents(options: { subjectId?: string; limit: number }) {
    const input = fields(options, ["subjectId", "limit"]);
    const subjectId = Object.hasOwn(input, "subjectId")
      ? identifier(input.subjectId)
      : null;
    const limit = integer(input.limit, 1, 1000);
    return this.#read(() =>
      freeze(
        this.#db
          .query<EventRow>(
            `SELECT ${eventColumns} FROM events WHERE (? IS NULL OR subject_id = ?) ORDER BY rowid DESC LIMIT ?`,
          )
          .all(subjectId, subjectId, limit)
          .map(({ data, ...row }) => {
            const eventData: unknown = JSON.parse(data);
            return freeze({ ...row, data: eventData });
          }),
      ),
    );
  }

  effectivePolicy(
    gate: Gate,
    context: { goalId?: string; taskId?: string } = {},
  ): ApprovalPolicy {
    const validGate = oneOf(gate, GATES);
    const input = fields(context, ["goalId", "taskId"]);
    const goalId = Object.hasOwn(input, "goalId")
      ? identifier(input.goalId)
      : null;
    const taskId = Object.hasOwn(input, "taskId")
      ? identifier(input.taskId)
      : null;
    return this.#read(() =>
      this.#db
        .transaction(() => {
          const task =
            taskId === null ? null : taskRecord(required(this.#task(taskId)));
          if (task && goalId !== null && task.goalId !== goalId)
            throw new OrchestratorStoreError("context-mismatch");
          const id = task?.goalId ?? goalId;
          const layers =
            id === null
              ? { defaults: this.#defaults() }
              : this.#goalLayers(goalRecord(required(this.#goal(id))).content);
          return freeze(
            resolvePolicy(validGate, {
              ...layers,
              task: task?.content.policies ?? {},
            }),
          );
        })
        .deferred(),
    );
  }
}
