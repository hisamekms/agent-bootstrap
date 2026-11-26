import {
  GOAL_POLICIES,
  TASK_POLICIES,
  RULE_GATES,
  POLICY_INVARIANTS,
  resolveDelegation,
  validateDelegationRules,
  type DelegationRule,
  type DiffSize,
  type EffectivePolicy,
  type GoalPolicy,
  type PolicyInvariant,
  type RuleFacts,
  type RuleGate,
  type TaskPolicy,
} from "./delegation.ts";
import type { InboxRow } from "./inbox.ts";
import { readPathViolations, type PathViolation } from "./path-violations.ts";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import {
  ACTOR_KINDS,
  GATES,
  ContractError,
  allowsPath,
  canonicalJson,
  contentDigest,
  fields,
  fitsScope,
  freeze,
  gitCommit,
  goalBranch,
  identifier,
  integer,
  oneOf,
  requestedLoosening,
  resolvePolicy,
  taskLimitReasons,
  validateGoalContent,
  validateIntegrationContent,
  validatePolicies,
  validateTaskContent,
  type ActorKind,
  type Gate,
  type GoalContent,
  type IntegrationContent,
  type Policy,
  type PolicyLayers,
  type PolicySet,
  type TaskContent,
} from "./model.ts";

import {
  compareTokenBudget,
  emptyTokenUsage,
  readTokenReport,
} from "./token-usage.ts";

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
type HumanDelegate = {
  agent: "claude-code";
  session: string;
  authorization: string;
};
export type Answerer =
  | { kind: "human"; delegate?: HumanDelegate; channel?: never }
  | { kind: "human"; channel: "operator-ui"; delegate?: never }
  | { kind: "agent"; executionId: string; model: string };

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

export type StoreErrorCode =
  | "open-failed"
  | "closed"
  | "write-failed"
  | "read-failed"
  | "not-found"
  | "stale-digest"
  | "stale-policy"
  | "invalid-transition"
  | "task-retry-limit"
  | "task-retry-changed"
  | "approval-forbidden"
  | "goal-inactive"
  | "goal-head-unavailable"
  | "goal-busy"
  | "goal-discard-record-failed"
  | "goal-base-ineligible"
  | "goal-base-stale"
  | "goal-base-record-failed"
  | "goal-export-record-failed"
  | "export-head-mismatch"
  | "task-constraints"
  | "context-mismatch"
  | "session-busy"
  | "reconcile-changed"
  | "integration-uncertain";

