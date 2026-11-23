import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { readClaudeRunMetrics } from "../claude-code.ts";
import { JsonlWriter } from "../jsonl-files.ts";
import { ACTOR_KINDS } from "./model.ts";
import { readTokenReport } from "./token-usage.ts";

type Row = Record<string, unknown>;
const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (
    filename: string,
    options: { readonly: boolean; create: boolean; strict: boolean },
  ) => {
    exec(sql: string): unknown;
    query<T>(sql: string): { iterate(): Iterable<T>; get(): T | null };
    transaction(work: () => void): () => void;
    close(): void;
  };
};
type Stream = keyof typeof queries;
type Checkpoint = { generation: string; digest: string };
type ExportState = {
  version: 1;
  source: string;
  streams: Partial<Record<Stream, Checkpoint>>;
};

const word = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const label = (value: unknown, pattern = word) =>
  typeof value === "string" && value.length <= 200 && pattern.test(value)
    ? value
    : null;
const known = (value: unknown, names: readonly string[]) =>
  typeof value === "string" && names.includes(value) ? value : null;

const failureCodes = [
  "actor-failed",
  "approval-forbidden",
  "branch-collision",
  "candidate-failed",
  "candidate-mismatch",
  "closed",
  "context-mismatch",
  "contract-violation",
  "evidence",
  "file-limits",
  "goal-base-mismatch",
  "goal-inactive",
  "host-error",
  "integration-evidence",
  "integration-in-progress",
  "integration-interrupted",
  "integration-rejected",
  "integration-uncertain",
  "interrupted",
  "invalid-context-path",
  "invalid-transition",
  "no-approval",
  "not-found",
  "path-violation",
  "policy-loosening",
  "prompt-too-large",
  "queue-full",
  "read-failed",
  "revision-limit",
  "review-concern",
  "session-busy",
  "session-ended",
  "stale-base",
  "stale-digest",
  "task-constraints",
  "timed-out",
  "verification",
  "verification-failed",
  "write-failed",
  "unsafe-repository",
  "invalid-object",
];
const failureCode = (value: unknown) =>
  value == null ? null : (known(value, failureCodes) ?? "other");

function object(value: unknown): Row {
  if (typeof value !== "string") return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Row)
    : {};
}

function eventFields(kind: unknown, data: Row) {
  switch (kind) {
    case "task.status":
      return {
        status: known(data.status, [
          "registered",
          "running",
          "awaiting-integration",
          "succeeded",
          "failed",
          "cancelled",
        ]),
        code: failureCode(data.code),
        proposal_id: label(data.proposalId),
      };
    case "task.integrated":
      return { proposal_id: label(data.proposalId) };
    case "session.ended":
      return {
        mode: known(data.mode, ["default", "acceptEdits", "plan", "auto"]),
        status: known(data.status, ["succeeded", "failed"]),
        code: failureCode(data.code),
      };
    case "session.audit-export":
      return { exported: data.exported === true };
    default:
      return {};
  }
}

// Only project structured fields. Prompt, result and event text can contain
// repository data, credentials or a delegated answer's authorization.
const queries = {
  executions: {
    sql: `SELECT rowid AS sequence, id, actor, mode, goal_id, task_id, status, started_at, finished_at,
                 result_json, requested_by_json FROM executions ORDER BY rowid`,
    project({ result_json, requested_by_json, ...row }: Row) {
      const result = object(result_json);
      const { usage, rawUsage, tokens } = readTokenReport(result, false);
      const raw = rawUsage ?? usage;
      const counts = Array.isArray(raw)
        ? raw
        : raw && raw !== "unavailable"
          ? [raw]
          : [];
      const sum = (key: "input" | "output" | "cacheCreation" | "cacheRead") =>
        counts.length
          ? Math.min(
              Number.MAX_SAFE_INTEGER,
              counts.reduce((total, count) => total + count[key], 0),
            )
          : null;
      const origin = object(requested_by_json);
      return {
        ...row,
        actor: known(row.actor, ACTOR_KINDS),
        mode: label(row.mode),
        session_id: label(origin.sessionId),
        invocation_id: label(result.invocationId),
        approval_proposal_id:
          row.mode === "approval" ? label(result.proposalId) : null,
        failure_code: failureCode(result.code),
        review_verdict: known(result.review, ["pass", "revise", "concern"]),
        revision: typeof result.revision === "boolean" ? result.revision : null,
        verification_phase: known(result.phase, ["integration"]),
        tokens,
        input_tokens: sum("input"),
        output_tokens: sum("output"),
        cache_creation_tokens: sum("cacheCreation"),
        cache_read_tokens: sum("cacheRead"),
        usage_complete: usage !== null && usage !== "unavailable",
        ...readClaudeRunMetrics(result, row.actor === "Planner" ? 2 : 1),
      };
    },
  },
  tasks: {
    sql: "SELECT id, goal_id, proposal_id, status, created_at FROM tasks ORDER BY rowid",
  },
  goals: {
    sql: "SELECT id, proposal_id, status, created_at FROM goals ORDER BY rowid",
  },
  proposals: {
    sql: `SELECT id, kind, status, created_at, decided_at, source_json, content_json
          FROM proposals ORDER BY rowid`,
    project({ source_json, content_json, ...row }: Row) {
      const source = object(source_json);
      const content = object(content_json);
      return {
        ...row,
        execution_id: label(source.executionId),
        goal_id: row.kind === "goal" ? null : label(content.goalId),
        task_id: row.kind === "integration" ? label(content.taskId) : null,
      };
    },
  },
  approvals: {
    sql: `SELECT id, proposal_id, gate, policy, policy_source, decision, at,
                 answerer_kind, answerer_json FROM approvals ORDER BY rowid`,
    project({ answerer_json, ...row }: Row) {
      const answerer = object(answerer_json);
      const delegate = answerer.delegate as Row | undefined;
      const delegated =
        row.answerer_kind === "human" && delegate?.agent === "claude-code";
      return {
        ...row,
        delegated,
        agent: delegated ? "claude-code" : null,
        session: delegated ? label(delegate?.session) : null,
        execution_id:
          row.answerer_kind === "agent" ? label(answerer.executionId) : null,
      };
    },
  },
  sessions: {
    sql: "SELECT id, actor, runtime_id, status, started_at, ended_at FROM actor_sessions ORDER BY rowid",
  },
  events: {
    sql: `SELECT rowid AS sequence, id, at, kind, subject_kind, subject_id, session_id,
                 execution_id, data FROM events ORDER BY rowid`,
    project({ data, ...row }: Row) {
      return { ...row, ...eventFields(row.kind, object(data)) };
    },
  },
} satisfies Record<string, { sql: string; project?: (row: Row) => Row }>;

