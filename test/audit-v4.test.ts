import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AuditInput,
  AuditStoreError,
  auditSchemaSql,
  SqliteAudit,
} from "../src/audit.ts";

interface Db {
  exec(sql: string): unknown;
  query(sql: string): { all(): unknown[]; get(): unknown };
  close(): void;
}
const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (filename: string, options: { create: boolean }) => Db;
};

const digest = "a".repeat(64);

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-audit-v4-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "audit.sqlite");
}

function userVersion(filename: string): unknown {
  const db = new Database(filename, { create: false });
  try {
    return (db.query("PRAGMA user_version").get() as Record<string, unknown>)
      .user_version;
  } finally {
    db.close();
  }
}

function legacy(filename: string, version: 1 | 2 | 3) {
  const db = new Database(filename, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  for (const sql of auditSchemaSql(version)) db.exec(sql);
  db.exec(
    `PRAGMA application_id=${0x41424731}; PRAGMA user_version=${version}`,
  );
  db.close();
}

const create = (id: string, extra: Partial<AuditInput> = {}): AuditInput => ({
  invocationId: id,
  kind: "operation.requested",
  operation: "sandbox.create",
  role: "Worker",
  ...extra,
});

function code(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AuditStoreError);
    return error.code;
  }
  return undefined;
}

test("a new database is v7 and round-trips profile, image and Verification", (t) => {
  const filename = fixture(t);
  const id = randomUUID();
  const audit = new SqliteAudit(filename);
  audit.append(
    create(id, { profile: "db", image: digest, role: "Verification" }),
  );
  audit.append(
    create(id, { profile: "browser", image: "0123456789abcdef".repeat(4) }),
  );
  audit.append(create(id));
  audit.close();
  assert.equal(userVersion(filename), 7);
  const reopened = new SqliteAudit(filename, { readonly: true });
  t.after(() => reopened.close());
  const events = reopened.read(id);
  assert.equal(events[0]?.profile, "db");
  assert.equal(events[0]?.image, digest);
  assert.equal(events[0]?.role, "Verification");
  assert.equal(events[1]?.profile, "browser");
  assert.equal(events[2]?.profile, undefined);
  assert.equal(events[2]?.image, undefined);
});

test("invalid profile and image combinations are rejected", (t) => {
  const filename = fixture(t);
  const id = randomUUID();
  const audit = new SqliteAudit(filename);
  t.after(() => audit.close());
  const bad: unknown[] = [
    create(id, { profile: "base" }),
    create(id, { image: digest }),
    create(id, { profile: "base", image: "A".repeat(64) }),
    create(id, { profile: "base", image: "a".repeat(63) }),
    create(id, { profile: "base", image: `${digest}\n` }),
    create(id, { profile: "gpu" as never, image: digest }),
    create(id, { profile: "base", image: 5 as never }),
    create(id, { profile: "base", image: digest, operation: "sandbox.exec" }),
    create(id, { profile: "base", image: digest, kind: "operation.allowed" }),
    {
      invocationId: id,
      kind: "invocation.started",
      profile: "base",
      image: digest,
    },
  ];
  for (const event of bad)
    assert.equal(
      code(() => audit.append(event as AuditInput)),
      "invalid-event",
    );
  assert.deepEqual(audit.read(id), []);
  // A rejected event does not quarantine the store.
  audit.append(create(id, { profile: "base", image: digest }));
  assert.equal(audit.read(id).length, 1);
});

test("v1-v3 databases append plain events and refuse v4 evidence", (t) => {
  for (const version of [1, 2, 3] as const) {
    const filename = fixture(t);
    legacy(filename, version);
    const id = randomUUID();
    const audit = new SqliteAudit(filename);
    audit.append(create(id));
    for (const event of [
      create(id, { profile: "base", image: digest }),
      create(id, { role: "Verification" }),
    ])
      assert.equal(
        code(() => audit.append(event)),
        "invalid-event",
      );
    audit.append(create(id, { role: "Reviewer" }));
    assert.equal(audit.read(id).length, 2);
    audit.close();
    assert.equal(userVersion(filename), version === 1 ? 2 : version);
    const again = new SqliteAudit(filename, { readonly: true });
    assert.equal(again.read(id).length, 2);
    again.close();
  }
});

test("a database with a v4 version but the v3 schema is rejected", (t) => {
  const filename = fixture(t);
  legacy(filename, 3);
  const db = new Database(filename, { create: false });
  db.exec("PRAGMA user_version=4");
  db.close();
  assert.equal(
    code(() => new SqliteAudit(filename)),
    "open-failed",
  );
});

test("v4 rows stay append-only", (t) => {
  const filename = fixture(t);
  const id = randomUUID();
  const audit = new SqliteAudit(filename);
  audit.append(create(id, { profile: "base", image: digest }));
  audit.close();
  const db = new Database(filename, { create: false });
  t.after(() => db.close());
  assert.throws(() => db.exec("UPDATE audit_events SET image = NULL"));
  assert.throws(() => db.exec("DELETE FROM audit_events"));
  assert.throws(() =>
    db.exec(
      "INSERT INTO audit_events (recorded_at, invocation_id, kind, profile, image) VALUES ('x','y','invocation.started','base','zz')",
    ),
  );
});
