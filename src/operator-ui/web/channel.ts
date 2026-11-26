import { isProposal, type Methods, type Push } from "./protocol.ts";

type Reply =
  { id: number; result: unknown } | { id: number; error: { code: string } };

export class WorkplaceChannel {
  private currentSocket: WebSocket;
  get socket() {
    return this.currentSocket;
  }
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      socket: WebSocket;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  private readonly onPush: (message: Push) => void;

  constructor(onPush: (message: Push) => void) {
    this.onPush = onPush;
    this.currentSocket = this.open();
  }

  reconnect() {
    this.currentSocket.close();
    this.currentSocket = this.open();
    return this.currentSocket;
  }

  private open() {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.addEventListener("message", ({ data }) => {
      if (socket !== this.currentSocket || typeof data !== "string") return;
      const message = JSON.parse(data) as Reply | Push;
      if (!("id" in message)) {
        this.onPush(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request || request.socket !== socket) return;
      this.pending.delete(message.id);
      if ("error" in message) request.reject(new Error(message.error.code));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const [id, request] of this.pending) {
        if (request.socket !== socket) continue;
        this.pending.delete(id);
        request.reject(new Error("disconnected"));
      }
    });
    return socket;
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
      this.pending.set(id, {
        socket: this.socket,
        reject,
        resolve(value) {
          if (method === "proposal.get" && !isProposal(value))
            reject(new Error("invalid-response"));
          else resolve(value);
        },
      });
    }) as Promise<Methods[M]["result"]>;
  }
}
