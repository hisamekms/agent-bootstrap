import type { PackageDiff } from "./environments/lock.ts";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import {
  AuditStoreError,
  SqliteAudit,
  type AuditEvent,
  type AuditExportRecord,
  type AuditSequenceWatermark,
  type ExecutionAudit,
} from "./audit.ts";
import {
  JsonlFileError,
  JsonlWriter,
  type JsonlWriterOptions,
} from "./jsonl-files.ts";

const schemaVersion = "agent-bootstrap.audit/v1";
const tables = [
  "audit_events",
  "execution_contexts",
  "sandbox_bindings",
  "process_results",
  "network_events",
  "resource_events",
] as const satisfies readonly AuditExportRecord["table"][];
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const finalFilePattern = /^(\d{4}-\d{2}-\d{2})-(\d{4})\.jsonl$/u;
const auditIdPattern = new RegExp(
  `^(?:${tables.join("|")}|derived_audit_events|derived_network_events):[1-9]\\d*$`,
  "u",
);
const readFlags =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

type AuditLine = {
  auditId: string;
  schemaVersion: typeof schemaVersion;
  recordedAt: string;
  executionId: string;
  sandboxId: string | null;
  operationId: string | null;
  actor: NonNullable<AuditEvent["role"]> | "host" | "gateway";
  action: string;
  target: string | null;
  phase: "intent" | "decision" | "outcome";
  result: string | null;
  policyId: string | null;
  reasonCode: string | null;
  traceId: string | null;
  attributes: Readonly<
    Record<
      string,
      | string
      | number
      | boolean
      | null
      | readonly string[]
      | PackageDiff
      | readonly { name: string; mode: string; path: string }[]
    >
  >;
  derived?: true;
};

function executionId(row: AuditExportRecord): string {
  return row.table === "execution_contexts"
    ? row.executionId
    : row.invocationId;
}

function networkKey(row: {
  invocationId: string;
  sandboxId: string;
  connectionId: string;
}): string {
  return `${row.invocationId}/${row.sandboxId}/${row.connectionId}`;
}

function executionRows(history: ExecutionAudit): AuditExportRecord[] {
  return [
    ...history.auditEvents.map((row) => ({
      ...row,
      table: "audit_events" as const,
    })),
    ...history.executionContexts.map((row) => ({
      ...row,
      table: "execution_contexts" as const,
    })),
    ...history.sandboxBindings.map((row) => ({
      ...row,
      table: "sandbox_bindings" as const,
    })),
    ...history.processResults.map((row) => ({
      ...row,
      table: "process_results" as const,
    })),
    ...history.networkEvents.map((row) => ({
      ...row,
      table: "network_events" as const,
    })),
    ...history.resourceEvents.map((row) => ({
      ...row,
      table: "resource_events" as const,
    })),
  ];
}

/** Build phase links against one SQLite snapshot, including older intents
 * whose outcomes may have arrived since the previous export. */
