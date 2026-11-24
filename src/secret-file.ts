import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { isSafeCredentialVariable } from "./sandbox-runtime.ts";

export const SECRET_FILE_PORT = 5001;
export const SECRET_FILE_DEADLINE_MS = 30_000;
export const SECRET_TOOL_DIRS = {
  home: "/home/agent/run/home",
  config: "/home/agent/run/config",
  tmp: "/home/agent/run/tmp",
} as const;

export function secretSocketRoot(): Promise<string> {
  return realpath(existsSync("/private/tmp") ? "/private/tmp" : tmpdir());
}

export function readKeychainSecret(service: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-a", userInfo().username, "-s", service, "-w"],
      {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: 8192,
      },
      (error, stdout, stderr) => {
        stderr.fill(0);
        const length = stdout.length - (stdout.at(-1) === 10 ? 1 : 0);
        const value = stdout.subarray(0, length);
        if (error || !length || length > 4096 || value.includes(0)) {
          stdout.fill(0);
          reject(new Error("Secret could not be read from Keychain"));
          return;
        }
        resolve(value);
      },
    );
  });
}

export type SecretTransferOutcome = "acknowledged" | "unknown";

type DeliveryAudit = {
  beforeSend(): Promise<void>;
  afterSend(outcome: SecretTransferOutcome): Promise<void>;
};

/** Reserve the armed channel before awaiting audit, so concurrent callers
 * cannot both write. Connections made before arming do not claim it. */
export function createSecretFileSender(value: Uint8Array) {
  const bytes = Buffer.from(value);
  let audit: DeliveryAudit | undefined;
  let consumed = false;
  let closed = false;
  return {
    authorize(deliveryAudit: DeliveryAudit) {
      if (closed || audit) throw new Error("Secret-file channel already used");
      audit = deliveryAudit;
    },
    async send(write: (bytes: Buffer) => Promise<SecretTransferOutcome>) {
      if (closed || consumed || !audit) return false;
      consumed = true;
      await audit.beforeSend();
      if (closed) {
        await audit.afterSend("unknown");
        return false;
      }
      let outcome: SecretTransferOutcome = "unknown";
      try {
        outcome = await write(bytes);
      } finally {
        await audit.afterSend(outcome);
      }
      return outcome === "acknowledged";
    },
    close() {
      closed = true;
      bytes.fill(0);
    },
  };
}

/** Screen raw bytes, including all overlapping 16-byte windows. */
export function createSecretScreen(value: Uint8Array) {
  const bytes = Buffer.from(value);
  const width = 16;
  // Every match contains a sampled pair. A Buffer-backed index maps each
  // pair to its offsets in the value. Zero denotes the end of the list.
  const indexed = bytes.length > width;
  const offsets = Buffer.alloc(indexed ? 2 * 65_536 : 0);
  const next = Buffer.alloc(indexed ? 2 * bytes.length : 0);
  let closed = false;
  for (let i = 0; indexed && i < bytes.length - 1; i++) {
    const slot = 2 * bytes.readUInt16BE(i);
    next.writeUInt16BE(offsets.readUInt16BE(slot), 2 * i);
    offsets.writeUInt16BE(i + 1, slot);
  }
  return {
    matches(data: string | Uint8Array) {
      const input =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (closed || bytes.length === 0) return false;
      if (bytes.length <= width) return input.includes(bytes);
      if (input.length < width) return false;
      for (let i = 0; i <= input.length - 2; i += width - 1) {
        let offset = offsets.readUInt16BE(2 * input.readUInt16BE(i));
        while (offset) {
          const j = offset - 1;
          offset = next.readUInt16BE(2 * j);
          let left = 0;
          let right = 2;
          while (
            left < width - 2 &&
            i > left &&
            j > left &&
            input[i - left - 1] === bytes[j - left - 1]
          )
            left++;
          while (
            left + right < width &&
            i + right < input.length &&
            j + right < bytes.length &&
            input[i + right] === bytes[j + right]
          )
            right++;
          if (left + right >= width) return true;
        }
      }
      return false;
    },
    close() {
      closed = true;
      bytes.fill(0);
      offsets.fill(0);
      next.fill(0);
    },
  };
}

/** One disposable guest channel. The trusted host arms it after auditing exec. */
export async function openSecretFileDelivery(
  parent: string,
  variable: string,
  value: Uint8Array,
) {
  if (
    !isSafeCredentialVariable(variable) ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes(0)
  )
    throw new Error("Invalid secret-file input");
  const directory = await mkdtemp(join(parent, "secret-"));
  const hostPath = join(directory, "s");
  const sender = createSecretFileSender(value);
  const screen = createSecretScreen(value);
  let active: Socket | undefined;
  let forcedClose = false;
  let transfer: Promise<boolean> | undefined;
  let armed = false;
  let auditFailed = false;
  let acknowledged = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    if (!armed || transfer) {
      socket.destroy();
      return;
    }
    active = socket;
    server.close();
    transfer = sender
      .send(async (bytes) => {
        if (socket.destroyed) return "unknown";
        try {
          return await new Promise<SecretTransferOutcome>((resolve) => {
            let acknowledged = false;
            let invalidAck = false;
            let sent = false;
            socket.setTimeout(5000, () => {
              forcedClose = true;
              socket.destroy();
            });
            socket.on("data", (chunk: Buffer) => {
              if (acknowledged || chunk.length !== 1 || chunk[0] !== 65) {
                invalidAck = true;
                socket.destroy();
              } else {
                acknowledged = true;
                socket.end();
              }
            });
            // A peer that ends without acknowledging leaves the outcome unknown.
            socket.once("end", () => {
              if (!acknowledged) socket.destroy();
            });
            socket.once("close", () => {
              resolve(
                sent && acknowledged && !invalidAck && !forcedClose
                  ? "acknowledged"
                  : "unknown",
              );
            });
            // The vsock relay does not carry a half-close, so the frame is
            // length-prefixed and the guest acknowledges before either side
            // closes.
            const prefix = Buffer.from(String(bytes.length).padStart(8, "0"));
            socket.write(prefix);
            socket.write(bytes, (error) => {
              if (!error) sent = true;
            });
            socket.resume();
          });
        } finally {
          sender.close();
        }
      })
      .then((served) => (acknowledged = served))
      .catch(() => {
        auditFailed = true;
        return false;
      })
      .finally(() => {
        sender.close();
        socket.destroy();
      });
  });
  server.on("error", () => active?.destroy());

  let cleanup: Promise<void> | undefined;
  const close = () =>
    (cleanup ??= (async () => {
      if (active && !active.destroyed) {
        forcedClose = true;
        active.destroy();
      }
      sender.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
      await transfer;
    })());
  try {
    await chmod(directory, 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(hostPath, resolve);
    });
    await chmod(hostPath, 0o600);
  } catch (error) {
    screen.close();
    await close();
    throw new Error("Secret-file listener unavailable", { cause: error });
  }
  return {
    hostPath,
    variable,
    matches: screen.matches,
    clearScreen: screen.close,
    authorize(audit: DeliveryAudit) {
      sender.authorize(audit);
      armed = true;
    },
    get auditFailed() {
      return auditFailed;
    },
    get acknowledged() {
      return acknowledged;
    },
    close,
  };
}

export type SecretFileDelivery = Awaited<
  ReturnType<typeof openSecretFileDelivery>
>;