export class OrchestratorStoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode) {
    super(
      code === "session-busy"
        ? "Local orchestrator is busy. If the launcher stopped, use the operator CLI reconcile command."
        : `Local orchestrator store: ${code}`,
    );
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
type ApprovalPolicy = EffectivePolicy;
type SettingsOrigin = "cli" | "operator-ui";

const applicationId = 0x4c4f5231;
const schemaVersion = 7;
const refsMigration = `
  ALTER TABLE goals ADD COLUMN ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE tasks ADD COLUMN ref TEXT NOT NULL DEFAULT '';
  WITH numbered AS MATERIALIZED (
    SELECT id, 'G' || row_number() OVER (ORDER BY created_at, rowid) AS ref FROM goals
  )
  UPDATE goals SET ref = (SELECT ref FROM numbered WHERE numbered.id = goals.id);
  WITH numbered AS MATERIALIZED (
    SELECT t.id, g.ref || '-' ||
      row_number() OVER (PARTITION BY t.goal_id ORDER BY t.created_at, t.rowid) AS ref
    FROM tasks t JOIN goals g ON g.id = t.goal_id
  )
  UPDATE tasks SET ref = (SELECT ref FROM numbered WHERE numbered.id = tasks.id);
  CREATE UNIQUE INDEX goals_ref ON goals(ref COLLATE NOCASE);
  CREATE UNIQUE INDEX tasks_ref ON tasks(ref COLLATE NOCASE);
  ${["goals", "tasks"]
    .map(
      (table) => `
    CREATE TRIGGER ${table}_ref_required BEFORE INSERT ON ${table}
      WHEN NEW.ref = '' BEGIN SELECT RAISE(ABORT, 'ref required'); END;
    CREATE TRIGGER ${table}_ref_immutable BEFORE UPDATE OF ref ON ${table}
      WHEN NEW.ref <> OLD.ref BEGIN SELECT RAISE(ABORT, 'immutable ref'); END;
  `,
    )
    .join("")}
`;
const inboxSeenSchema = "CREATE TABLE inbox_seen (id TEXT PRIMARY KEY) STRICT;";
export const MAX_TASK_RETRIES = 3;
const proposalColumnsSql = `
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('goal', 'task', 'integration')),
    content_json TEXT NOT NULL, digest TEXT NOT NULL, source_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'registered')),
    created_at TEXT NOT NULL, decided_at TEXT
  `;
const taskColumnsSql = `
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
    proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    content_json TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('registered', 'running', 'awaiting-integration', 'succeeded', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0), created_at TEXT NOT NULL
  `;
const approvalRunColumnsSql = `
    proposal_id TEXT NOT NULL REFERENCES proposals(id),
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
    PRIMARY KEY (proposal_id, execution_id)
  `;
const approvalColumnsSql = `
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    gate TEXT NOT NULL CHECK (gate IN ('goal-registration', 'task-registration', 'integration')),
    digest TEXT NOT NULL, policy TEXT NOT NULL CHECK (policy IN ('human', 'agent')),
    policy_source TEXT NOT NULL CHECK (policy_source IN ('default', 'request', 'goal', 'task', 'invariant', 'operator-task', 'operator-goal', 'rule')),
    answerer_kind TEXT NOT NULL CHECK (answerer_kind IN ('human', 'agent')), answerer_json TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')), at TEXT NOT NULL,
    policy_details_json TEXT, reasons_json TEXT
  `;
const delegationSchema = `
  CREATE TABLE delegation_rules (id INTEGER PRIMARY KEY CHECK (id = 1), rules_json TEXT NOT NULL) STRICT;
  INSERT INTO delegation_rules VALUES (1, '[]');
  CREATE TABLE goal_policy (
    goal_id TEXT NOT NULL REFERENCES goals(id), gate TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (goal_id, gate)
  ) STRICT;
  CREATE TABLE task_policy (task_id TEXT PRIMARY KEY REFERENCES tasks(id), value TEXT NOT NULL) STRICT;
  CREATE TABLE integration_policy_facts (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
    changed_files INTEGER NOT NULL, changed_lines INTEGER
  ) STRICT;
  CREATE INDEX events_decisions_at ON events(at) WHERE kind = 'proposal.decided';
`;
const schema = `
  ${inboxSeenSchema}
  CREATE TABLE project_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1), policies_json TEXT NOT NULL,
    explicit_json TEXT NOT NULL DEFAULT '[]'
  ) STRICT;
  INSERT INTO project_policy (id, policies_json) VALUES (1, '{"goal-registration":"human","task-registration":"human","integration":"human"}');
  CREATE TABLE proposals (${proposalColumnsSql}) STRICT;
  CREATE TABLE goals (
    id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    content_json TEXT NOT NULL, digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'done', 'cancelled')), created_at TEXT NOT NULL,
    planning_commit TEXT, base_commit TEXT
  ) STRICT;
  CREATE TABLE tasks (${taskColumnsSql}) STRICT;
  CREATE INDEX tasks_goal ON tasks(goal_id);
  CREATE TABLE approvals (${approvalColumnsSql}) STRICT;
  CREATE TABLE executions (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, mode TEXT NOT NULL, requested_by_json TEXT NOT NULL,
    goal_id TEXT REFERENCES goals(id), task_id TEXT REFERENCES tasks(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed-out', 'cancelled')),
    result_json TEXT, started_at TEXT, finished_at TEXT
  ) STRICT;
  CREATE TABLE proposal_approval_runs (${approvalRunColumnsSql}) STRICT;
  CREATE TABLE actor_sessions (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, runtime_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'ended')), started_at TEXT NOT NULL, ended_at TEXT,
    snapshot_commit TEXT
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
  ${delegationSchema}
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

export function parseHumanDelegate(value: unknown): HumanDelegate {
  const { agent, session, authorization } = fields(value, [
    "agent",
    "session",
    "authorization",
  ]);
  if (
    typeof authorization !== "string" ||
    authorization.length < 1 ||
    authorization.length > 500 ||
    /\p{Cc}/u.test(authorization)
  )
    throw new ContractError();
  return {
    agent: oneOf(agent, ["claude-code"]),
    session: identifier(session),
    authorization,
  };
}

function parseAnswerer(value: unknown): Answerer {
  const input = fields(value, [
    "kind",
    "delegate",
    "channel",
    "executionId",
    "model",
  ]);
  if (input.kind === "human") {
    fields(input, ["kind", "delegate", "channel"]);
    if (Object.hasOwn(input, "channel")) {
      fields(input, ["kind", "channel"]);
      return { kind: "human", channel: oneOf(input.channel, ["operator-ui"]) };
    }
    return {
      kind: "human",
      ...(Object.hasOwn(input, "delegate") && {
        delegate: parseHumanDelegate(input.delegate),
      }),
    };
  }
  fields(input, ["kind", "executionId", "model"]);
  return {
    kind: oneOf(input.kind, ["agent"]),
    executionId: identifier(input.executionId),
    model: identifier(input.model),
  };
}

type ProposalRow = {
  id: string;
  kind: "goal" | "task" | "integration";
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
  ref: string;
  contentJson: string;
  digest: string;
  createdAt: string;
};
type GoalRow = RegisteredRow & {
  status: "active" | "done" | "cancelled";
  planningCommit: string | null;
  baseCommit: string | null;
};
type TaskRow = RegisteredRow & {
  goalId: string;
  status:
    | "registered"
    | "running"
    | "awaiting-integration"
    | "succeeded"
    | "failed"
    | "cancelled";
  attempts: number;
  retries: number;
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
  "ref, id, proposal_id AS proposalId, content_json AS contentJson, digest, status, created_at AS createdAt";
const goalColumns = `${registeredColumns}, planning_commit AS planningCommit, base_commit AS baseCommit`;
const taskColumns = `${registeredColumns}, goal_id AS goalId, attempts,
  (SELECT count(*) FROM events WHERE subject_id = tasks.id AND subject_kind = 'task'
    AND kind = 'task.retried') AS retries`;
const executionColumns =
  "id, actor, mode, requested_by_json AS requestedByJson, goal_id AS goalId, task_id AS taskId, status, result_json AS resultJson, started_at AS startedAt, finished_at AS finishedAt";
const eventColumns =
  "id, at, kind, subject_kind AS subjectKind, subject_id AS subjectId, session_id AS sessionId, execution_id AS executionId, data";

// The action count and inbox share the same resolution and budget predicates.
const laterTaskStatus = `EXISTS (
  SELECT 1 FROM events AS later
  WHERE later.subject_id = t.id AND later.subject_kind = 'task'
    AND later.kind = 'task.status' AND later.rowid > e.rowid
    AND json_extract(later.data, '$.status') IN (
      'running', 'awaiting-integration', 'failed', 'succeeded', 'cancelled'
    )
)`;
const taskBudgetResolved = `t.status IN ('succeeded', 'cancelled') OR EXISTS (
  SELECT 1 FROM events AS retry
  WHERE retry.subject_id = t.id AND retry.kind = 'task.retried'
    AND retry.rowid > (
      SELECT queued.rowid FROM events AS queued
      WHERE queued.subject_id = x.id AND queued.subject_kind = 'execution'
        AND queued.kind = 'execution.queued' LIMIT 1
    )
)`;
const executionOverBudget = `(
  (json_type(x.result_json, '$.tokens') = 'integer'
    AND json_extract(x.result_json, '$.tokens') <= 9007199254740991
    AND json_extract(x.result_json, '$.tokens') > coalesce(
      json_extract(t.content_json, '$.budgets.maxTokens'),
      json_extract(g.content_json, '$.scope.budgets.maxTokens')
    ))
  OR EXISTS (
    SELECT 1 FROM events AS budget
    WHERE budget.subject_id = t.id AND budget.kind = 'task.budget-exceeded'
      AND budget.execution_id = x.id
  )
)`;

function proposalRecord({
  contentJson,
  sourceJson,
  kind,
  ...row
}: ProposalRow) {
  const raw: unknown = JSON.parse(contentJson);
  const source = parseOrigin(JSON.parse(sourceJson));
  switch (kind) {
    case "goal":
      return freeze({
        ...row,
        kind,
        source,
        content: validateGoalContent(raw),
      });
    case "task":
      return freeze({
        ...row,
        kind,
        source,
        content: validateTaskContent(raw),
      });
    case "integration":
      return freeze({
        ...row,
        kind,
        source,
        content: validateIntegrationContent(raw),
      });
  }
}

function integrationInvariant(
  proposal: ReturnType<typeof proposalRecord>,
): PolicyInvariant | undefined {
  if (proposal.kind !== "integration") return;
  if (proposal.content.verified !== true) return "integration-verification";
  if (proposal.content.symlinks?.length !== 0) return "integration-symlinks";
}

function proposalAnswerRequirements(
  proposal: ReturnType<typeof proposalRecord>,
  policy: ApprovalPolicy["policy"] | null,
  loosening: readonly Gate[],
  source?: ApprovalPolicy["source"] | null,
) {
  const humanAnswerRequired =
    source === "invariant" ||
    (policy === "agent" &&
      source === "goal" &&
      proposal.kind === "task" &&
      proposal.content.policies?.["task-registration"] === "human") ||
    integrationInvariant(proposal) !== undefined;
  return {
    ...(policy === "agent" &&
      loosening.length > 0 && { humanApprovalRequired: true }),
    ...(humanAnswerRequired && { humanAnswerRequired: true }),
  };
}

function permitsAgentAnswer(
  origin: Origin,
  {
    policy,
    humanApprovalRequired,
    humanAnswerRequired,
  }: ReturnType<typeof proposalAnswerRequirements> & {
    policy: ApprovalPolicy["policy"] | null;
  },
  decision: Decision,
): boolean {
  return (
    policy === "agent" &&
    !humanAnswerRequired &&
    !(decision === "approve" && humanApprovalRequired) &&
    !(origin.kind === "actor" && origin.actor === "Concierge")
  );
}

export function permitsPanelAnswer(
  origin: Origin,
  requirements: Parameters<typeof permitsAgentAnswer>[1],
  decision: Decision,
): boolean {
  // The panel handles decisions reserved to a human, including gate invariants.
  return (
    requirements.policy !== null &&
    !permitsAgentAnswer(origin, requirements, decision)
  );
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
  ref?: string;
}>;
type GoalReceipt = ProposalReceipt &
  ApprovalPolicy &
  Readonly<{ gate: "goal-registration" }>;
type RegisteredReceipt = Omit<ProposalReceipt, "loosening"> &
  Readonly<{
    status: "registered";
    taskId: string;
    ref: string;
    autoRegistered: true;
    reason: "in-scope";
  }>;

type Reconciliation = {
  sessions: string[];
  executions: { id: string; status: "queued" | "running" }[];
  tasks: string[];
};

export class OrchestratorStore {
  readonly #db: Connection;
  #closed = false;
  #writeFailed = false;
  #changingGoalBranch = false;

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
        "PRAGMA busy_timeout=1000; PRAGMA foreign_keys=OFF; PRAGMA synchronous=FULL",
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
            connection.exec(
              `${schema} ${refsMigration} PRAGMA application_id=${applicationId}; PRAGMA user_version=${schemaVersion}`,
            );
          } else if (id !== applicationId) {
            throw new Error();
          } else {
            const version = connection
              .query<{ user_version: number }>("PRAGMA user_version")
              .get()?.user_version;
            if (version === 0) {
              // SQLite requires rebuilding tables to extend CHECK constraints.
              for (const [table, definition] of [
                ["proposals", proposalColumnsSql],
                ["tasks", taskColumnsSql],
              ]) {
                connection.exec(`
                  CREATE TABLE next_${table} (${definition}) STRICT;
                  INSERT INTO next_${table} SELECT * FROM ${table};
                  DROP TABLE ${table};
                  ALTER TABLE next_${table} RENAME TO ${table};
                `);
              }
              connection.exec(`
                CREATE INDEX tasks_goal ON tasks(goal_id);
                CREATE TABLE integration_approval_runs (${approvalRunColumnsSql}) STRICT;
              `);
              if (connection.query("PRAGMA foreign_key_check").get())
                throw new Error();
            } else if (version === 2) {
              connection.exec(`
                CREATE TABLE next_integration_approval_runs (${approvalRunColumnsSql}) STRICT;
                INSERT INTO next_integration_approval_runs SELECT * FROM integration_approval_runs;
                DROP TABLE integration_approval_runs;
                ALTER TABLE next_integration_approval_runs RENAME TO integration_approval_runs;
              `);
              if (connection.query("PRAGMA foreign_key_check").get())
                throw new Error();
            } else if (
              version !== 3 &&
              version !== 4 &&
              version !== 5 &&
              version !== 6 &&
              version !== schemaVersion
            ) {
              throw new Error();
            }
            if (version === 0 || version === 2 || version === 3) {
              connection.exec(`
                ALTER TABLE actor_sessions ADD COLUMN snapshot_commit TEXT;
                ALTER TABLE goals ADD COLUMN planning_commit TEXT;
                ALTER TABLE goals ADD COLUMN base_commit TEXT;
              `);
            }
            if (version !== 6 && version !== schemaVersion) {
              if (version !== 5) connection.exec(inboxSeenSchema);
              // Legacy defaults keep their precedence until explicitly set again.
              connection.exec(`
                ${delegationSchema}
                ALTER TABLE project_policy ADD COLUMN explicit_json TEXT NOT NULL DEFAULT '[]';
                ALTER TABLE integration_approval_runs RENAME TO proposal_approval_runs;
                CREATE TABLE next_approvals (${approvalColumnsSql}) STRICT;
                INSERT INTO next_approvals SELECT *, NULL, NULL FROM approvals;
                DROP TABLE approvals;
                ALTER TABLE next_approvals RENAME TO approvals;
              `);
              if (connection.query("PRAGMA foreign_key_check").get())
                throw new Error();
            }
            if (version !== schemaVersion)
              connection.exec(
                `${refsMigration} PRAGMA user_version=${schemaVersion};`,
              );
          }
        })
        .immediate();
      connection.exec("PRAGMA foreign_keys=ON");
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
    if (this.#writeFailed || this.#changingGoalBranch)
      throw new OrchestratorStoreError("write-failed");
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

  recordConciergeDraft(characters: number, sha256: string): void {
    this.#write((at) => {
      this.#event(at, "concierge.draft-authorized", "actor", "Concierge", {
        origin: { kind: "operator", channel: "operator-ui" },
        characters,
        sha256,
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

  #explicitDefaults(): Gate[] {
    return JSON.parse(
      required(
        this.#db
          .query<{ json: string }>(
            "SELECT explicit_json AS json FROM project_policy WHERE id = 1",
          )
          .get(),
      ).json,
    ) as Gate[];
  }

  setProjectDefaults(
    policies: PolicySet,
    by: Operator,
    origin: SettingsOrigin = "cli",
  ): void {
    oneOf(origin, ["cli", "operator-ui"]);
    const requested = validatePolicies(policies);
    if (parseOrigin(by).kind !== "operator") throw new ContractError();
    this.#write((at) => {
      const before = this.#defaults();
      const defaults = { ...before, ...requested };
      const beforeExplicit = this.#explicitDefaults();
      const afterExplicit = GATES.filter(
        (gate) =>
          beforeExplicit.includes(gate) || Object.hasOwn(requested, gate),
      );
      this.#run(
        "UPDATE project_policy SET policies_json = ?, explicit_json = ? WHERE id = 1",
        canonicalJson(defaults),
        canonicalJson(afterExplicit),
      );
      this.#event(at, "project.defaults-set", "project", "project", {
        defaults,
        before,
        after: defaults,
        beforeExplicit,
        afterExplicit,
        origin,
      });
    });
  }

  #rules(): DelegationRule[] {
    return JSON.parse(
      required(
        this.#db
          .query<{ json: string }>(
            "SELECT rules_json AS json FROM delegation_rules WHERE id = 1",
          )
          .get(),
      ).json,
    ) as DelegationRule[];
  }

  #goalPolicyOverride(goalId: string, gate: RuleGate): GoalPolicy {
    return (
      this.#db
        .query<{ value: GoalPolicy }>(
          "SELECT value FROM goal_policy WHERE goal_id = ? AND gate = ?",
        )
        .get(goalId, gate)?.value ?? "inherit"
    );
  }

  #taskPolicyOverride(taskId: string): TaskPolicy {
    return (
      this.#db
        .query<{ value: TaskPolicy }>(
          "SELECT value FROM task_policy WHERE task_id = ?",
        )
        .get(taskId)?.value ?? "rule"
    );
  }

  goalPolicyOverrides(goalId: string) {
    return this.#read(() => {
      const id = this.#goalId(identifier(goalId));
      return {
        "task-registration": this.#goalPolicyOverride(id, "task-registration"),
        integration: this.#goalPolicyOverride(id, "integration"),
      };
    });
  }

  taskPolicyOverride(taskId: string): TaskPolicy {
    return this.#read(() =>
      this.#taskPolicyOverride(this.#taskId(identifier(taskId))),
    );
  }

  policySettings() {
    return this.#read(() =>
      this.#db
        .transaction(() => {
          const hits = this.#db
            .query<{ ruleId: string; hits: number }>(
              `
        SELECT json_extract(data, '$.ruleId') AS ruleId, count(*) AS hits FROM events
        WHERE kind = 'proposal.decided' AND at >= ? AND json_extract(data, '$.source') = 'rule'
        GROUP BY ruleId
      `,
            )
            .all(new Date(Date.now() - 7 * 86_400_000).toISOString());
          const counts = new Map(
            hits.map(({ ruleId, hits }) => [ruleId, hits]),
          );
          const rules = this.#rules();
          return freeze({
            defaults: this.#defaults(),
            explicitDefaults: this.#explicitDefaults(),
            rulesRevision: contentDigest(rules),
            rules: rules.map((rule) => ({
              ...rule,
              hitsLast7Days: counts.get(rule.id) ?? 0,
            })),
            invariants: POLICY_INVARIANTS,
          });
        })
        .deferred(),
    );
  }

  policyOverrides() {
    return this.#read(() => ({
      goals: this.#db
        .query<{ goalId: string; gate: RuleGate; value: GoalPolicy }>(
          "SELECT goal_id AS goalId, gate, value FROM goal_policy WHERE value <> 'inherit' ORDER BY goal_id, gate",
        )
        .all(),
      tasks: this.#db
        .query<{ taskId: string; value: TaskPolicy }>(
          "SELECT task_id AS taskId, value FROM task_policy WHERE value <> 'rule' ORDER BY task_id",
        )
        .all(),
    }));
  }

  setRules(
    rules: unknown,
    origin: SettingsOrigin,
    expectedRevision?: string,
  ): void {
    const after = validateDelegationRules(rules);
    oneOf(origin, ["cli", "operator-ui"]);
    this.#write((at) => {
      const current = this.#rules();
      if (
        expectedRevision !== undefined &&
        contentDigest(current) !== expectedRevision
      )
        throw new OrchestratorStoreError("stale-policy");
      const before = new Map(current.map((rule) => [rule.id, rule]));
      const next = new Map(after.map((rule) => [rule.id, rule]));
      this.#run(
        "UPDATE delegation_rules SET rules_json = ? WHERE id = 1",
        canonicalJson(after),
      );
      for (const id of new Set([...before.keys(), ...next.keys()])) {
        const prior = before.get(id) ?? null;
        const rule = next.get(id) ?? null;
        if (canonicalJson(prior) !== canonicalJson(rule))
          this.#event(at, "project.rule-set", "project", "project", {
            ruleId: id,
            origin,
            before: prior,
            after: rule,
          });
      }
    });
  }

  setGoalPolicy(
    goalId: string,
    gate: RuleGate,
    value: GoalPolicy,
    origin: SettingsOrigin,
    expected?: GoalPolicy,
  ): void {
    oneOf(gate, RULE_GATES);
    oneOf(value, GOAL_POLICIES);
    oneOf(origin, ["cli", "operator-ui"]);
    this.#write((at) => {
      const { id } = required(this.#goal(identifier(goalId)));
      const before = this.#goalPolicyOverride(id, gate);
      if (expected !== undefined && expected !== before)
        throw new OrchestratorStoreError("stale-policy");
      this.#run(
        "INSERT INTO goal_policy VALUES (?, ?, ?) ON CONFLICT (goal_id, gate) DO UPDATE SET value = excluded.value",
        id,
        gate,
        value,
      );
      this.#event(at, "goal.policy-set", "goal", id, {
        gate,
        origin,
        before,
        after: value,
      });
    });
  }

  setTaskIntegrationPolicy(
    taskId: string,
    value: TaskPolicy,
    origin: SettingsOrigin,
    expected?: TaskPolicy,
  ): void {
    oneOf(value, TASK_POLICIES);
    oneOf(origin, ["cli", "operator-ui"]);
    this.#write((at) => {
      const { id } = required(this.#task(identifier(taskId)));
      const before = this.#taskPolicyOverride(id);
      if (expected !== undefined && expected !== before)
        throw new OrchestratorStoreError("stale-policy");
      this.#run(
        "INSERT INTO task_policy VALUES (?, ?) ON CONFLICT (task_id) DO UPDATE SET value = excluded.value",
        id,
        value,
      );
      this.#event(at, "task.policy-set", "task", id, {
        origin,
        before,
        after: value,
      });
    });
  }

  changeVerification(digest: string | null, apply: () => boolean): boolean {
    if (digest !== null && !/^[a-f0-9]{64}$/.test(digest))
      throw new ContractError();
    const data = { changeId: randomUUID(), digest };
    this.#write((at) => {
      this.#event(
        at,
        "project.verification-change-authorized",
        "project",
        "project",
        data,
      );
    });
    // Commit authorization first, then serialize the comparison, file update
    // and completion event with other CLI processes using this database.
    return this.#write((at) => {
      if (!apply()) return false;
      this.#event(
        at,
        digest === null
          ? "project.verification-cleared"
          : "project.verification-set",
        "project",
        "project",
        data,
      );
      return true;
    });
  }

  #newProposal(
    kind: ProposalRow["kind"],
    content: GoalContent | TaskContent | IntegrationContent,
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

  #goalPolicy(content: GoalContent, origin: Origin) {
    const gate = "goal-registration";
    const layers = { defaults: this.#defaults() };
    const request = content.policies ?? {};
    const loosening = requestedLoosening(layers, request);
    return {
      gate,
      loosening,
      ...this.#resolveGate(
        gate,
        loosening.includes(gate) ? layers : { ...layers, request },
        { invariant: this.#proposalInvariant(origin) },
      ),
    } as const;
  }

  #goalLayers(goal: GoalContent): PolicyLayers {
    return { defaults: this.#defaults(), goal: goal.policies ?? {} };
  }

  #proposalInvariant(origin: Origin): PolicyInvariant | undefined {
    if (origin.kind === "actor" && origin.actor === "Concierge")
      return "concierge-proposal";
  }

  #resolveGate(
    gate: Gate,
    layers: PolicyLayers,
    context: {
      goalId?: string;
      taskId?: string;
      invariant?: PolicyInvariant | undefined;
      facts?: RuleFacts | undefined;
    } = {},
  ) {
    return resolveDelegation(gate, {
      fallback: resolvePolicy(
        gate,
        this.#explicitDefaults().includes(gate)
          ? { defaults: layers.defaults }
          : layers,
      ),
      invariant: context.invariant,
      task:
        gate === "integration" && context.taskId
          ? this.#taskPolicyOverride(context.taskId)
          : undefined,
      goal:
        gate !== "goal-registration" && context.goalId
          ? this.#goalPolicyOverride(context.goalId, gate)
          : undefined,
      rules: context.facts ? this.#rules() : [],
      facts: context.facts,
    });
  }

  #taskPolicy(
    task: TaskContent,
    goal: GoalContent,
    origin: Origin,
    inScope: boolean,
  ) {
    const gate = "task-registration";
    const layers = this.#goalLayers(goal);
    const facts = {
      paths: task.paths,
      maxTokens: task.budgets.maxTokens,
      category:
        origin.kind === "actor" && origin.actor === "Planner"
          ? task.category
          : undefined,
    };
    const answer = this.#resolveGate(gate, layers, {
      goalId: task.goalId,
      facts,
      invariant: inScope ? this.#proposalInvariant(origin) : "scope-exception",
    });
    const loosening = requestedLoosening(layers, task.policies ?? {});
    for (const requested of GATES) {
      if (
        task.policies?.[requested] !== "agent" ||
        loosening.includes(requested)
      )
        continue;
      const prior =
        requested === gate
          ? answer
          : this.#resolveGate(requested, layers, { goalId: task.goalId });
      if (prior.policy === "human") loosening.push(requested);
    }
    return { gate, loosening, ...answer } as const;
  }

  proposeGoal(content: unknown, origin: Origin): GoalReceipt {
    const goal = validateGoalContent(content);
    const source = parseOrigin(origin);
    return this.#write((at) => {
      const policy = this.#goalPolicy(goal, source);
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

  #goalId(key: string): string {
    if (!/^g[0-9]+$/i.test(key)) return key;
    return (
      this.#db
        .query<{ id: string }>(
          "SELECT id FROM goals WHERE ref = ? COLLATE NOCASE",
        )
        .get(key)?.id ?? key
    );
  }

  #taskId(key: string): string {
    if (!/^g[0-9]+-[0-9]+$/i.test(key)) return key;
    return (
      this.#db
        .query<{ id: string }>(
          "SELECT id FROM tasks WHERE ref = ? COLLATE NOCASE",
        )
        .get(key)?.id ?? key
    );
  }

  #goal(id: string) {
    return this.#db
      .query<GoalRow>(`SELECT ${goalColumns} FROM goals WHERE id = ?`)
      .get(this.#goalId(id));
  }

  #task(id: string) {
    return this.#db
      .query<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE id = ?`)
      .get(this.#taskId(id));
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

  #taskDependency(goalId: string, id: string) {
    // A Planner batch pins a proposal ID when an earlier Task needs approval.
    return this.#db
      .query<{ status: TaskRow["status"] }>(
        "SELECT status FROM tasks WHERE goal_id = ? AND (id = ? OR proposal_id = ?)",
      )
      .get(goalId, id, id);
  }

  #hasDependencies(task: TaskContent): boolean {
    return task.dependsOn.every(
      (id) => this.#taskDependency(task.goalId, id) !== null,
    );
  }

  #taskApprovalError(task: TaskContent, goal: ReturnType<typeof goalRecord>) {
    if (goal.status !== "active") return "goal-inactive";
    if (
      taskLimitReasons(goal.content, task, this.#taskCount(task.goalId))
        .length !== 0 ||
      !this.#hasDependencies(task)
    )
      return "task-constraints";
  }

  #registerTask(row: ProposalRow, task: TaskContent, at: string): string {
    const id = randomUUID();
    const goalRef = required(this.#goal(task.goalId)).ref;
    const sequence = this.#db
      .query<{ next: number }>(
        "SELECT coalesce(max(CAST(substr(ref, ?1) AS INTEGER)), 0) + 1 AS next FROM tasks WHERE goal_id = ?2",
      )
      .get(goalRef.length + 2, task.goalId)!.next;
    this.#run(
      "INSERT INTO tasks (id, goal_id, proposal_id, content_json, digest, status, attempts, created_at, ref) VALUES (?, ?, ?, ?, ?, 'registered', 0, ?, ?)",
      id,
      task.goalId,
      row.id,
      row.contentJson,
      row.digest,
      at,
      `${goalRef}-${sequence}`,
    );
    return id;
  }

  proposeTask(
    content: unknown,
    origin: Origin,
  ): PendingReceipt | RegisteredReceipt {
    const input = validateTaskContent(content);
    const source = parseOrigin(origin);
    return this.#write((at) => {
      const goalId = required(this.#goal(input.goalId)).id;
      const dependsOn = input.dependsOn.map((id) => this.#task(id)?.id ?? id);
      if (new Set(dependsOn).size !== dependsOn.length)
        throw new OrchestratorStoreError("task-constraints");
      const task = { ...input, goalId, dependsOn };
      const goal = this.#activeGoal(goalId);
      const scope = fitsScope(goal, task, this.#taskCount(task.goalId));
      const { gate, loosening, ...policy } = this.#taskPolicy(
        task,
        goal,
        source,
        scope.ok,
      );
      const reasons = scope.ok ? [] : scope.reasons;
      if (!this.#hasDependencies(task)) reasons.push("dependsOn");
      if (loosening.length !== 0) reasons.push("policy-loosening");
      if (
        reasons.length === 0 &&
        (policy.source === "operator-goal" ||
          this.#explicitDefaults().includes(gate) ||
          this.#rules().some((rule) => rule.enabled && rule.gate === gate))
      )
        reasons.push("operator-delegation");
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
          ref: required(this.#task(taskId)).ref,
          autoRegistered: true,
          reason: "in-scope",
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
    answer: {
      digest: string;
      decision: Decision;
      answerer: Answerer;
      reasons?: readonly string[];
    },
  ): DecisionReceipt {
    const id = identifier(proposalId);
    const input = fields(answer, ["digest", "decision", "answerer", "reasons"]);
    if (typeof input.digest !== "string") throw new ContractError();
    const decision = oneOf(input.decision, ["approve", "reject"]);
    const answerer = parseAnswerer(input.answerer);
    const reasons = input.reasons;
    if (
      reasons !== undefined &&
      (answerer.kind !== "agent" ||
        !Array.isArray(reasons) ||
        reasons.length > 16 ||
        reasons.some(
          (reason) => typeof reason !== "string" || reason.length > 500,
        ))
    )
      throw new ContractError();
    const reasonsJson = reasons === undefined ? null : canonicalJson(reasons);
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
      const { gate, policy, source, loosening, ...details } =
        this.#proposalGate(proposal);
      if (gate === null || policy === null || source === null)
        throw new OrchestratorStoreError("invalid-transition");
      const integration =
        proposal.kind === "integration" ? proposal.content : null;
      if (integration) this.#checkIntegrationTask(integration, id);
      const task = proposal.kind === "task" ? proposal.content : undefined;
      const origin = proposal.source;
      const requirements = {
        policy,
        ...proposalAnswerRequirements(proposal, policy, loosening, source),
      };
      const setting: EffectivePolicy =
        source !== "invariant" && loosening.length > 0 && decision === "approve"
          ? {
              policy: "human",
              source: "invariant",
              invariant: "policy-loosening",
            }
          : requirements.humanAnswerRequired && policy === "agent"
            ? { policy: "human", source: "request" }
            : { policy, source, ...details };
      if (
        answerer.kind === "human" &&
        answerer.channel === "operator-ui" &&
        !permitsPanelAnswer(origin, requirements, decision)
      )
        throw new OrchestratorStoreError("approval-forbidden");
      if (answerer.kind === "agent") {
        const execution = this.#execution(answerer.executionId);
        const binding = this.#db
          .query<{ proposalId: string }>(
            "SELECT proposal_id AS proposalId FROM proposal_approval_runs WHERE execution_id = ?",
          )
          .get(answerer.executionId);
        // Legacy registration callers can still supply an unbound host Reviewer.
        // Scheduled runs and newly delegated gates always use a pinned proposal.
        const requiresBinding =
          integration !== null ||
          source === "rule" ||
          source === "operator-goal";
        if (
          !permitsAgentAnswer(origin, requirements, decision) ||
          (origin.kind === "actor" &&
            origin.executionId === answerer.executionId) ||
          execution?.actor !== "Reviewer" ||
          execution.mode !== "approval" ||
          execution.status !== "running" ||
          parseOrigin(JSON.parse(execution.requestedByJson)).kind !== "host" ||
          (task && execution.goalId !== task.goalId) ||
          (integration && execution.taskId !== integration.taskId) ||
          ((requiresBinding || binding !== null) && binding?.proposalId !== id)
        )
          throw new OrchestratorStoreError("approval-forbidden");
      }

      if (decision === "approve" && task) {
        const error = this.#taskApprovalError(task, goal!);
        if (error) throw new OrchestratorStoreError(error);
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
        "INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        approvalId,
        id,
        gate,
        row.digest,
        setting.policy,
        setting.source,
        answerer.kind,
        canonicalJson(answerer),
        decision,
        at,
        canonicalJson(setting),
        reasonsJson,
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
          ...setting,
          decision,
          answererKind: answerer.kind,
          ...(answerer.kind === "human" &&
            answerer.channel && {
              origin: { kind: "operator", channel: answerer.channel },
            }),
          ...(answerer.kind === "human" &&
            answerer.delegate && {
              delegated: true,
              agent: answerer.delegate.agent,
              session: answerer.delegate.session,
            }),
        },
        correlation,
      );
      if (integration) {
        if (decision === "reject")
          this.#setTaskStatus(
            integration.taskId,
            "failed",
            "integration-rejected",
            at,
          );
        return freeze({ status });
      }
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
        return freeze({
          status,
          taskId,
          ref: required(this.#task(taskId)).ref,
        });
      }
      const planningCommit =
        origin.kind === "actor" && origin.sessionId
          ? this.#sessionSnapshotCommit(origin.sessionId)
          : null;
      const goalId = randomUUID();
      this.#run(
        `INSERT INTO goals (id, proposal_id, content_json, digest, status, created_at, planning_commit, ref)
         VALUES (?, ?, ?, ?, 'active', ?, ?, (
           SELECT 'G' || (coalesce(max(CAST(substr(ref, 2) AS INTEGER)), 0) + 1) FROM goals
         ))`,
        goalId,
        id,
        row.contentJson,
        row.digest,
        at,
        planningCommit,
      );
      this.#event(
        at,
        "goal.registered",
        "goal",
        goalId,
        { proposalId: id },
        correlation,
      );
      return freeze({ status, goalId, ref: required(this.#goal(goalId)).ref });
    });
  }

  #ready(task: ReturnType<typeof taskRecord>): boolean {
    return (
      task.status === "registered" &&
      task.content.actor === "Executor" &&
      this.#goal(task.goalId)?.status === "active" &&
      !this.#goalIntegrationInProgress(task.goalId) &&
      task.content.dependsOn.every(
        (id) => this.#taskDependency(task.goalId, id)?.status === "succeeded",
      )
    );
  }

  readyTasks(limit: number, excluding: readonly string[]) {
    return this.#read(() => {
      const ready: ReturnType<typeof taskRecord>[] = [];
      if (!limit) return ready;
      for (const row of this.#db
        .query<TaskRow>(
          `SELECT ${taskColumns} FROM tasks WHERE status = 'registered' ORDER BY rowid`,
        )
        .all()) {
        if (excluding.includes(row.id)) continue;
        const task = taskRecord(row);
        if (this.#ready(task)) ready.push(task);
        if (ready.length === limit) break;
      }
      return ready;
    });
  }

  #setTaskStatus(
    id: string,
    status: TaskRow["status"],
    code: string | null,
    at: string,
    proposalId?: string,
    rejectedPaths?: readonly PathViolation[],
  ) {
    this.#run("UPDATE tasks SET status = ? WHERE id = ?", status, id);
    this.#event(at, "task.status", "task", id, {
      status,
      code,
      ...(proposalId && { proposalId }),
      ...(rejectedPaths && { rejectedPaths }),
    });
  }

  claimTask(taskId: string) {
    return this.#write((at) => {
      const task = taskRecord(required(this.#task(identifier(taskId))));
      const { id } = task;
      if (!this.#ready(task)) return null;
      if (!this.#ownsGoalBranch(task.goalId)) {
        this.#setTaskStatus(id, "failed", "branch-collision", at);
        return null;
      }
      this.#setTaskStatus(id, "running", null, at);
      return task;
    });
  }

  failTask(
    taskId: string,
    code: string,
    rejectedPaths?: readonly PathViolation[],
  ) {
    const reason = identifier(code);
    this.#write((at) => {
      const { id, status } = required(this.#task(identifier(taskId)));
      if (status !== "running")
        throw new OrchestratorStoreError("invalid-transition");
      this.#setTaskStatus(id, "failed", reason, at, undefined, rejectedPaths);
    });
  }

  retryTask(
    taskId: string,
    expectedRetries: number,
    channel: SettingsOrigin = "cli",
  ) {
    return this.#write((at) => {
      const task = required(this.#task(identifier(taskId)));
      const { id, ref } = task;
      if (task.retries !== expectedRetries)
        throw new OrchestratorStoreError("task-retry-changed");
      if (task.status !== "failed")
        throw new OrchestratorStoreError("invalid-transition");
      if (required(this.#goal(task.goalId)).status === "cancelled")
        throw new OrchestratorStoreError("goal-inactive");
      if (task.retries >= MAX_TASK_RETRIES)
        throw new OrchestratorStoreError("task-retry-limit");
      const status = "registered";
      const retries = task.retries + 1;
      this.#setTaskStatus(id, status, null, at);
      this.#event(at, "task.retried", "task", id, {
        retries,
        origin: { kind: "operator", channel },
        budgetReset: true,
      });
      return { id, ref, status, retries } as const;
    });
  }

  proposeIntegration(
    value: IntegrationContent,
    reviewedBy: string,
    diffSize?: DiffSize,
  ) {
    const input = validateIntegrationContent(value);
    const executionId = identifier(reviewedBy);
    if (diffSize !== undefined) {
      integer(
        diffSize.changedFiles,
        input.changedPaths.length,
        input.changedPaths.length,
      );
      if (diffSize.changedLines !== null)
        integer(diffSize.changedLines, 0, Number.MAX_SAFE_INTEGER);
    }
    return this.#write((at) => {
      const task = taskRecord(required(this.#task(input.taskId)));
      const content = { ...input, taskId: task.id };
      const execution = required(this.#execution(executionId));
      this.#activeGoal(task.goalId);
      const result = execution.resultJson
        ? JSON.parse(execution.resultJson)
        : null;
      if (
        task.status !== "running" ||
        task.goalId !== content.goalId ||
        execution.taskId !== task.id ||
        execution.actor !== "Reviewer" ||
        execution.mode !== "review" ||
        execution.status !== "succeeded" ||
        result?.review !== "pass" ||
        result.pin?.base !== content.base ||
        result.pin?.candidate !== content.candidate ||
        result.pin?.digest !== content.digest ||
        content.changedPaths.some(
          (path) => !allowsPath(task.content.paths, path),
        )
      )
        throw new OrchestratorStoreError("invalid-transition");
      const row = this.#newProposal(
        "integration",
        content,
        { kind: "host" },
        "pending",
        at,
      );
      this.#run(
        "INSERT INTO integration_policy_facts VALUES (?, ?, ?)",
        row.id,
        content.changedPaths.length,
        diffSize?.changedLines ?? null,
      );
      const {
        gate,
        loosening: _loosening,
        ...policy
      } = this.#proposalGate(proposalRecord(row));
      this.#event(
        at,
        "proposal.created",
        "proposal",
        row.id,
        {
          kind: "integration",
          gate,
          ...policy,
          digest: row.digest,
          taskId: task.id,
          goalId: task.goalId,
        },
        { executionId },
      );
      this.#setTaskStatus(task.id, "awaiting-integration", null, at);
      return this.getProposalDetails(row.id)!;
    });
  }

  #integrationProgress(taskId: string) {
    return this.#db
      .query<{ proposalId: string | null; code: string | null }>(
        `SELECT json_extract(data, '$.proposalId') AS proposalId, json_extract(data, '$.code') AS code
         FROM events WHERE subject_kind = 'task' AND subject_id = ? AND kind = 'task.status'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId);
  }

  #goalIntegrationInProgress(goalId: string) {
    return this.#db
      .query<{ id: string }>(
        "SELECT id FROM tasks WHERE goal_id = ? AND status = 'running'",
      )
      .all(goalId)
      .some(({ id }) => this.#integrationProgress(id)?.proposalId);
  }

  #latestIntegrationProposalId(taskId: string) {
    return this.#db
      .query<{ id: string }>(
        `SELECT id FROM proposals WHERE kind = 'integration'
       AND json_extract(content_json, '$.taskId') = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId)?.id;
  }

  assertGoalScheduling(goalId: string) {
    this.#read(() => {
      if (this.#goalIntegrationInProgress(this.#goalId(identifier(goalId))))
        throw new OrchestratorStoreError("integration-uncertain");
    });
  }

  nextApprovedIntegration(excluded?: ReadonlySet<string>) {
    return this.#read(() => {
      const rows = this.#db
        .query<{ id: string; goalId: string; taskId: string }>(
          `SELECT proposals.id, tasks.id AS taskId, tasks.goal_id AS goalId FROM proposals
         JOIN tasks ON tasks.id = json_extract(proposals.content_json, '$.taskId')
         JOIN goals ON goals.id = tasks.goal_id
         WHERE proposals.kind = 'integration' AND proposals.status = 'approved'
           AND tasks.status = 'awaiting-integration' AND goals.status = 'active'
         ORDER BY proposals.rowid`,
        )
        .all();
      return rows.find(
        ({ goalId, taskId, id }) =>
          !excluded?.has(id) &&
          this.#latestIntegrationProposalId(taskId) === id &&
          !this.#goalIntegrationInProgress(goalId),
      )?.id;
    });
  }

  #approvedIntegration(id: string) {
    const proposal = proposalRecord(required(this.#proposal(id)));
    if (proposal.kind !== "integration" || proposal.status !== "approved")
      throw new OrchestratorStoreError("invalid-transition");
    this.#checkIntegrationTask(proposal.content, proposal.id);
    this.assertGoalScheduling(proposal.content.goalId);
    const approval = this.#db
      .query<{
        id: string;
        digest: string;
        answererJson: string;
        answererKind: Answerer["kind"];
        policy: ApprovalPolicy["policy"];
        decision: Decision;
        gate: Gate;
      }>(
        "SELECT id, digest, answerer_json AS answererJson, answerer_kind AS answererKind, policy, decision, gate FROM approvals WHERE proposal_id = ?",
      )
      .get(id);
    if (
      approval?.decision !== "approve" ||
      approval.gate !== "integration" ||
      approval.digest !== proposal.digest ||
      contentDigest(proposal.content) !== proposal.digest
    )
      throw new OrchestratorStoreError("stale-digest");
    const answerer = parseAnswerer(JSON.parse(approval.answererJson));
    if (
      answerer.kind !== approval.answererKind ||
      (answerer.kind === "agent" &&
        (approval.policy !== "agent" ||
          proposalAnswerRequirements(proposal, "agent", [])
            .humanAnswerRequired))
    )
      throw new OrchestratorStoreError("approval-forbidden");
    const task = taskRecord(required(this.#task(proposal.content.taskId)));
    if (!this.#ownsGoalBranch(task.goalId))
      throw new OrchestratorStoreError("context-mismatch");
    return { proposal, task, approvalId: approval.id, answerer };
  }

  approvedIntegration(id: string) {
    return this.#read(() =>
      this.#db.transaction(() => this.#approvedIntegration(id)).deferred(),
    );
  }

  beginIntegration(id: string, digest: string, approvalId: string) {
    this.#write((at) => {
      const current = this.#approvedIntegration(id);
      if (
        current.proposal.digest !== digest ||
        current.approvalId !== approvalId
      )
        throw new OrchestratorStoreError("stale-digest");
      this.#setTaskStatus(
        current.task.id,
        "running",
        "integration-in-progress",
        at,
        id,
      );
    });
  }

  failIntegrationApprovalForCredentialLeak(id: string) {
    this.#write((at) => {
      const row = this.#proposal(identifier(id));
      if (!row || row.kind !== "integration" || row.status !== "pending")
        return;
      const proposal = proposalRecord(row);
      if (proposal.kind !== "integration") return;
      const task = required(this.#task(proposal.content.taskId));
      if (
        task.status === "awaiting-integration" &&
        this.#latestIntegrationProposalId(task.id) === id
      ) {
        this.#run(
          "UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?",
          at,
          id,
        );
        this.#event(at, "proposal.blocked", "proposal", id, {
          code: "credential-leak",
          taskId: task.id,
        });
        this.#setTaskStatus(task.id, "failed", "credential-leak", at);
      }
    });
  }

  rejectApprovedIntegration(id: string, code: string) {
    this.#write((at) => {
      const proposal = proposalRecord(required(this.#proposal(id)));
      if (proposal.kind !== "integration" || proposal.status !== "approved")
        throw new OrchestratorStoreError("invalid-transition");
      const task = required(this.#task(proposal.content.taskId));
      if (
        task.status !== "awaiting-integration" ||
        this.#latestIntegrationProposalId(task.id) !== id
      )
        throw new OrchestratorStoreError("invalid-transition");
      this.#setTaskStatus(task.id, "failed", identifier(code), at);
    });
  }

  #integrationSucceeded(
    at: string,
    id: string,
    content: IntegrationContent,
    reconciled = false,
  ) {
    const { taskId, branch, base, candidate } = content;
    this.#setTaskStatus(taskId, "succeeded", null, at);
    this.#event(at, "task.integrated", "task", taskId, {
      proposalId: id,
      branch,
      base,
      head: candidate,
      ...(reconciled && { reconciled }),
    });
  }

  finishIntegration(
    id: string,
    outcome: "completed" | "denied" | "uncertain",
    code: string,
  ) {
    this.#write((at) => {
      const proposal = proposalRecord(required(this.#proposal(id)));
      if (proposal.kind !== "integration" || proposal.status !== "approved")
        throw new OrchestratorStoreError("invalid-transition");
      const { taskId } = proposal.content;
      if (
        required(this.#task(taskId)).status !== "running" ||
        this.#integrationProgress(taskId)?.proposalId !== id
      )
        throw new OrchestratorStoreError("invalid-transition");
      if (outcome === "completed")
        this.#integrationSucceeded(at, id, proposal.content);
      else if (outcome === "uncertain")
        this.#setTaskStatus(taskId, "running", "integration-uncertain", at, id);
      else this.#setTaskStatus(taskId, "failed", identifier(code), at);
    });
  }

  goalIntegrationHead(goalId: string) {
    return this.#read(
      () =>
        this.#db
          .query<{ head: string }>(
            `SELECT json_extract(events.data, '$.head') AS head FROM events
       JOIN tasks ON tasks.id = events.subject_id
       WHERE events.kind = 'task.integrated' AND events.subject_kind = 'task' AND tasks.goal_id = ?
       ORDER BY events.rowid DESC LIMIT 1`,
          )
          .get(this.#goalId(identifier(goalId)))?.head ?? null,
    );
  }

  auditGoalExport(
    goalId: string,
    branch: string,
    from: string | null,
    to: string,
    completed: boolean,
  ) {
    this.#write((at) => {
      const goal = required(this.#goal(identifier(goalId)));
      const { id } = goal;
      if (!this.#ownsGoalBranch(id) || branch !== goalBranch(id))
        throw new OrchestratorStoreError("context-mismatch");
      if (!completed) {
        if (goal.status === "cancelled")
          throw new OrchestratorStoreError("goal-inactive");
        if (this.#goalIntegrationInProgress(id))
          throw new OrchestratorStoreError("integration-uncertain");
        if ((this.goalIntegrationHead(id) ?? goal.baseCommit) !== to)
          throw new OrchestratorStoreError("export-head-mismatch");
      }
      this.#event(
        at,
        completed ? "goal.exported" : "goal.export-authorized",
        "goal",
        id,
        {
          branch,
          from: from === null ? null : gitCommit(from),
          to: gitCommit(to),
        },
      );
    });
  }

  pendingIntegrations(goalId?: string) {
    const id = goalId === undefined ? undefined : identifier(goalId);
    return this.#read(() =>
      this.#db
        .query<ProposalRow>(
          `SELECT ${proposalColumns} FROM proposals WHERE kind = 'integration' AND status = 'pending'
       AND (? IS NULL OR json_extract(content_json, '$.goalId') = ?) ORDER BY rowid`,
        )
        .all(id ?? null, id === undefined ? null : this.#goalId(id))
        .map((row) => {
          const proposal = proposalRecord(row);
          const gate = this.#proposalGate(proposal);
          return freeze({
            ...proposal,
            ...this.#proposalRefs(proposal),
            ...gate,
            ...proposalAnswerRequirements(
              proposal,
              gate.policy,
              gate.loosening,
              gate.source,
            ),
          });
        }),
    );
  }

  pendingRegistrationApprovals(cursor: number, limit: number) {
    integer(cursor, 0, Number.MAX_SAFE_INTEGER);
    integer(limit, 1, 100);
    return this.#read(() => {
      const rows = this.#db
        .query<ProposalRow & { cursor: number; previouslyReviewed: number }>(
          `SELECT ${proposalColumns}, rowid AS cursor,
           EXISTS (SELECT 1 FROM proposal_approval_runs WHERE proposal_id = proposals.id) AS previouslyReviewed
         FROM proposals
         WHERE rowid > ? AND status = 'pending' AND kind IN ('goal', 'task')
           AND NOT EXISTS (
             SELECT 1 FROM proposal_approval_runs a
             JOIN executions e ON e.id = a.execution_id
             WHERE a.proposal_id = proposals.id
             GROUP BY a.proposal_id
             HAVING count(*) > 1 OR max(coalesce(json_extract(e.result_json, '$.code'), ''))
               NOT IN ('human-approval-required', 'approval-forbidden')
           )
         ORDER BY rowid LIMIT ?`,
        )
        .all(cursor, limit);
      const ids = rows.flatMap((row) => {
        const proposal = proposalRecord(row);
        const { policy, source, loosening } = this.#proposalGate(proposal);
        return permitsAgentAnswer(
          proposal.source,
          {
            policy,
            ...proposalAnswerRequirements(proposal, policy, loosening, source),
          },
          row.previouslyReviewed ? "approve" : "reject",
        )
          ? [proposal.id]
          : [];
      });
      return { ids, cursor: rows.length < limit ? 0 : rows.at(-1)!.cursor };
    });
  }

  canRequestIntegrationApproval(proposalId: string) {
    return this.#read(() => {
      const runs = this.#db
        .query<{ status: ExecutionStatus; code: string | null }>(
          `
          SELECT executions.status, json_extract(executions.result_json, '$.code') AS code FROM proposal_approval_runs
          JOIN executions ON executions.id = execution_id WHERE proposal_id = ?
        `,
        )
        .all(identifier(proposalId));
      const [first] = runs;
      if (!first) return true;
      return (
        runs.length === 1 &&
        (first.status === "failed" || first.status === "timed-out") &&
        first.code !== "interrupted"
      );
    });
  }

  createExecution(request: {
    actor: ActorKind;
    mode: string;
    requestedBy: Origin;
    goalId?: string;
    taskId?: string;
    approvalProposalId?: string;
  }) {
    const input = fields(request, [
      "actor",
      "mode",
      "requestedBy",
      "goalId",
      "taskId",
      "approvalProposalId",
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
    const requestedTaskId = Object.hasOwn(input, "taskId")
      ? identifier(input.taskId)
      : null;
    const requestedGoalId = Object.hasOwn(input, "goalId")
      ? identifier(input.goalId)
      : null;
    return this.#write((at) => {
      const task =
        requestedTaskId === null ? null : required(this.#task(requestedTaskId));
      const taskId = task?.id ?? null;
      const suppliedGoalId =
        requestedGoalId === null ? null : this.#goalId(requestedGoalId);
      if (task && suppliedGoalId !== null && suppliedGoalId !== task.goalId)
        throw new OrchestratorStoreError("context-mismatch");
      const goalId = task?.goalId ?? suppliedGoalId;
      if (
        goalId !== null &&
        required(this.#goal(goalId)).status === "cancelled"
      )
        throw new OrchestratorStoreError("goal-inactive");
      const approvalProposalId =
        input.approvalProposalId === undefined
          ? null
          : identifier(input.approvalProposalId);
      if (approvalProposalId !== null) {
        const proposal = this.getProposalForAgentApproval(approvalProposalId, {
          allowRejectOnly: true,
        });
        if (
          actor !== "Reviewer" ||
          mode !== "approval" ||
          origin.kind !== "host" ||
          goalId !==
            (proposal.kind === "goal" ? null : proposal.content.goalId) ||
          taskId !==
            (proposal.kind === "integration" ? proposal.content.taskId : null)
        )
          throw new OrchestratorStoreError("context-mismatch");
        if (
          proposal.kind === "integration" &&
          !this.canRequestIntegrationApproval(approvalProposalId)
        )
          throw new OrchestratorStoreError("invalid-transition");
        if (
          proposal.kind !== "integration" &&
          this.#db
            .query(
              `SELECT 1 FROM proposal_approval_runs a JOIN executions e ON e.id = a.execution_id
           WHERE a.proposal_id = ? AND e.status IN ('queued', 'running')`,
            )
            .get(approvalProposalId)
        )
          throw new OrchestratorStoreError("invalid-transition");
      }
      if (
        (actor === "Executor" && mode === "task") ||
        mode === "verification"
      ) {
        if (mode === "verification" && actor !== "Reviewer")
          throw new OrchestratorStoreError("context-mismatch");
        if (task?.status !== "running" || origin.kind !== "host")
          throw new OrchestratorStoreError("invalid-transition");
      }
      if (actor === "Executor" && mode === "task") {
        this.#run(
          "UPDATE tasks SET attempts = attempts + 1 WHERE id = ?",
          task!.id,
        );
      }
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
      if (approvalProposalId !== null)
        this.#run(
          "INSERT INTO proposal_approval_runs VALUES (?, ?)",
          approvalProposalId,
          id,
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

  #executionMaxTokens(row: ExecutionRow): number | null {
    if (row.taskId !== null)
      return taskRecord(required(this.#task(row.taskId))).content.budgets
        .maxTokens;
    if (row.goalId !== null)
      return goalRecord(required(this.#goal(row.goalId))).content.scope.budgets
        .maxTokens;
    return null;
  }

  #executionUsage(row: ExecutionRow, result: unknown) {
    const finished = row.startedAt !== null && row.finishedAt !== null;
    return compareTokenBudget(
      readTokenReport(result, finished),
      this.#executionMaxTokens(row),
    );
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
      const recorded: unknown =
        resultJson === null ? null : JSON.parse(resultJson);
      const report = this.#executionUsage(row, recorded);
      const taskId = row.taskId;
      const maxTokens = report.maxTokens;
      const previousTokens =
        taskId !== null &&
        maxTokens !== null &&
        report.tokens !== null &&
        report.tokens > 0
          ? this.#taskWindowUsage(taskId, maxTokens, id).tokens
          : null;
      const usageResult =
        recorded &&
        typeof recorded === "object" &&
        Object.hasOwn(recorded, "usage")
          ? canonicalJson({ ...recorded, ...report }, 256 * 1024)
          : resultJson;
      this.#run(
        "UPDATE executions SET status = ?, result_json = ?, finished_at = ? WHERE id = ?",
        next,
        usageResult,
        at,
        id,
      );
      const correlation = {
        ...parseOrigin(JSON.parse(row.requestedByJson)),
        executionId: id,
      };
      this.#event(
        at,
        "execution.finished",
        "execution",
        id,
        { status: next },
        correlation,
      );

      if (
        taskId !== null &&
        maxTokens !== null &&
        report.tokens !== null &&
        previousTokens !== null &&
        previousTokens <= maxTokens &&
        previousTokens + report.tokens > maxTokens
      ) {
        const window = this.#taskWindowUsage(taskId, maxTokens, id);
        if (window.overBudget)
          this.#event(
            at,
            "task.budget-exceeded",
            "task",
            taskId,
            window,
            correlation,
          );
      }
    });
  }

  startSession(actor: ActorKind, runtimeId: string, exclusive = false) {
    const kind = oneOf(actor, ACTOR_KINDS);
    const runtime = identifier(runtimeId);
    return this.#write((at) => {
      if (
        exclusive &&
        this.#db
          .query(
            `
        SELECT 1 WHERE EXISTS (
          SELECT 1 FROM actor_sessions WHERE actor = ? AND status = 'active'
        ) OR EXISTS (
          SELECT 1 FROM executions WHERE status IN ('queued', 'running')
        ) OR EXISTS (
          SELECT 1 FROM tasks WHERE status = 'running'
        )
      `,
          )
          .get(kind)
      )
        throw new OrchestratorStoreError("session-busy");
      const id = randomUUID();
      this.#run(
        "INSERT INTO actor_sessions VALUES (?, ?, ?, 'active', ?, NULL, NULL)",
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

  #sessionSnapshotCommit(id: string): string | null {
    return (
      this.#db
        .query<{ snapshotCommit: string | null }>(
          "SELECT snapshot_commit AS snapshotCommit FROM actor_sessions WHERE id = ?",
        )
        .get(id)?.snapshotCommit ?? null
    );
  }

  sessionSnapshotCommit(sessionId: string): string | null {
    return this.#read(() => this.#sessionSnapshotCommit(identifier(sessionId)));
  }

  recordSessionSnapshot(sessionId: string, commit: string): void {
    const id = identifier(sessionId);
    const snapshotCommit = gitCommit(commit);
    this.#write((at) => {
      this.#run(
        "UPDATE actor_sessions SET snapshot_commit = ? WHERE id = ? AND actor = 'Concierge' AND status = 'active' AND snapshot_commit IS NULL",
        snapshotCommit,
        id,
      );
      this.#event(
        at,
        "session.snapshot",
        "session",
        id,
        { snapshotCommit },
        { sessionId: id },
      );
    });
  }

  recordGoalCommit(
    goalId: string,
    commit: string,
    kind: "planning" | "base",
  ): void {
    const key = identifier(goalId);
    const value = gitCommit(commit);
    this.#write((at) => {
      const { id, planningCommit, baseCommit } = required(this.#goal(key));
      const pinned = baseCommit ?? planningCommit;
      if (pinned !== null && pinned !== value)
        throw new OrchestratorStoreError("context-mismatch");
      if (kind === "planning" ? pinned !== null : baseCommit !== null) return;
      if (kind === "planning") {
        this.#run(
          "UPDATE goals SET planning_commit = ? WHERE id = ?",
          value,
          id,
        );
        this.#event(at, "goal.planning-pinned", "goal", id, {
          planningCommit: value,
        });
      } else {
        this.#run("UPDATE goals SET base_commit = ? WHERE id = ?", value, id);
        this.#event(at, "goal.base-pinned", "goal", id, { baseCommit: value });
      }
    });
  }

  #ownsGoalBranch(id: string): boolean {
    return (
      this.#db
        .query<{ id: string }>(
          "SELECT id FROM goals WHERE substr(id, 1, 8) = substr(?, 1, 8) ORDER BY rowid LIMIT 1",
        )
        .get(id)?.id === id
    );
  }

  #eligibleGoalBase(id: string): string | null {
    const goal = this.#goal(id);
    if (goal?.status === "cancelled")
      throw new OrchestratorStoreError("goal-inactive");
    if (
      goal?.status !== "active" ||
      !this.#ownsGoalBranch(id) ||
      this.#db
        .query(
          "SELECT 1 FROM tasks WHERE goal_id = ? AND status IN ('running', 'awaiting-integration', 'succeeded') LIMIT 1",
        )
        .get(id) ||
      this.#db
        .query(
          "SELECT 1 FROM proposals WHERE kind = 'integration' AND (status = 'pending' OR ? IS NULL) AND json_extract(content_json, '$.goalId') = ? LIMIT 1",
        )
        .get(goal.baseCommit, id)
    )
      throw new OrchestratorStoreError("goal-base-ineligible");
    if (goal.baseCommit !== null) return gitCommit(goal.baseCommit);
    if (
      this.#db
        .query(
          `SELECT 1 FROM tasks JOIN events ON events.subject_id = tasks.id
          WHERE tasks.goal_id = ? AND events.subject_kind = 'task'
            AND events.kind = 'task.status'
            AND json_extract(events.data, '$.status') IN ('awaiting-integration', 'succeeded')
          LIMIT 1`,
        )
        .get(id) ||
      this.#db
        .query(
          "SELECT 1 FROM events WHERE subject_id = ? AND subject_kind = 'goal' AND kind = 'goal.base-updated' LIMIT 1",
        )
        .get(id)
    )
      throw new OrchestratorStoreError("goal-base-ineligible");
    return null;
  }

  goalBaseForUpdate(goalId: string): string | null {
    return this.#read(() =>
      this.#eligibleGoalBase(this.#goalId(identifier(goalId))),
    );
  }

  async updateGoalBase(
    goalId: string,
    from: string,
    to: string,
    moveRef: () => Promise<void>,
    legacyBase = false,
  ) {
    const id = this.#read(() => this.#goalId(identifier(goalId)));
    gitCommit(from);
    gitCommit(to);
    await this.#changeGoalBranch(
      () => {
        if (this.#eligibleGoalBase(id) !== (legacyBase ? null : from))
          throw new OrchestratorStoreError("goal-base-stale");
      },
      moveRef,
      (at) => {
        this.#run("UPDATE goals SET base_commit = ? WHERE id = ?", to, id);
        this.#event(at, "goal.base-updated", "goal", id, {
          from,
          to,
          ...(legacyBase && { legacyBase: true }),
        });
      },
      "goal-base-record-failed",
    );
  }

  #eligibleGoalDiscard(id: string): void {
    this.#activeGoal(id);
    if (!this.#ownsGoalBranch(id))
      throw new OrchestratorStoreError("context-mismatch");
    if (
      this.#db
        .query(
          `SELECT 1 WHERE EXISTS (
            SELECT 1 FROM tasks WHERE goal_id = ?1 AND status IN ('running', 'awaiting-integration')
          ) OR EXISTS (
            SELECT 1 FROM executions AS x LEFT JOIN tasks AS t ON x.task_id = t.id
            WHERE (x.goal_id = ?1 OR t.goal_id = ?1) AND x.status IN ('queued', 'running')
          ) OR EXISTS (
            SELECT 1 FROM proposals WHERE kind = 'integration' AND status = 'pending'
              AND json_extract(content_json, '$.goalId') = ?1
          )`,
        )
        .get(id)
    )
      throw new OrchestratorStoreError("goal-busy");
  }

  assertGoalDiscardable(goalId: string): void {
    this.#read(() =>
      this.#eligibleGoalDiscard(this.#goalId(identifier(goalId))),
    );
  }

  async discardGoal(
    goalId: string,
    expectedHead: string | null,
    deleteRef: (head: string | null) => Promise<void>,
    channel: SettingsOrigin = "cli",
  ): Promise<void> {
    const key = identifier(goalId);
    const head = expectedHead === null ? null : gitCommit(expectedHead);
    const origin = { kind: "operator", channel };
    const id = this.#write((at) => {
      const id = this.#goalId(key);
      this.#eligibleGoalDiscard(id);
      this.#event(at, "goal.discard-authorized", "goal", id, { head, origin });
      return id;
    });
    await this.#changeGoalBranch(
      () => this.#eligibleGoalDiscard(id),
      () => deleteRef(head),
      (at) => {
        this.#run("UPDATE goals SET status = 'cancelled' WHERE id = ?", id);
        const registered = this.#db
          .query<{ id: string }>(
            "SELECT id FROM tasks WHERE goal_id = ? AND status = 'registered' ORDER BY rowid",
          )
          .all(id);
        for (const task of registered)
          this.#setTaskStatus(task.id, "cancelled", null, at);
        this.#event(at, "goal.status", "goal", id, {
          status: "cancelled",
          discardedHead: head,
          origin,
        });
      },
      "goal-discard-record-failed",
    );
  }

  async #changeGoalBranch(
    check: () => void,
    changeRef: () => Promise<void>,
    record: (at: string) => void,
    recordError: "goal-base-record-failed" | "goal-discard-record-failed",
  ): Promise<void> {
    if (this.#closed) throw new OrchestratorStoreError("closed");
    if (this.#writeFailed || this.#changingGoalBranch)
      throw new OrchestratorStoreError("write-failed");

    // Hold the SQLite writer lock from the final eligibility check through
    // the Git CAS and audit commit. This prevents a concurrent Task claim.
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new OrchestratorStoreError("write-failed");
    }
    this.#changingGoalBranch = true;
    let changed = false;
    try {
      check();
      await changeRef();
      changed = true;
      record(new Date().toISOString());
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        this.#writeFailed = true;
      }
      if (changed) throw new OrchestratorStoreError(recordError);
      throw error;
    } finally {
      this.#changingGoalBranch = false;
    }
  }

  endSession(
    sessionId: string,
    result?: {
      mode: string;
      status: "succeeded" | "failed";
      exitCode: number | null;
      code?: string;
    },
  ): void {
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
      this.#event(at, "session.ended", "session", id, result ?? {}, {
        sessionId: id,
      });
    });
  }

  recordSessionAuditExport(sessionId: string, exported: boolean): void {
    const id = identifier(sessionId);
    this.#write((at) => {
      this.#event(
        at,
        "session.audit-export",
        "session",
        id,
        { exported },
        { sessionId: id },
      );
    });
  }

  #interrupted(): Reconciliation {
    const ids = (sql: string) =>
      this.#db
        .query<{ id: string }>(sql)
        .all()
        .map(({ id }) => id);
    return {
      sessions: ids(
        "SELECT id FROM actor_sessions WHERE status = 'active' ORDER BY id",
      ),
      executions: this.#db
        .query<Reconciliation["executions"][number]>(
          "SELECT id, status FROM executions WHERE status IN ('queued', 'running') ORDER BY id",
        )
        .all(),
      tasks: ids("SELECT id FROM tasks WHERE status = 'running' ORDER BY id"),
    };
  }

  reconciliationPreview() {
    return this.#read(() =>
      this.#db.transaction(() => this.#interrupted()).deferred(),
    );
  }

  interruptedIntegrations(taskIds: readonly string[]) {
    return this.#read(() =>
      taskIds.flatMap((taskId) => {
        const proposalId = this.#integrationProgress(taskId)?.proposalId;
        if (!proposalId) return [];
        const proposal = proposalRecord(required(this.#proposal(proposalId)));
        if (
          proposal.kind !== "integration" ||
          proposal.content.taskId !== taskId
        )
          throw new OrchestratorStoreError("context-mismatch");
        const task = taskRecord(required(this.#task(taskId)));
        return [
          { id: proposalId, content: proposal.content, retries: task.retries },
        ];
      }),
    );
  }

  reconcile(
    expected: Reconciliation,
    integrationHeads: ReadonlyMap<string, string> = new Map(),
  ) {
    return this.#write((at) => {
      const rows = this.#interrupted();
      if (JSON.stringify(rows) !== JSON.stringify(expected))
        throw new OrchestratorStoreError("reconcile-changed");
      for (const id of rows.sessions) {
        this.#run(
          "UPDATE actor_sessions SET status = 'ended', ended_at = ? WHERE id = ?",
          at,
          id,
        );
        this.#event(
          at,
          "session.ended",
          "session",
          id,
          { code: "interrupted", origin: "operator" },
          { sessionId: id },
        );
      }
      for (const { id } of rows.executions) {
        this.#run(
          "UPDATE executions SET status = 'failed', result_json = ?, finished_at = ? WHERE id = ?",
          '{"code":"interrupted"}',
          at,
          id,
        );
        this.#event(
          at,
          "execution.finished",
          "execution",
          id,
          { status: "failed", code: "interrupted", origin: "operator" },
          { executionId: id },
        );
      }
      const integrating = this.interruptedIntegrations(rows.tasks);
      for (const { id, content } of integrating) {
        const head = integrationHeads.get(id);
        if (head === content.candidate)
          this.#integrationSucceeded(at, id, content, true);
        else if (head === content.base)
          this.#setTaskStatus(
            content.taskId,
            "failed",
            "integration-interrupted",
            at,
          );
        else throw new OrchestratorStoreError("integration-uncertain");
      }
      const integrationTasks = new Set(
        integrating.map(({ content }) => content.taskId),
      );
      for (const id of rows.tasks)
        if (!integrationTasks.has(id))
          this.#setTaskStatus(id, "failed", "interrupted", at);
      return rows;
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

  #proposalGate(proposal: ReturnType<typeof proposalRecord>): Omit<
    EffectivePolicy,
    "policy" | "source"
  > & {
    gate: Gate | null;
    policy: Policy | null;
    source: EffectivePolicy["source"] | null;
    loosening: Gate[];
  } {
    if (proposal.kind === "goal")
      return this.#goalPolicy(proposal.content, proposal.source);
    if (proposal.status === "registered")
      return { gate: null, policy: null, source: null, loosening: [] };
    const goal = goalRecord(required(this.#goal(proposal.content.goalId)));
    if (proposal.kind === "integration") {
      const task = taskRecord(required(this.#task(proposal.content.taskId)));
      if (task.goalId !== goal.id)
        throw new OrchestratorStoreError("context-mismatch");
      return {
        gate: "integration" as const,
        loosening: [],
        ...this.#integrationPolicy(task, goal.content, proposal),
      };
    }
    // Resolve pending Tasks against current scope, including at decision time.
    const inScope =
      proposal.status !== "pending" ||
      fitsScope(goal.content, proposal.content, this.#taskCount(goal.id)).ok;
    return this.#taskPolicy(
      proposal.content,
      goal.content,
      proposal.source,
      inScope,
    );
  }

  #plannerCategory(task: ReturnType<typeof taskRecord>) {
    if (!task.content.category) return;
    const proposal = proposalRecord(required(this.#proposal(task.proposalId)));
    if (proposal.source.kind === "actor" && proposal.source.actor === "Planner")
      return task.content.category;
  }

  #integrationPolicy(
    task: ReturnType<typeof taskRecord>,
    goal: GoalContent,
    proposal?: Extract<
      ReturnType<typeof proposalRecord>,
      { kind: "integration" }
    >,
  ) {
    const evidence = proposal && this.#integrationDiffSize(proposal.id);
    const invariant =
      proposal &&
      (integrationInvariant(proposal) ??
        (!evidence && proposal.status === "pending"
          ? "integration-symlink-evidence"
          : undefined));
    return this.#resolveGate(
      "integration",
      {
        ...this.#goalLayers(goal),
        task: task.content.policies ?? {},
      },
      {
        taskId: task.id,
        goalId: task.goalId,
        invariant,
        facts: proposal && {
          paths: proposal.content.changedPaths,
          category: this.#plannerCategory(task),
          ...(evidence && { diffSize: evidence }),
        },
      },
    );
  }

  #integrationDiffSize(id: string) {
    return this.#db
      .query<DiffSize>(
        "SELECT changed_files AS changedFiles, changed_lines AS changedLines FROM integration_policy_facts WHERE proposal_id = ?",
      )
      .get(id);
  }

  #integrationReview(id: string) {
    // Only a succeeded, candidate-pinned review can create this event.
    // Terminal executions cannot be started, finished or reconciled again.
    return this.#db
      .query<{ executionId: string; verdict: "pass" }>(
        `SELECT e.id AS executionId, json_extract(e.result_json, '$.review') AS verdict
         FROM events p JOIN executions e ON e.id = p.execution_id
         WHERE p.subject_kind = 'proposal' AND p.subject_id = ?
           AND p.kind = 'proposal.created' AND e.actor = 'Reviewer'
           AND e.mode = 'review' AND e.status = 'succeeded'
           AND json_extract(e.result_json, '$.review') = 'pass'`,
      )
      .get(id);
  }

  #checkIntegrationTask(content: IntegrationContent, proposalId: string) {
    const task = required(this.#task(content.taskId));
    if (task.goalId !== content.goalId)
      throw new OrchestratorStoreError("context-mismatch");
    if (
      task.status !== "awaiting-integration" ||
      this.#latestIntegrationProposalId(task.id) !== proposalId
    )
      throw new OrchestratorStoreError("invalid-transition");
    this.#activeGoal(content.goalId);
  }

  #subjectRefs(goalId: string | null, taskId: string | null) {
    const goalRef = goalId === null ? null : (this.#goal(goalId)?.ref ?? null);
    const taskRef = taskId === null ? null : (this.#task(taskId)?.ref ?? null);
    return { ref: taskRef ?? goalRef, goalRef, taskRef };
  }

  #proposalRefs(proposal: ReturnType<typeof proposalRecord>) {
    if (proposal.kind === "goal") {
      const goal = this.#db
        .query<{ id: string }>("SELECT id FROM goals WHERE proposal_id = ?")
        .get(proposal.id);
      return this.#subjectRefs(goal?.id ?? null, null);
    }
    if (proposal.kind === "integration")
      return this.#subjectRefs(
        proposal.content.goalId,
        proposal.content.taskId,
      );
    const task = this.#db
      .query<{ ref: string }>("SELECT ref FROM tasks WHERE proposal_id = ?")
      .get(proposal.id);
    return {
      ...this.#subjectRefs(proposal.content.goalId, null),
      taskRef: task?.ref ?? null,
    };
  }

  getProposalDetails(
    proposalId: string,
    {
      includeDelegation = false,
      includeEvidence = false,
    }: {
      includeDelegation?: boolean;
      includeEvidence?: boolean;
    } = {},
  ) {
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
          answererJson: string;
          detailsJson: string | null;
        }>(
          "SELECT gate, policy, policy_source AS source, answerer_json AS answererJson, policy_details_json AS detailsJson FROM approvals WHERE proposal_id = ?",
        )
        .get(id);
      const { answererJson, detailsJson } = decision ?? {};
      const gate = this.#proposalGate(proposal);
      const policy = decision
        ? {
            gate: decision.gate,
            loosening: gate.loosening,
            ...(detailsJson
              ? (JSON.parse(detailsJson) as EffectivePolicy)
              : { policy: decision.policy, source: decision.source }),
          }
        : gate;
      const answerer =
        includeDelegation && answererJson
          ? parseAnswerer(JSON.parse(answererJson))
          : undefined;
      return freeze({
        ...proposal,
        ...this.#proposalRefs(proposal),
        ...policy,
        ...proposalAnswerRequirements(
          proposal,
          policy.policy,
          policy.loosening,
          policy.source,
        ),
        origin: proposal.source,
        ...(includeEvidence &&
          proposal.kind === "integration" && {
            diffSize: this.#integrationDiffSize(id),
            pinnedReview: this.#integrationReview(id),
            budgets: taskRecord(required(this.#task(proposal.content.taskId)))
              .content.budgets,
          }),
        ...(includeEvidence &&
          proposal.kind === "task" && {
            pathViolations: proposal.content.paths.filter(
              (path) =>
                !allowsPath(
                  goalRecord(required(this.#goal(proposal.content.goalId)))
                    .content.scope.paths,
                  path,
                ),
            ),
          }),
        ...(answerer?.kind === "human" &&
          answerer.delegate && { approval: { delegated: true, answerer } }),
      });
    });
  }

  /** Read and check the same proposal snapshot before scheduling a Reviewer. */
  getProposalForAgentApproval(
    proposalId: string,
    { allowRejectOnly = false }: { allowRejectOnly?: boolean } = {},
  ) {
    const id = identifier(proposalId);
    return this.#read(() =>
      this.#db
        .transaction(() => {
          const proposal = required(this.getProposalDetails(id));
          if (proposal.status !== "pending")
            throw new OrchestratorStoreError("invalid-transition");
          if (contentDigest(proposal.content) !== proposal.digest)
            throw new OrchestratorStoreError("stale-digest");
          if (
            !permitsAgentAnswer(
              proposal.origin,
              proposal,
              allowRejectOnly ? "reject" : "approve",
            )
          )
            throw new OrchestratorStoreError("approval-forbidden");
          if (proposal.kind === "integration") {
            this.#checkIntegrationTask(proposal.content, proposal.id);
            this.assertGoalScheduling(proposal.content.goalId);
          }
          if (proposal.kind === "task") {
            const task = proposal.content;
            const goal = goalRecord(required(this.#goal(task.goalId)));
            this.assertGoalScheduling(goal.id);
            const error = this.#taskApprovalError(task, goal);
            if (error) throw new OrchestratorStoreError(error);
          }
          return proposal;
        })
        .deferred(),
    );
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
                ...this.#proposalRefs(proposal),
                ...(proposal.kind === "integration"
                  ? {
                      goalId: proposal.content.goalId,
                      taskId: proposal.content.taskId,
                    }
                  : { title: proposal.content.title }),
                gate,
                policy,
              };
            });
          const recentExecutions = this.#recentExecutions();
          const recentTasks = this.#db
            .query<TaskRow>(
              `SELECT ${taskColumns} FROM tasks ORDER BY rowid DESC LIMIT 20`,
            )
            .all()
            .map((row) => {
              const task = taskRecord(row);
              return {
                id: task.id,
                goalId: task.goalId,
                ...this.#subjectRefs(task.goalId, task.id),
                status: task.status,
                ...this.#runningIntegrationState(task),
                ...this.#taskWindowUsage(
                  task.id,
                  task.content.budgets.maxTokens,
                ),
              };
            });
          return freeze({
            goals: counts("goals"),
            tasks: counts("tasks"),
            proposals: counts("proposals"),
            pendingProposals,
            recentExecutions,
            recentTasks,
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
          .map((row) => {
            const proposal = proposalRecord(row);
            return { ...proposal, ...this.#proposalRefs(proposal) };
          }),
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

  listGoals(status: GoalRow["status"] | null = null, limit = -1) {
    return this.#read(() =>
      freeze(
        this.#db
          .query<GoalRow>(
            `SELECT ${goalColumns} FROM goals
             WHERE (? IS NULL OR status = ?)
             ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END * ?, rowid
             LIMIT ?`,
          )
          .all(status, status, Number(limit > 0), limit)
          .map(goalRecord),
      ),
    );
  }

  #runningIntegrationState(task: Pick<TaskRow, "id" | "status">) {
    const code =
      task.status === "running"
        ? this.#integrationProgress(task.id)?.code
        : null;
    return code === "integration-in-progress" ||
      code === "integration-uncertain"
      ? { code }
      : {};
  }

  taskPathViolations(taskId: string) {
    return this.#read(() => {
      const latest = this.#db
        .query<{ data: string }>(
          `SELECT data FROM events WHERE subject_kind = 'task' AND subject_id = ? AND kind = 'task.status'
         ORDER BY rowid DESC LIMIT 1`,
        )
        .get(this.#taskId(identifier(taskId)));
      if (!latest) return;
      const data = JSON.parse(latest.data) as {
        code?: string;
        rejectedPaths?: unknown;
      };
      if (data?.code === "path-violation")
        return readPathViolations(data.rejectedPaths);
    });
  }

  getTask(taskId: string) {
    const id = identifier(taskId);
    return this.#read(() => {
      const row = this.#task(id);
      return row
        ? freeze({ ...taskRecord(row), ...this.#runningIntegrationState(row) })
        : null;
    });
  }

  taskTokens(taskId: string): number {
    return this.#read(
      () =>
        this.#db
          .query<{ tokens: number }>(
            "SELECT total(json_extract(result_json, '$.tokens')) AS tokens FROM executions WHERE task_id = ?",
          )
          .get(this.#taskId(identifier(taskId)))!.tokens,
    );
  }

  /** Queue order assigns each execution to a retry window, even if it finishes late. */
  #taskWindowUsage(
    taskId: string,
    maxTokens: number,
    executionId: string | null = null,
  ) {
    const rows = this.#db
      .query<Pick<ExecutionRow, "resultJson">>(
        `
      WITH anchor AS (
        SELECT CASE WHEN ?2 IS NULL THEN (SELECT max(rowid) FROM events) ELSE
          (SELECT rowid FROM events WHERE subject_id = ?2 AND subject_kind = 'execution' AND kind = 'execution.queued')
        END AS position
      ), bounds AS (
        SELECT coalesce(max(CASE WHEN events.rowid <= position THEN events.rowid END), -1) AS lower,
          min(CASE WHEN events.rowid > position THEN events.rowid END) AS upper
        FROM anchor JOIN events
          ON subject_id = ?1 AND subject_kind = 'task' AND kind = 'task.retried'
      )
      SELECT executions.result_json AS resultJson
      FROM executions CROSS JOIN bounds
      LEFT JOIN events AS queued ON queued.subject_id = executions.id
        AND queued.subject_kind = 'execution' AND queued.kind = 'execution.queued'
      WHERE executions.task_id = ?1 AND executions.started_at IS NOT NULL
        AND executions.finished_at IS NOT NULL
        AND coalesce(queued.rowid, 0) > lower AND (upper IS NULL OR queued.rowid < upper)
    `,
      )
      .all(taskId, executionId);
    let tokens = 0;
    let unavailable = false;
    const raw = { ...emptyTokenUsage };
    for (const { resultJson } of rows) {
      const report = readTokenReport(
        resultJson === null ? null : JSON.parse(resultJson),
        true,
      );
      tokens += report.tokens ?? 0;
      unavailable ||= report.usage === "unavailable";
      const usage = report.rawUsage ?? report.usage;
      if (usage && usage !== "unavailable" && !Array.isArray(usage)) {
        raw.input += usage.input;
        raw.output += usage.output;
        raw.cacheCreation += usage.cacheCreation;
        raw.cacheRead += usage.cacheRead;
      }
    }
    return compareTokenBudget(
      unavailable
        ? ({ tokens, usage: "unavailable", rawUsage: raw } as const)
        : { tokens, usage: raw },
      maxTokens,
    );
  }

  taskUsage(taskId: string) {
    const id = identifier(taskId);
    return this.#read(() => {
      const task = required(this.#task(id));
      return freeze(
        this.#taskWindowUsage(
          task.id,
          taskRecord(task).content.budgets.maxTokens,
        ),
      );
    });
  }

  taskBudgetTokens(taskId: string): number {
    return this.taskUsage(taskId).tokens;
  }

  #recentExecutions() {
    return this.#db
      .query<ExecutionRow>(
        `SELECT ${executionColumns} FROM executions ORDER BY rowid DESC LIMIT 20`,
      )
      .all()
      .map((row) => {
        const { id, actor, mode, status } = row;
        const result: unknown =
          row.resultJson === null ? null : JSON.parse(row.resultJson);
        return {
          id,
          actor,
          mode,
          status,
          ...this.#subjectRefs(row.goalId, row.taskId),
          ...this.#executionUsage(row, result),
        };
      });
  }

  listTasks(goalId: string, limit = -1) {
    const id = identifier(goalId);
    return this.#read(() =>
      freeze(
        this.#db
          .query<TaskRow>(
            `SELECT ${taskColumns} FROM tasks WHERE goal_id = ? ORDER BY rowid LIMIT ?`,
          )
          .all(this.#goalId(id), limit)
          .map((row) => ({
            ...taskRecord(row),
            ...this.#runningIntegrationState(row),
          })),
      ),
    );
  }

  succeededTaskWallTimes() {
    return this.#read(() =>
      this.#db
        .query<{ startedAt: string; finishedAt: string }>(
          `SELECT min(e.at) FILTER (WHERE json_extract(e.data, '$.status') = 'running'
                                      AND json_extract(e.data, '$.code') IS NULL) AS startedAt,
                  max(e.at) FILTER (WHERE json_extract(e.data, '$.status') = 'succeeded') AS finishedAt
           FROM tasks AS t JOIN events AS e ON e.subject_id = t.id
           WHERE t.status = 'succeeded'
             AND e.subject_kind = 'task' AND e.kind = 'task.status'
           GROUP BY t.id HAVING startedAt IS NOT NULL AND finishedAt IS NOT NULL
           ORDER BY finishedAt DESC LIMIT 200`,
        )
        .all(),
    );
  }

  operatorTaskTimeline(goalId: string, taskId?: string) {
    return this.#read(() =>
      this.#db
        .query<{
          taskId: string;
          at: string;
          status: TaskRow["status"] | null;
          code: string | null;
          actor: ActorKind | null;
          mode: string | null;
          executionStatus: ExecutionStatus | null;
        }>(
          `WITH relevant AS (
             SELECT id, created_at FROM tasks
             WHERE status = 'succeeded' OR (goal_id = ?1 AND (?2 IS NULL OR id = ?2))
           )
           SELECT 0 AS position, id AS taskId, created_at AS at, 'registered' AS status,
                  NULL AS code, NULL AS actor, NULL AS mode, NULL AS executionStatus
           FROM relevant
           UNION ALL
           SELECT e.rowid, t.id, e.at, json_extract(e.data, '$.status'),
                  json_extract(e.data, '$.code') AS code,
                  NULL AS actor, NULL AS mode, NULL AS executionStatus
           FROM relevant AS t JOIN events AS e ON e.subject_id = t.id
           WHERE e.subject_kind = 'task' AND e.kind = 'task.status'
           UNION ALL
           SELECT e.rowid, x.task_id, e.at, NULL, NULL, x.actor, x.mode, x.status
           FROM executions AS x JOIN relevant AS t ON x.task_id = t.id
             JOIN events AS e ON e.subject_id = x.id
           WHERE e.subject_kind = 'execution' AND e.kind = 'execution.started'
           ORDER BY position`,
        )
        .all(
          this.#goalId(identifier(goalId)),
          taskId === undefined ? null : this.#taskId(identifier(taskId)),
        ),
    );
  }

  recentTaskExecutions(taskId: string) {
    return this.#read(() =>
      this.#db
        .query<ExecutionRow>(
          `SELECT ${executionColumns} FROM executions
           WHERE task_id = ? ORDER BY rowid DESC LIMIT 10`,
        )
        .all(this.#taskId(identifier(taskId)))
        .map(
          ({ id, actor, mode, status, startedAt, finishedAt, resultJson }) => ({
            id,
            actor,
            mode,
            status,
            startedAt,
            finishedAt,
            tokens: readTokenReport(
              resultJson === null ? null : JSON.parse(resultJson),
              startedAt !== null && finishedAt !== null,
            ).tokens,
          }),
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
        ...this.#subjectRefs(row.goalId, row.taskId),
        requestedBy: parseOrigin(JSON.parse(requestedByJson)),
        tokenUsage: this.#executionUsage(row, result),
        result,
      });
    });
  }

  activityRows() {
    return this.#read(() =>
      this.#db
        .query<{
          id: string;
          actor: ActorKind;
          mode: string;
          status: "queued" | "running" | "registered";
          goalId: string | null;
          goalRef: string | null;
          goalTitle: string | null;
          taskId: string | null;
          taskRef: string | null;
          taskTitle: string | null;
          startedAt: string | null;
        }>(
          `
        WITH active AS MATERIALIZED (
          SELECT rowid, id, actor, mode, status, goal_id, task_id, started_at
          FROM executions WHERE status IN ('queued', 'running')
        )
        SELECT id, actor, mode, status, goalId, goalRef, goalTitle, taskId, taskRef, taskTitle, startedAt
        FROM (
          SELECT x.id, x.actor, x.mode, x.status, g.id AS goalId, g.ref AS goalRef,
            json_extract(g.content_json, '$.title') AS goalTitle, t.id AS taskId,
            t.ref AS taskRef, json_extract(t.content_json, '$.title') AS taskTitle,
            x.started_at AS startedAt, 0 AS sourceOrder, x.rowid AS position
          FROM active x LEFT JOIN tasks t ON t.id = x.task_id
            LEFT JOIN goals g ON g.id = coalesce(x.goal_id, t.goal_id)
          UNION ALL
          SELECT t.id, json_extract(t.content_json, '$.actor'), 'task', t.status, g.id,
            g.ref, json_extract(g.content_json, '$.title'), t.id,
            t.ref, json_extract(t.content_json, '$.title'), NULL, 1, t.rowid
          FROM tasks t JOIN goals g ON g.id = t.goal_id
          WHERE t.status = 'registered' AND g.status = 'active'
            AND t.id NOT IN (SELECT task_id FROM active WHERE task_id IS NOT NULL)
        ) ORDER BY sourceOrder, position
      `,
        )
        .all(),
    );
  }

  conciergeWatchStart(sessionId: string) {
    return this.#read(
      () =>
        required(
          this.#db
            .query<{ sequence: number }>(
              "SELECT rowid AS sequence FROM events WHERE subject_id = ? AND kind = 'session.started'",
            )
            .get(identifier(sessionId)),
        ).sequence,
    );
  }

  conciergeWatchRows(after: number) {
    return this.#read(() =>
      this.#db
        .query<{
          sequence: number;
          kind: string;
          goalId: string | null;
          goalRef: string | null;
          taskRef: string | null;
        }>(
          `
        SELECT e.rowid AS sequence,
          CASE WHEN e.subject_kind = 'proposal' THEN 'decision-needed' ELSE e.kind END AS kind,
          g.id AS goalId, g.ref AS goalRef, t.ref AS taskRef
        FROM events e
        LEFT JOIN tasks t ON e.subject_kind = 'task' AND e.subject_id = t.id
        LEFT JOIN executions x ON e.kind = 'execution.finished' AND e.subject_id = x.id
        LEFT JOIN goals g ON g.id = coalesce(t.goal_id, x.goal_id,
          CASE WHEN e.subject_kind = 'goal' THEN e.subject_id END)
        WHERE e.rowid > ? AND (
          e.kind IN ('goal.registered', 'task.integrated', 'task.budget-exceeded')
          OR (e.kind IN ('goal.proposed', 'task.proposed', 'proposal.created') AND EXISTS (
            SELECT 1 FROM proposals p WHERE p.id = e.subject_id AND p.status = 'pending'
          ))
          OR (e.kind = 'goal.status' AND json_extract(e.data, '$.status') = 'done')
          OR (e.kind = 'task.status' AND json_extract(e.data, '$.status') = 'failed')
          OR (e.kind = 'execution.finished' AND x.actor = 'Planner'
            AND x.mode = 'task-decomposition' AND json_extract(e.data, '$.status') = 'succeeded')
        )
        ORDER BY e.rowid LIMIT 256
      `,
        )
        .all(after),
    );
  }

  recordConciergeWatch(
    sessionId: string,
    kind: "connected" | "disconnected" | "sent",
    event?: string,
  ) {
    const id = identifier(sessionId);
    this.#write((at) => {
      if (kind !== "disconnected" && !this.isActiveConciergeSession(id))
        throw new OrchestratorStoreError("invalid-transition");
      const [eventKind, ref, code] = event?.split(" ") ?? [];
      const data =
        eventKind === "decision-needed"
          ? { eventKind, count: Number(ref) }
          : eventKind
            ? { eventKind, ref, ...(code ? { code } : {}) }
            : {};
      this.#event(at, `concierge-watch.${kind}`, "session", id, data, {
        sessionId: id,
      });
    });
  }

  conciergeWatching(): boolean {
    return this.#read(
      () =>
        !this.#writeFailed &&
        this.#db
          .query(
            `
        SELECT 1 FROM actor_sessions s
        WHERE s.actor = 'Concierge' AND s.status = 'active' AND (
          SELECT e.kind FROM events e
          WHERE e.subject_id = s.id
            AND e.kind IN ('concierge-watch.connected', 'concierge-watch.disconnected')
          ORDER BY e.rowid DESC LIMIT 1
        ) = 'concierge-watch.connected'
      `,
          )
          .get() !== null,
    );
  }

  activityRevision() {
    return this.#read(
      () =>
        this.#db
          .query<{ revision: number }>(
            `
        SELECT coalesce(max(rowid), 0) AS revision FROM events
        WHERE kind IN ('execution.queued', 'execution.started', 'execution.finished',
          'goal.registered', 'goal.status', 'goal.base-pinned', 'goal.base-updated',
          'task.registered', 'task.auto-registered', 'task.status', 'task.integrated',
          'task.retried', 'task.budget-exceeded',
          'goal.proposed', 'task.proposed', 'proposal.created', 'proposal.blocked', 'proposal.decided',
          'project.defaults-set', 'project.rule-set', 'goal.policy-set', 'task.policy-set',
          'concierge-watch.connected', 'concierge-watch.disconnected')
      `,
          )
          .get()!.revision,
    );
  }

  #panelActionCounts(goalIds?: string) {
    const rows = this.#db
      .query<ProposalRow & { goalId: string | null }>(
        `SELECT ${proposalColumns}, json_extract(content_json, '$.goalId') AS goalId
         FROM proposals WHERE status = 'pending'
           AND (SELECT status FROM goals WHERE id = goalId) IS NOT 'cancelled'
           AND (?1 IS NULL OR goalId IN (SELECT value FROM json_each(?1)))`,
      )
      .all(goalIds ?? null);
    let total = 0;
    const byGoal = new Map<string, number>();
    for (const { goalId, ...row } of rows) {
      const proposal = proposalRecord(row);
      const gate = this.#proposalGate(proposal);
      const requirements = {
        ...gate,
        ...proposalAnswerRequirements(
          proposal,
          gate.policy,
          gate.loosening,
          gate.source,
        ),
      };
      if (
        permitsPanelAnswer(proposal.source, requirements, "approve") ||
        permitsPanelAnswer(proposal.source, requirements, "reject")
      ) {
        total++;
        if (goalId !== null) byGoal.set(goalId, (byGoal.get(goalId) ?? 0) + 1);
      }
    }
    return { total, byGoal };
  }

  goalTurnFacts(goalIds: readonly string[]) {
    return this.#read(() => {
      const selected = JSON.stringify(
        goalIds.map((id) => this.#goalId(identifier(id))),
      );
      const approvals = this.#panelActionCounts(selected).byGoal;
      const rows = this.#db
        .query<{
          goalId: string;
          total: number;
          done: number;
          failed: number;
          running: number;
          awaitingIntegration: number;
          failedRef: string | null;
          failedCode: string;
          runningRef: string | null;
          runningActor: ActorKind | null;
          executionActor: ActorKind | null;
          executionTaskRef: string | null;
          queued: 0 | 1;
          planned: 0 | 1;
          exportable: 0 | 1;
        }>(
          `WITH selected AS MATERIALIZED (
             SELECT g.id, g.status, g.base_commit
             FROM json_each(?) AS keys JOIN goals g ON g.id = keys.value
           ), task_facts AS (
             SELECT t.goal_id, count(*) AS total,
               count(*) FILTER (WHERE t.status = 'succeeded') AS done,
               count(*) FILTER (WHERE t.status = 'failed') AS failed,
               count(*) FILTER (WHERE t.status = 'running') AS running,
               count(*) FILTER (WHERE t.status = 'awaiting-integration') AS awaitingIntegration,
               min(t.rowid) FILTER (WHERE t.status = 'failed') AS firstFailed,
               min(t.rowid) FILTER (WHERE t.status = 'running') AS firstRunning,
               max(t.status = 'registered') AS registered
             FROM selected g JOIN tasks t ON t.goal_id = g.id GROUP BY t.goal_id
           ), execution_facts AS (
             SELECT g.id,
               min(x.rowid) FILTER (WHERE x.status = 'running') AS firstRunning,
               max(x.status = 'queued') AS queued,
               max(x.actor = 'Planner' AND x.goal_id IS NOT NULL) AS planned
             FROM executions x
             LEFT JOIN tasks subject ON x.goal_id IS NULL AND subject.id = x.task_id
             JOIN selected g ON g.id = coalesce(x.goal_id, subject.goal_id)
             WHERE x.status IN ('queued', 'running')
               OR (x.actor = 'Planner' AND x.status = 'succeeded' AND x.goal_id IS NOT NULL)
             GROUP BY g.id
           )
           SELECT g.id AS goalId, coalesce(t.total, 0) AS total,
             coalesce(t.done, 0) AS done, coalesce(t.failed, 0) AS failed,
             coalesce(t.running, 0) AS running,
             coalesce(t.awaitingIntegration, 0) AS awaitingIntegration,
             failed.ref AS failedRef, coalesce((
               SELECT json_extract(e.data, '$.code') FROM events e
               WHERE e.subject_id = failed.id AND e.subject_kind = 'task' AND e.kind = 'task.status'
               ORDER BY e.rowid DESC LIMIT 1
             ), 'unknown') AS failedCode,
             running.ref AS runningRef, json_extract(running.content_json, '$.actor') AS runningActor,
             x.actor AS executionActor, xt.ref AS executionTaskRef,
             (coalesce(e.queued, 0) OR (g.status = 'active' AND coalesce(t.registered, 0))) AS queued,
             coalesce(e.planned, 0) AS planned,
             (g.base_commit IS NOT NULL OR (
               (g.status = 'done' OR (t.total > 0 AND t.total = t.done)) AND EXISTS (
                 SELECT 1 FROM tasks task JOIN events ev ON ev.subject_id = task.id
                 WHERE task.goal_id = g.id AND ev.subject_kind = 'task' AND ev.kind = 'task.integrated'
                   AND json_extract(ev.data, '$.head') IS NOT NULL
               )
             )) AS exportable
           FROM selected g LEFT JOIN task_facts t ON t.goal_id = g.id
           LEFT JOIN tasks failed ON failed.rowid = t.firstFailed
           LEFT JOIN tasks running ON running.rowid = t.firstRunning
           LEFT JOIN execution_facts e ON e.id = g.id
           LEFT JOIN executions x ON x.rowid = e.firstRunning
           LEFT JOIN tasks xt ON xt.id = x.task_id`,
        )
        .all(selected);
      return new Map(
        rows.map(
          ({
            goalId,
            total,
            done,
            failed,
            running,
            awaitingIntegration,
            ...facts
          }) => [
            goalId,
            {
              ...facts,
              progress: { total, done, failed, running, awaitingIntegration },
              approvals: approvals.get(goalId) ?? 0,
            },
          ],
        ),
      );
    });
  }

  inboxRows(
    includeResolved: boolean,
    cutoff: string,
    problemsOnly = false,
    limit = 200,
  ): InboxRow[] {
    return this.#read(() =>
      this.#db
        .query<InboxRow>(
          `
        WITH history(kind, version, at, goalId, taskId, proposalId, executionId,
                     modelText, wasResolved, code, rejectedCount, info, canRetry,
                     position, rejectedPathsJson) AS (
          SELECT CASE p.kind WHEN 'goal' THEN 'goal-registration'
                    WHEN 'task' THEN 'task-registration' ELSE 'integration' END,
                 p.id, p.created_at, json_extract(p.content_json, '$.goalId'),
                 json_extract(p.content_json, '$.taskId'), p.id, NULL,
                 json_extract(p.content_json, '$.title'), p.status <> 'pending', NULL, NULL, 0, 0,
                 NULL, NULL
          FROM proposals AS p
          WHERE p.status <> 'registered'
          UNION ALL
          SELECT CASE json_extract(e.data, '$.status') WHEN 'failed' THEN 'task-failed'
                    WHEN 'succeeded' THEN 'task-succeeded' ELSE 'task-running' END,
                 e.id, e.at, t.goal_id, t.id, NULL, NULL, json_extract(t.content_json, '$.title'),
                 CASE WHEN json_extract(e.data, '$.status') = 'succeeded' THEN 0 ELSE
                   ${laterTaskStatus} END,
                 json_extract(e.data, '$.code'), json_array_length(e.data, '$.rejectedPaths'),
                 json_extract(e.data, '$.status') <> 'failed',
                 t.status = 'failed' AND (
                   SELECT count(*) FROM events AS retry
                   WHERE retry.subject_id = t.id AND retry.kind = 'task.retried'
                     AND retry.subject_kind = 'task'
                 ) < ${MAX_TASK_RETRIES}, e.rowid,
                 CASE WHEN ?3 AND json_type(e.data, '$.rejectedPaths') = 'array'
                      THEN json_extract(e.data, '$.rejectedPaths') END
          FROM events AS e JOIN tasks AS t ON e.subject_id = t.id
          WHERE e.kind = 'task.status' AND e.subject_kind = 'task'
            AND json_extract(e.data, '$.status') IN ('failed', 'succeeded', 'running')
            AND (json_extract(e.data, '$.status') <> 'running' OR json_extract(e.data, '$.code') IS NULL)
          UNION ALL
          SELECT 'task-failed', x.id, x.finished_at, t.goal_id, t.id, NULL, x.id,
                 json_extract(t.content_json, '$.title'),
                 EXISTS (
                   SELECT 1 FROM executions AS newer
                   WHERE newer.task_id = t.id AND newer.actor = 'Executor' AND newer.mode = 'task'
                     AND newer.rowid > x.rowid
                 ) OR EXISTS (
                   SELECT 1 FROM events AS retry
                   WHERE retry.subject_id = t.id AND retry.subject_kind = 'task'
                     AND retry.kind = 'task.retried' AND retry.rowid > (
                       SELECT queued.rowid FROM events AS queued
                       WHERE queued.subject_id = x.id AND queued.subject_kind = 'execution'
                         AND queued.kind = 'execution.queued' LIMIT 1
                     )
                 ), 'path-violation', json_array_length(x.result_json, '$.rejectedPaths'), 0, 0,
                 (SELECT e.rowid FROM events AS e WHERE e.subject_id = x.id
                    AND e.subject_kind = 'execution' AND e.kind = 'execution.finished' LIMIT 1),
                 CASE WHEN json_type(x.result_json, '$.rejectedPaths') = 'array'
                      THEN json_extract(x.result_json, '$.rejectedPaths') END
          FROM executions AS x JOIN tasks AS t ON x.task_id = t.id
          WHERE ?3 AND x.actor = 'Executor' AND x.mode = 'task' AND x.status = 'failed'
            AND x.finished_at IS NOT NULL AND json_extract(x.result_json, '$.code') = 'path-violation'
          UNION ALL
          SELECT 'execution-over-budget', x.id, x.finished_at, coalesce(x.goal_id, t.goal_id),
                 x.task_id, NULL, x.id, CASE WHEN ?3 THEN coalesce(
                   json_extract(t.content_json, '$.title'), json_extract(g.content_json, '$.title')
                 ) END,
                 coalesce(${taskBudgetResolved}, 0),
                 NULL, NULL, 0, 0,
                 CASE WHEN ?3 THEN (SELECT e.rowid FROM events AS e WHERE e.subject_id = x.id
                    AND e.subject_kind = 'execution' AND e.kind = 'execution.finished' LIMIT 1) END,
                 NULL
          FROM executions AS x LEFT JOIN tasks AS t ON x.task_id = t.id
            LEFT JOIN goals AS g ON x.goal_id = g.id
          WHERE x.finished_at IS NOT NULL AND x.started_at IS NOT NULL
            AND ${executionOverBudget}
          UNION ALL
          SELECT 'goal-completed', g.id, coalesce((
                   SELECT e.at FROM events AS e WHERE e.subject_id = g.id
                     AND e.subject_kind = 'goal' AND e.kind = 'goal.status'
                     AND json_extract(e.data, '$.status') = 'done' ORDER BY e.rowid DESC LIMIT 1
                 ), g.created_at),
                 g.id, NULL, NULL, NULL, json_extract(g.content_json, '$.title'), 0, NULL, NULL, 1, 0,
                 NULL, NULL
          FROM goals AS g WHERE g.status = 'done'
        ), items AS (
          SELECT history.*, CASE WHEN NOT ?3 THEN wasResolved OR coalesce(g.status = 'cancelled', 0)
            WHEN g.status IS NOT 'active' OR t.status IN ('succeeded', 'cancelled') THEN 1
            WHEN kind = 'execution-over-budget' THEN wasResolved
            WHEN executionId IS NOT NULL THEN wasResolved
            ELSE wasResolved OR t.status IS NOT 'failed'
          END AS resolved
          FROM history LEFT JOIN goals AS g ON history.goalId = g.id
            LEFT JOIN tasks AS t ON ?3 AND history.taskId = t.id
          WHERE NOT ?3 OR kind IN ('task-failed', 'execution-over-budget')
        ), ranked AS (
          SELECT *, ${
            problemsOnly
              ? `row_number() OVER (
                  PARTITION BY kind, (code IS 'path-violation'), taskId,
                               CASE WHEN taskId IS NULL THEN version END
                  ORDER BY at DESC, position DESC, version DESC
                )`
              : "1"
          } AS rank
          FROM items WHERE (?1 OR NOT resolved)
            AND (?3 OR NOT info OR at >= ?2 OR (kind = 'task-running' AND NOT resolved))
        )
        SELECT kind || ':' || CASE WHEN kind IN ('task-failed', 'task-succeeded', 'task-running')
                                   THEN taskId || ':' ELSE '' END || version AS id,
               kind, at, goalId, taskId, proposalId, executionId, modelText, resolved, code,
               rejectedCount, canRetry, rejectedPathsJson,
               (SELECT ref FROM goals WHERE id = ranked.goalId OR proposal_id = ranked.proposalId) AS goalRef,
               (SELECT ref FROM tasks WHERE id = ranked.taskId OR proposal_id = ranked.proposalId) AS taskRef,
               (SELECT count(*) FROM events WHERE subject_id = ranked.taskId
                  AND subject_kind = 'task' AND kind = 'task.retried') AS retries
        FROM ranked WHERE rank = 1
        ORDER BY (NOT resolved AND NOT info) DESC, at DESC,
                 CASE WHEN ?3 THEN position END DESC, version DESC LIMIT ?4
      `,
        )
        .all(Number(includeResolved), cutoff, Number(problemsOnly), limit),
    );
  }

  inboxSeen(ids: readonly string[]): ReadonlySet<string> {
    return this.#read(
      () =>
        new Set(
          this.#db
            .query<{ id: string }>(
              "SELECT id FROM inbox_seen WHERE id IN (SELECT value FROM json_each(?))",
            )
            .all(JSON.stringify(ids))
            .map(({ id }) => id),
        ),
    );
  }

  markInboxSeen(ids: readonly string[]): void {
    if (!ids.length) return;
    this.#write(() => {
      this.#db
        .query(
          "INSERT OR IGNORE INTO inbox_seen SELECT value FROM json_each(?)",
        )
        .run(JSON.stringify(ids));
    });
  }

  listEvents(options: { subjectId?: string; limit: number }) {
    const input = fields(options, ["subjectId", "limit"]);
    const subjectId = Object.hasOwn(input, "subjectId")
      ? identifier(input.subjectId)
      : null;
    const limit = integer(input.limit, 1, 1000);
    return this.#read(() => {
      const resolvedSubject =
        subjectId === null ? null : this.#taskId(this.#goalId(subjectId));
      return freeze(
        this.#db
          .query<EventRow>(
            `SELECT ${eventColumns} FROM events ${resolvedSubject === null ? "" : "WHERE subject_id = ?"} ORDER BY rowid DESC LIMIT ?`,
          )
          .all(
            ...(resolvedSubject === null ? [limit] : [resolvedSubject, limit]),
          )
          .map(({ data, ...row }) => {
            const eventData: unknown = JSON.parse(data);
            return freeze({ ...row, data: eventData });
          }),
      );
    });
  }

  decisionHistory(limit = 20) {
    integer(limit, 1, 200);
    return this.#read(() => {
      const rows = this.#db
        .query<{
          id: string;
          proposalId: string;
          gate: Gate;
          result: Decision;
          at: string;
          policy: Policy;
          source: EffectivePolicy["source"];
          details: string | null;
          reasons: string | null;
          executionResult: string | null;
          goalId: string | null;
          taskId: string | null;
        }>(
          `
        SELECT a.id, a.proposal_id AS proposalId, a.gate, a.decision AS result, a.at,
          a.policy, a.policy_source AS source, a.policy_details_json AS details,
          a.reasons_json AS reasons, e.result_json AS executionResult,
          coalesce(g.id, json_extract(p.content_json, '$.goalId')) AS goalId,
          coalesce(t.id, json_extract(p.content_json, '$.taskId')) AS taskId
        FROM approvals a JOIN proposals p ON p.id = a.proposal_id
        LEFT JOIN goals g ON g.proposal_id = p.id
        LEFT JOIN tasks t ON t.proposal_id = p.id
        LEFT JOIN executions e ON e.id = json_extract(a.answerer_json, '$.executionId')
        WHERE a.answerer_kind = 'agent' ORDER BY a.rowid DESC LIMIT ?
      `,
        )
        .all(limit);
      let bytes = 0;
      const history = [];
      for (const {
        policy,
        source,
        details,
        reasons,
        executionResult,
        ...row
      } of rows) {
        const entry = {
          ...row,
          ...this.#subjectRefs(row.goalId, row.taskId),
          setting: details
            ? (JSON.parse(details) as EffectivePolicy)
            : { policy, source },
          reasons: (() => {
            const modelReasons: unknown = reasons
              ? JSON.parse(reasons)
              : executionResult
                ? JSON.parse(executionResult)?.reasons
                : undefined;
            return Array.isArray(modelReasons)
              ? modelReasons.filter(
                  (reason): reason is string => typeof reason === "string",
                )
              : [];
          })(),
        };
        bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes > 768 * 1024) break;
        history.push(entry);
      }
      return freeze(history);
    });
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
          const suppliedGoalId = goalId === null ? null : this.#goalId(goalId);
          if (task && suppliedGoalId !== null && task.goalId !== suppliedGoalId)
            throw new OrchestratorStoreError("context-mismatch");
          const id = task?.goalId ?? suppliedGoalId;
          const layers =
            id === null
              ? { defaults: this.#defaults() }
              : this.#goalLayers(goalRecord(required(this.#goal(id))).content);
          if (validGate === "integration" && task && id !== null) {
            const latest = this.#latestIntegrationProposalId(task.id);
            const row = latest && this.#proposal(latest);
            const proposal = row ? proposalRecord(row) : null;
            return freeze(
              this.#integrationPolicy(
                task,
                goalRecord(required(this.#goal(id))).content,
                proposal?.kind === "integration" &&
                  (task.status === "awaiting-integration" ||
                    task.status === "succeeded" ||
                    (task.status === "running" &&
                      this.#integrationProgress(task.id)?.proposalId ===
                        proposal.id))
                  ? proposal
                  : undefined,
              ),
            );
          }
          return freeze(
            this.#resolveGate(
              validGate,
              {
                ...layers,
                task: task?.content.policies ?? {},
              },
              id === null ? {} : { goalId: id },
            ),
          );
        })
        .deferred(),
    );
  }
}