function project(rows: AuditExportRecord[], watermark: AuditSequenceWatermark) {
  const contexts = new Map<
    string,
    Extract<AuditExportRecord, { table: "execution_contexts" }>
  >();
  const bindings = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.table === "execution_contexts") contexts.set(row.executionId, row);
    if (row.table === "sandbox_bindings") {
      const ids = bindings.get(row.invocationId) ?? new Set<string>();
      ids.add(row.sandboxId);
      bindings.set(row.invocationId, ids);
    }
  }

  const operations = new Map<string, { line: AuditLine; allowed: boolean }[]>();
  const connections = new Map<string, AuditLine>();
  const records = new Map<string, AuditLine>();
  for (const row of rows) {
    const id = executionId(row);
    const trace = contexts.get(id)?.traceContext;
    const ids = bindings.get(id);
    const line: AuditLine = {
      auditId: `${row.table}:${row.sequence}`,
      schemaVersion,
      recordedAt: row.recordedAt,
      executionId: id,
      sandboxId: ids?.size === 1 ? [...ids][0]! : null,
      operationId: null,
      actor: "host",
      action: "",
      target: null,
      phase: "outcome",
      result: null,
      policyId: null,
      reasonCode: null,
      traceId: trace?.traceparent.slice(3, 35) ?? null,
      attributes: {},
    };

    switch (row.table) {
      case "audit_events": {
        line.actor = row.role ?? "host";
        line.action = row.kind.startsWith("environment.")
          ? row.kind
          : (row.operation ?? "invocation");
        switch (row.kind) {
          case "environment.started":
          case "invocation.started":
          case "operation.requested":
            line.phase = "intent";
            break;
          case "operation.allowed":
          case "operation.denied":
            line.phase = "decision";
            line.result = row.kind === "operation.allowed" ? "allow" : "deny";
            break;
          default:
            line.result =
              row.kind === "environment.finished" &&
              row.detail &&
              "key" in row.detail
                ? (row.detail.failure ?? "ok")
                : (row.outcome ?? null);
        }
        if (row.profile && row.image) {
          line.attributes = { profile: row.profile, image: row.image };
        }
        if (row.detail) line.attributes = { ...line.attributes, ...row.detail };
        if (row.detail && "event" in row.detail) {
          line.action = row.detail.event;
          line.phase =
            row.detail.event === "secret.served" ? "intent" : "outcome";
          break;
        }
        if (row.operation) {
          const key = `${id}/${row.operation}`;
          const open = operations.get(key) ?? [];
          if (row.kind === "operation.requested") {
            line.operationId = line.auditId;
            open.push({ line, allowed: false });
            operations.set(key, open);
          } else {
            const index = open.findIndex((entry) =>
              row.kind === "operation.finished"
                ? entry.allowed
                : !entry.allowed,
            );
            const entry = open[index];
            if (entry) {
              line.operationId = entry.line.operationId;
              if (row.kind === "operation.allowed") {
                entry.allowed = true;
              } else {
                open.splice(index, 1);
                if (!open.length) operations.delete(key);
              }
            } else if (row.kind === "operation.allowed") {
              // A legacy journal has no cross-row constraints.
              line.operationId = line.auditId;
              open.push({ line, allowed: true });
              operations.set(key, open);
            }
          }
        }
        break;
      }
      case "execution_contexts":
        line.action = "execution.context";
        line.attributes = {
          ...row.attributes,
          ...(row.retryOfExecutionId && {
            retryOfExecutionId: row.retryOfExecutionId,
          }),
        };
        break;
      case "sandbox_bindings":
        line.action = "sandbox.bind";
        line.phase = "intent";
        line.sandboxId = row.sandboxId;
        line.policyId = row.gatewayPolicyId ?? null;
        line.attributes = {
          runtimeKind: row.runtimeKind,
          egressMode: row.egressMode,
          netRuleDigest: row.netRuleDigest,
          gatewayPolicyDigest: row.gatewayPolicyDigest ?? null,
        };
        break;
      case "process_results":
        line.action = "process.exec";
        line.attributes = {
          exitCode: row.exitCode,
          signal: row.signal,
          guestReported: row.guestReported,
        };
        break;
      case "resource_events":
        line.action = "resource.event";
        line.sandboxId = row.sandboxId ?? line.sandboxId;
        line.result = row.kind;
        break;
      case "network_events": {
        line.actor = "gateway";
        line.sandboxId = row.sandboxId;
        if (row.phase === "dns") {
          line.operationId = row.queryId;
          line.action = "network.dns";
          line.target = row.qname;
          line.phase = "decision";
          line.result = row.decision;
          line.policyId = row.policyId;
          line.reasonCode = row.reasonCode;
          line.attributes = {
            protocol: row.protocol,
            qtype: row.qtype,
            answerIps: row.answerIps,
          };
          break;
        }
        line.action = "network.connect";
        line.operationId = row.connectionId;
        if (row.phase === "finished") {
          const decision = connections.get(networkKey(row));
          line.target = decision?.target ?? null;
          line.policyId = decision?.policyId ?? null;
          line.result = row.result;
          line.attributes = {
            ...decision?.attributes,
            protocol: row.protocol,
            endReason: row.endReason,
            bytesSent: row.bytesSent,
            bytesReceived: row.bytesReceived,
            durationMs: row.durationMs,
          };
          connections.delete(networkKey(row));
          break;
        }
        line.target =
          row.destinationIp === undefined
            ? null
            : row.destinationIp.includes(":")
              ? `[${row.destinationIp}]:${row.destinationPort}`
              : `${row.destinationIp}:${row.destinationPort}`;
        line.phase = row.phase === "requested" ? "intent" : "decision";
        line.attributes = {
          protocol: row.protocol,
          destinationIp: row.destinationIp ?? null,
          destinationPort: row.destinationPort ?? null,
          hostname: row.hostname ?? null,
          channel: row.channel ?? null,
        };
        if (row.phase === "decided") {
          line.result = row.decision;
          line.policyId = row.policyId;
          line.reasonCode = row.reasonCode;
          if (row.decision === "allow") connections.set(networkKey(row), line);
        }
        break;
      }
    }
    if (row.sequence > (watermark[row.table] ?? 0))
      records.set(line.auditId, line);
  }
  return {
    records,
    open: new Set([
      ...[...operations.values()].flatMap((entries) =>
        entries.map((entry) => entry.line),
      ),
      ...connections.values(),
    ]),
  };
}

