import type { TerminalAttachment, TerminalExit } from "../sandbox-runtime.ts";
import { createTerminalFilter } from "./terminal-filter.ts";

const replayLimit = 512 * 1024;

type TerminalEvent =
  | { method: "concierge.output"; params: { data: string } }
  | { method: "concierge.exit"; params: TerminalExit }
  | { method: "concierge.notice"; params: { code: "input-transferred" } };

type TerminalClient = (event: TerminalEvent) => void;

export type ConciergeTerminalHub = ReturnType<
  typeof createConciergeTerminalHub
>;

export function createConciergeTerminalHub() {
  const filter = createTerminalFilter();
  const replay = Buffer.alloc(replayLimit);
  const clients = new Set<TerminalClient>();
  let cursor = 0;
  let size = 0;
  let owner: TerminalClient | undefined;
  let attached: TerminalAttachment | undefined;
  let exited = false;

  function exit(result: TerminalExit) {
    exited = true;
    attached = undefined;
    owner = undefined;
    for (const client of clients)
      client({ method: "concierge.exit", params: result });
    clients.clear();
  }

  return {
    start(attachment: TerminalAttachment) {
      if (attached || exited)
        throw new Error("Concierge terminal already started");
      attached = attachment;
      void attachment.finished.then(exit, () => exit({ exitCode: null }));
    },
    get status() {
      return exited
        ? "terminal-exited"
        : attached
          ? "ready"
          : "terminal-unavailable";
    },
    data(chunk: Uint8Array) {
      if (exited) return;
      const filtered = filter.push(chunk);
      if (!filtered.length) return;
      const tail = filtered.subarray(
        Math.max(0, filtered.length - replayLimit),
      );
      const first = Math.min(tail.length, replayLimit - cursor);
      replay.set(tail.subarray(0, first), cursor);
      replay.set(tail.subarray(first), 0);
      cursor = (cursor + tail.length) % replayLimit;
      size = Math.min(size + tail.length, replayLimit);
      if (clients.size) {
        const data = Buffer.from(
          filtered.buffer,
          filtered.byteOffset,
          filtered.byteLength,
        ).toString("base64");
        for (const client of clients)
          client({ method: "concierge.output", params: { data } });
      }
    },
    attach(client: TerminalClient) {
      const previous = owner;
      clients.add(client);
      owner = client;
      if (previous && previous !== client)
        previous({
          method: "concierge.notice",
          params: { code: "input-transferred" },
        });
      const start = (cursor - size + replayLimit) % replayLimit;
      const first = Math.min(size, replayLimit - start);
      return Buffer.concat(
        [
          replay.subarray(start, start + first),
          replay.subarray(0, size - first),
        ],
        size,
      ).toString("base64");
    },
    detach(client: TerminalClient) {
      clients.delete(client);
      if (owner === client) owner = undefined;
    },
    ownsInput(client: TerminalClient) {
      return owner === client;
    },
    write(input: Uint8Array) {
      attached!.terminal.write(input);
    },
    resize(cols: number, rows: number) {
      attached!.terminal.resize(cols, rows);
    },
  };
}
