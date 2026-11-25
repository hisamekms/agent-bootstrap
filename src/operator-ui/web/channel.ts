import type { Methods, Push } from "./protocol.ts";

type Reply =
  { id: number; result: unknown } | { id: number; error: { code: string } };

export class WorkplaceChannel {
  readonly socket = new WebSocket(`ws://${location.host}/ws`);
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(onPush: (message: Push) => void) {
    this.socket.addEventListener("message", ({ data }) => {
      if (typeof data !== "string") return;
      const message = JSON.parse(data) as Reply | Push;
      if (!("id" in message)) {
        onPush(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if ("error" in message) request.reject(new Error(message.error.code));
      else request.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const request of this.pending.values())
        request.reject(new Error("disconnected"));
      this.pending.clear();
    });
  }

  request<M extends keyof Methods>(
    method: M,
    params: Methods[M]["params"],
  ): Promise<Methods[M]["result"]> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("disconnected"));
        return;
      }
      const id = ++this.nextId;
      this.socket.send(JSON.stringify({ id, method, params }));
      this.pending.set(id, { resolve, reject });
    }) as Promise<Methods[M]["result"]>;
  }
}