function* projectBatch(
  audit: SqliteAudit,
  rows: AuditExportRecord[],
  previous: AuditSequenceWatermark,
  through: AuditSequenceWatermark,
): Generator<{ line: AuditLine; open: boolean }> {
  // On the first export, the incremental snapshot already has all history.
  if (!Object.keys(previous).length) {
    const { records, open } = project(rows, previous);
    for (const line of records.values()) yield { line, open: open.has(line) };
    return;
  }

  const projected = new Map<string, { line: AuditLine; open: boolean }>();
  for (const id of new Set(rows.map(executionId))) {
    // Concurrent appends cannot change existing rows. Clip the per-execution
    // reads to the sequence bounds from the single incremental snapshot.
    const history = executionRows(audit.readExecution(id)).filter(
      (row) => row.sequence <= (through[row.table] ?? 0),
    );
    const { records, open } = project(history, previous);
    for (const [id, line] of records) {
      projected.set(id, { line, open: open.has(line) });
    }
  }
  for (const row of rows) {
    const entry = projected.get(`${row.table}:${row.sequence}`);
    if (!entry) throw new AuditStoreError("read-failed");
    yield entry;
  }
}

type ExportState = {
  source: string;
  watermark: AuditSequenceWatermark;
  files: Record<string, number>;
};

function invalidState(): never {
  throw new Error("Invalid audit export state");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidState();
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalidState();
  return value;
}

