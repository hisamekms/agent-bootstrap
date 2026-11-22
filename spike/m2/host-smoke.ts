import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteAudit } from "../../src/audit.ts";
import { MicrosandboxRuntime } from "../../src/microsandbox.ts";
import { ProfileCatalog } from "../../src/sandbox-profiles.ts";
import { TrustedHost } from "../../src/trusted-host.ts";

const [binary] = process.argv.slice(2);
const home = process.env.MSB_HOME;
assert.ok(binary && isAbsolute(binary) && home && isAbsolute(home));
const local = fileURLToPath(new URL("../../.local/", import.meta.url));
await mkdir(local, { recursive: true });
const work = await mkdtemp(join(local, "m2-smoke-"));
const filename = join(work, "audit.sqlite");
const audit = new SqliteAudit(filename);
const profiles = new ProfileCatalog({
  base: {
    image:
      "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd",
  },
});
const runtime = new MicrosandboxRuntime({
  binary,
  home,
  stagingRoot: join(work, "staging"),
  profiles,
});
try {
  const host = new TrustedHost(audit, runtime, profiles);
  const first = await host.runWorker({
    sandbox: { maxLifetimeMs: 20_000 },
    command: {
      argv: [
        "/bin/sh",
        "-ec",
        "cd /workspace; printf fixture > report.txt; printf '%s' '{\"tool\":\"collect\"}'",
      ],
      timeoutMs: 5000,
    },
    collectPaths: ["report.txt"],
  });
  assert.equal(first.outcome, "ok");
  assert.equal(
    Buffer.from(first.artifacts?.files[0]?.bytes ?? []).toString(),
    "fixture",
  );
  const denied = await host.runWorker({
    sandbox: { maxLifetimeMs: 20_000 },
    command: {
      argv: ["/bin/sh", "-ec", "printf '%s' '{\"tool\":\"out-of-scope\"}'"],
      timeoutMs: 5000,
    },
    collectPaths: [],
  });
  assert.equal(denied.outcome, "denied");
  assert.ok(
    audit.read(denied.id).some((event) => event.kind === "operation.denied"),
  );
  const timed = await host.runWorker({
    sandbox: { maxLifetimeMs: 20_000 },
    command: { argv: ["/bin/sh", "-ec", "sleep 4"], timeoutMs: 500 },
    collectPaths: [],
  });
  assert.equal(timed.outcome, "timed-out");
  assert.equal(audit.read(timed.id).at(-1)?.outcome, "timed-out");
  console.log(
    JSON.stringify({
      filename,
      completed: first.id,
      denied: denied.id,
      timedOut: timed.id,
    }),
  );
} finally {
  audit.close();
}
