import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { projectInbox, type InboxSource } from "./inbox.ts";
import { pendingDecisions } from "./operator-attention.ts";
import { operatorGoalTurn } from "./operator-read.ts";

export const WATCH_LINE_BYTES = 96;
const watchPollMs = 250;
const reconnectCooldownMs = 5000;
const connectionLimit = 12;

export function conciergeWatchEvents(
  source: InboxSource,
  rows: ReturnType<InboxSource["store"]["conciergeWatchRows"]>,
): string[] {
  const { store } = source;
  const events = new Set<string>();
  const failures = new Map<string, string>();
  const exportCandidates = new Map<string, string>();
  let decisionsChanged = false;
  for (const row of rows) {
    const { kind, goalId, goalRef, taskRef } = row;
    if (kind === "decision-needed") decisionsChanged = true;
    if (goalId && goalRef && /^G[1-9]\d*$/.test(goalRef)) {
      if (kind === "goal.registered") events.add(`goal-approved ${goalRef}`);
      if (kind === "execution.finished") events.add(`plan-ready ${goalRef}`);
      if (kind === "task.integrated" || kind === "goal.status")
        exportCandidates.set(goalId, goalRef);
    }
    if (!taskRef || !/^G[1-9]\d*-[1-9]\d*$/.test(taskRef)) continue;
    if (kind === "task.integrated") events.add(`integrated ${taskRef}`);
    if (kind === "task.budget-exceeded")
      failures.set(taskRef, "budget-exceeded");
    if (kind === "task.status" && !failures.has(taskRef))
      failures.set(taskRef, "failed");
  }
  for (const [ref, code] of failures) events.add(`task-failed ${ref} ${code}`);
  for (const [id, ref] of exportCandidates) {
    const goal = store.getGoal(id);
    if (goal && operatorGoalTurn(store, goal).reason.kind === "exportable")
      events.add(`goal-exportable ${ref}`);
  }
  if (decisionsChanged) {
    const count = pendingDecisions(projectInbox(source)).length;
    if (count) events.add(`decision-needed ${count}`);
  }
  return [...events];
}

interface WatchClient {
  on(event: "error", listener: () => void): unknown;
  once(event: "close", listener: () => void): unknown;
  resume(): unknown;
  readonly writableLength: number;
  write(line: string): unknown;
  destroy(): unknown;
}

export function createConciergeWatch(
  source: InboxSource,
  sessionId: string,
  now = () => performance.now(),
) {
  const { store } = source;
  let cursor = store.conciergeWatchStart(sessionId);
  let client: WatchClient | undefined;
  let failed = false;
  let connections = 0;
  let nextConnectAt = 0;
  const disconnect = (socket = client) => {
    if (!socket || client !== socket) return;
    client = undefined;
    socket.destroy();
    try {
      store.recordConciergeWatch(sessionId, "disconnected");
    } catch {
      failed = true;
    }
  };
  return {
    connect(socket: WatchClient) {
      if (failed || client || connections >= connectionLimit) return false;
      const at = now();
      if (at < nextConnectAt) return false;
      try {
        store.recordConciergeWatch(sessionId, "connected");
        connections++;
        nextConnectAt = at + reconnectCooldownMs;
        client = socket;
        return true;
      } catch {
        failed = true;
        return false;
      }
    },
    poll() {
      const socket = client;
      if (!socket || socket.writableLength > 0) return;
      try {
        if (!store.isActiveConciergeSession(sessionId)) {
          disconnect(socket);
          return;
        }
        const rows = store.conciergeWatchRows(cursor);
        for (const event of conciergeWatchEvents(source, rows)) {
          const line = `event ${event}\n`;
          if (Buffer.byteLength(line) > WATCH_LINE_BYTES) continue;
          store.recordConciergeWatch(sessionId, "sent", event);
          socket.write(line);
        }
        cursor = rows.at(-1)?.sequence ?? cursor;
      } catch {
        failed = true;
        disconnect(socket);
      }
    },
    disconnect,
    get failed() {
      return failed;
    },
  };
}

export function acceptConciergeWatch(
  watch: ReturnType<typeof createConciergeWatch>,
  socket: WatchClient,
) {
  socket.on("error", () => socket.destroy());
  if (!watch.connect(socket)) {
    socket.destroy();
    return;
  }
  socket.once("close", () => watch.disconnect(socket));
  socket.resume(); // Discard all input without buffering or parsing it.
}

export async function listenConciergeWatch(
  source: InboxSource,
  sessionId: string,
  path: string,
) {
  const watch = createConciergeWatch(source, sessionId);
  let closed = false;
  let failed = false;
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (closed) socket.destroy();
    else acceptConciergeWatch(watch, socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      clearInterval(timer);
      watch.disconnect();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (failed || watch.failed) throw new Error("Concierge watcher failed");
    })());
  server.on("error", () => {
    failed = true;
    void close().catch(() => {});
  });
  try {
    // The launcher creates this socket inside its private session directory.
    chmodSync(path, 0o600);
    timer = setInterval(watch.poll, watchPollMs);
    timer.unref();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