function readPrivateFile(path: string): string {
  const fd = fs.openSync(path, readFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.geteuid?.()
    )
      return invalidState();
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function loadState(path: string, source: string): ExportState | undefined {
  if (!fs.lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const state = object(JSON.parse(readPrivateFile(path)));
  if (state.source !== source) return invalidState();
  const watermark: Partial<Record<AuditExportRecord["table"], number>> = {};
  for (const [key, value] of Object.entries(object(state.watermark))) {
    const table = tables.find((name) => name === key);
    if (!table) return invalidState();
    watermark[table] = integer(value, 0, Number.MAX_SAFE_INTEGER);
  }
  const files: Record<string, number> = {};
  for (const [day, number] of Object.entries(object(state.files))) {
    if (!dayPattern.test(day)) return invalidState();
    files[day] = integer(number, 1, 9999);
  }
  return { source, watermark, files };
}

type ExportFs = NonNullable<JsonlWriterOptions["fs"]>;

function syncDirectory(io: ExportFs, dir: string): void {
  const fd = io.openSync(dir, readFlags | fs.constants.O_DIRECTORY);
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

function saveState(
  io: ExportFs,
  dir: string,
  path: string,
  state: ExportState,
): void {
  const temporary = join(dir, `export-state.${randomUUID()}.partial`);
  const fd = io.openSync(temporary, "wx", 0o600);
  try {
    try {
      const data = Buffer.from(`${JSON.stringify(state)}\n`);
      if (io.writeSync(fd, data) !== data.length)
        throw new JsonlFileError("write-failed");
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    io.renameSync(temporary, path);
    syncDirectory(io, dir);
  } finally {
    if (io.lstatSync(temporary, { throwIfNoEntry: false }))
      io.unlinkSync(temporary);
  }
}

function finalizedFiles(dir: string, files: ExportState["files"]): string[] {
  return fs
    .readdirSync(dir)
    .sort()
    .filter((name) => {
      const match = finalFilePattern.exec(name);
      return match && Number(match[2]) > (files[match[1]!] ?? 0);
    });
}

function recoverPublished(dir: string, files: string[]): Set<string> {
  const ids = new Set<string>();
  // A prior run may have published one or more files before committing its
  // watermark. Only complete, finalized files count toward recovery.
  for (const name of files) {
    const lines = readPrivateFile(join(dir, name)).split("\n");
    if (lines.pop() !== "" || !lines.length) return invalidState();
    for (const line of lines) {
      const record = object(JSON.parse(line));
      if (
        record.schemaVersion !== schemaVersion ||
        typeof record.auditId !== "string" ||
        !auditIdPattern.test(record.auditId) ||
        ids.has(record.auditId)
      )
        return invalidState();
      ids.add(record.auditId);
    }
  }
  return ids;
}

export function exportAudit(
  filename: string,
  obsDir: string,
  options: JsonlWriterOptions = {},
): void {
  for (const _ of auditExportRecords(filename, obsDir, options)) {
    // The synchronous exporter consumes the same projected records.
  }
}

export async function exportAuditChecked(
  filename: string,
  obsDir: string,
  scan: (text: string) => Promise<void>,
): Promise<void> {
  for (const batch of auditExportRecords(filename, obsDir, {}))
    await scan(batch.map((line) => JSON.stringify(line)).join("\n"));
}

function* auditExportRecords(
  filename: string,
  obsDir: string,
  options: JsonlWriterOptions,
): Generator<AuditLine[], void> {
  const database = resolve(filename);
  const stat = fs.statSync(database, { bigint: true });
  if (!stat.isFile()) throw new AuditStoreError("open-failed");
  const source = `${stat.dev}:${stat.ino}`;
  const audit = new SqliteAudit(database, { readonly: true });
  try {
    const dir = join(resolve(obsDir), "audit");
    const lock = join(dir, "writer.lock");
    const io = options.fs ?? fs;
    let ownsLock = false;
    const writer = new JsonlWriter(dir, {
      ...options,
      fs: {
        ...io,
        unlinkSync(path) {
          // Keep OBS-09a's exclusive lock until the checkpoint is durable.
          // During construction the writer still owns its own error cleanup.
          if (!ownsLock || path !== lock) io.unlinkSync(path);
        },
      },
    });
    ownsLock = true;
    try {
      const path = join(dir, "export-state.json");
      let state = loadState(path, source);
      if (!state) {
        if (finalizedFiles(dir, {}).length) return invalidState();
        state = { source, watermark: {}, files: {} };
        saveState(io, dir, path, state);
      }
      const recovered = finalizedFiles(dir, state.files);
      const rows = audit.readSince(state.watermark);
      if (!recovered.length && !rows.length) return;
      const published = recoverPublished(dir, recovered);
      const watermark = { ...state.watermark };
      for (const row of rows) watermark[row.table] = row.sequence;
      const derived: AuditLine[] = [];
      const pending: AuditLine[] = [];
      function* publish() {
        if (!pending.length) return;
        yield pending;
        for (const line of pending) writer.write(line);
        pending.length = 0;
      }
      for (const { line, open } of projectBatch(
        audit,
        rows,
        state.watermark,
        watermark,
      )) {
        if (!published.has(line.auditId)) pending.push(line);
        if (pending.length >= 256) yield* publish();
        if (open) {
          const auditId = `derived_${line.auditId}`;
          if (!published.has(auditId)) {
            derived.push({
              ...line,
              auditId,
              phase: "outcome",
              result: "unknown",
              derived: true,
            });
          }
        }
      }
      for (const line of derived) {
        pending.push(line);
        if (pending.length >= 256) yield* publish();
      }
      yield* publish();
      writer.close();
      const files = { ...state.files };
      for (const name of finalizedFiles(dir, state.files)) {
        const [, day, index] = finalFilePattern.exec(name)!;
        files[day!] = Number(index);
      }
      syncDirectory(io, dir);
      saveState(io, dir, path, { source, watermark, files });
    } finally {
      try {
        writer.close();
      } finally {
        io.unlinkSync(lock);
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOSPC")
      throw new JsonlFileError("disk-full");
    throw error;
  } finally {
    audit.close();
  }
}

if (import.meta.main) {
  const [filename, obsDir] = process.argv.slice(2);
  if (!filename || !obsDir || process.argv.length !== 4) {
    console.error("Usage: bun src/audit-export.ts <audit.sqlite> <obs-dir>");
    process.exitCode = 2;
  } else {
    try {
      exportAudit(filename, obsDir);
    } catch (error) {
      if (error instanceof JsonlFileError && error.code === "stale-lock") {
        console.error(
          `${error.message}. Verify the exporter is stopped, remove audit/writer.lock, and retry.`,
        );
      } else {
        console.error(
          error instanceof AuditStoreError || error instanceof JsonlFileError
            ? error.message
            : "Audit export failed",
        );
      }
      process.exitCode = 1;
    }
  }
}
