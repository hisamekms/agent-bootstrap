import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const msbHome = process.env.MSB_HOME;
assert.ok(msbHome?.startsWith("/"), "Set an absolute, dedicated MSB_HOME");
const image =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const exec = promisify(execFile);
const canary = randomUUID();
let requests = 0;
const server = createServer((request, response) => {
  if (request.url !== "/canary") {
    response.writeHead(404).end();
    return;
  }
  requests += 1;
  response.writeHead(200, { Connection: "close" }).end(canary);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

async function guest(rules: string[], script: string, args: string[]) {
  const command = [
    "run",
    "--pull",
    "never",
    "--no-stdin",
    "--no-net",
    "--max-duration",
    "20s",
    ...rules,
    image,
    "--",
    "/bin/sh",
    "-ec",
    script,
    "sh",
    ...args,
  ];
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await exec("msb", command, {
        env: {
          PATH: process.env.PATH,
          MSB_HOME: msbHome,
          MSB_BACKEND: "local",
        },
        timeout: 30_000,
      });
      return stdout.trim();
    } catch (error) {
      // Retry only a spawn failure, before msb could create a guest.
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || attempt === 5) {
        throw error;
      }
      await delay(1_000);
    }
  }
}

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = String(address.port);
  const allowed = await guest(
    ["--net-rule", `allow@host:tcp:${port}`],
    `
      gateway=$(ip -4 route show default | awk '$1 == "default" && $2 == "via" { print $3; exit }')
      test -n "$gateway"
      body=$(wget -T 3 -qO- "http://$gateway:$1/canary")
      printf '%s\\n%s\\n' "$gateway" "$body"
    `,
    [port],
  );
  const [gateway, body] = allowed.split("\n");
  assert.ok(gateway);
  assert.match(gateway, /^\d{1,3}(\.\d{1,3}){3}$/);
  assert.equal(body, canary);
  assert.equal(requests, 1);
  console.log("An explicit allow rule reached the loopback canary.");

  const denied = await guest(
    [],
    `
      command -v wget >/dev/null
      if wget -T 3 -qO- "http://$1:$2/canary"; then
        exit 42
      fi
      echo "probe blocked"
    `,
    [gateway, port],
  );
  assert.equal(denied, "probe blocked");
  assert.equal(requests, 1, "A denied guest request reached the host");
  console.log("The same destination was blocked without the allow rule.");
} finally {
  server.closeAllConnections();
  server.close();
}
