import { closeSync, lstatSync, openSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { missing, privatePath, userStateDirectory } from "../config/layers.ts";
import { privateDirectory } from "../volumes/volume.ts";
import { OrchestratorStore } from "./store.ts";

interface Connection {
  exec(sql: string): void;
  close(): void;
}

const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
  Database: new (filename: string) => Connection;
};

/** SQLite releases the OS lock if the launcher dies, even if its PID is reused. */
export function tryLockVmJob(env: NodeJS.ProcessEnv): (() => void) | undefined {
  const root = userStateDirectory(env);
  privateDirectory(root);
  const path = join(root, "vm-job.sqlite");
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe VM job lock");
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    return () => db.close();
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
    return undefined;
  }
}

/** Doctor can inspect the lease without creating state for an unused target. */
export function vmJobHeld(env: NodeJS.ProcessEnv): boolean {
  if (
    !lstatSync(join(userStateDirectory(env), "vm-job.sqlite"), {
      throwIfNoEntry: false,
    })
  )
    return false;
  const release = tryLockVmJob(env);
  release?.();
  return release === undefined;
}

function blockingHostCheckTarget(env: NodeJS.ProcessEnv) {
  const root = userStateDirectory(env);
  const projects = join(root, "projects");
  try {
    privatePath(projects, root);
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = OrchestratorStore.inspectHostCheckJob(
        join(projects, entry.name, "state.db"),
      );
      if (job) return { target: entry.name, status: job.status };
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export function vmJobWaitReason(env: NodeJS.ProcessEnv): string {
  const block = blockingHostCheckTarget(env);
  if (!block) return "The shared VM job slot is busy.";
  const target = JSON.stringify(block.target);
  return block.status === "running"
    ? `A host check is recorded as running for target ${target}.`
    : `Target ${target} has a ${block.status} host check. Open that target in Workplace and clear the host check from Task detail.`;
}

export function tryStartVmJob(
  env: NodeJS.ProcessEnv,
): (() => void) | undefined {
  const release = tryLockVmJob(env);
  if (!release) return;
  let admitted = false;
  try {
    // A durable host-check record keeps the slot blocked after the OS lock
    // disappears, until the operator clears the interrupted or tampered run.
    admitted = !blockingHostCheckTarget(env);
    if (admitted) return release;
  } finally {
    if (!admitted) release();
  }
}

export async function withVmJob<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const release = tryStartVmJob(env);
  if (!release) throw new Error(vmJobWaitReason(env));
  try {
    return await run();
  } finally {
    release();
  }
}