function project(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "string"
        ? label(value, key === "at" || key.endsWith("_at") ? timestamp : word)
        : value,
    ]),
  );
}

function syncDirectory(path: string): void {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function loadState(path: string, source: string): ExportState {
  const info = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!info) return { version: 1, source, streams: {} };
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096)
    throw new Error("Invalid orchestrator export state");
  const state = JSON.parse(fs.readFileSync(path, "utf8")) as ExportState;
  if (state.version !== 1 || state.source !== source || !state.streams)
    throw new Error("Invalid orchestrator export state");
  for (const [stream, checkpoint] of Object.entries(state.streams)) {
    if (
      !Object.hasOwn(queries, stream) ||
      !/^[a-f0-9-]{36}$/.test(checkpoint.generation) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.digest)
    )
      throw new Error("Invalid orchestrator export state");
  }
  return state;
}

function saveState(directory: string, state: ExportState): void {
  const temporary = join(directory, `.export-state-${randomUUID()}.partial`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, join(directory, "export-state.json"));
    syncDirectory(directory);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Publish changed stream snapshots together from one read-only transaction.
 * DuckDB reads only the generations selected by the committed checkpoint. */
export function exportOrchestrator(stateDb: string, obsDir: string): void {
  const filename = resolve(stateDb);
  const stat = fs.lstatSync(filename, { bigint: true });
  if (!stat.isFile()) throw new Error("Invalid orchestrator database");
  const source = `${stat.dev}:${stat.ino}`;
  const directory = join(resolve(obsDir), "orchestrator");
  const lock = new JsonlWriter(directory);
  try {
    const state = loadState(join(directory, "export-state.json"), source);
    const db = new Database(filename, {
      readonly: true,
      create: false,
      strict: true,
    });
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON");
      if (
        db.query<{ application_id: number }>("PRAGMA application_id").get()
          ?.application_id !== 0x4c4f5231
      )
        throw new Error("Invalid orchestrator database");
      db.transaction(() => {
        let changed = false;
        const generation = randomUUID();
        for (const stream of Object.keys(queries) as Stream[]) {
          const spec: { sql: string; project?: (row: Row) => Row } =
            queries[stream];
          const query = db.query<Row>(spec.sql);
          const records = function* () {
            for (const row of query.iterate())
              yield project(spec.project?.(row) ?? row);
          };
          const hash = createHash("sha256");
          for (const record of records())
            hash.update(JSON.stringify(record)).update("\n");
          const digest = hash.digest("hex");
          if (state.streams[stream]?.digest === digest) continue;
          const streamDirectory = join(directory, stream);
          const writer = new JsonlWriter(streamDirectory);
          try {
            for (const record of records())
              writer.write({ ...record, generation });
          } finally {
            writer.close();
          }
          syncDirectory(streamDirectory);
          state.streams[stream] = { generation, digest };
          changed = true;
        }
        if (changed) saveState(directory, state);
      })();
    } finally {
      db.close();
    }
  } finally {
    lock.close();
  }
}
