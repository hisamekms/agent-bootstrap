import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteAudit } from "../src/audit.ts";
import {
  buildSandboxPlan,
  withBuildSandbox,
} from "../src/image-build-sandbox.ts";
import { GATEWAY_NET_RULES } from "../src/microsandbox.ts";

test("builds bind the recipe gateway to durable create, DNS, connection and destroy evidence", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "build-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: root };
  const plan = buildSandboxPlan("browser", env);
  assert.deepEqual(plan, {
    egress: "gateway",
    allow: [{ hostname: "snapshot.debian.org", port: 80 }],
    auditPath: join(root, "agent-bootstrap", "builds", "audit.sqlite"),
  });
  const calls: string[] = [];
  const digest = "a".repeat(64);
  const base = {
    profile: "browser" as const,
    image: `example.invalid/debian@sha256:${digest}`,
    digest,
    memoryMiB: 1024,
    cpus: 1,
    env,
  };
  let id = "";
  let report = () => {};
  await withBuildSandbox({
    ...base,
    async run(args, _timeout, extraEnv) {
      calls.push(args[0]!);
      if (args[0] === "create") {
        assert.ok(args.includes("--no-net"));
        assert.equal(args[args.indexOf("--net-rule") + 1], GATEWAY_NET_RULES);
        assert.equal(
          args[args.indexOf("--proxy") + 1],
          "socks5://127.0.0.1:19100",
        );
        assert.deepEqual(extraEnv, {
          AGENT_GATEWAY_BUILD_SECRET: "fixture-gateway",
        });
        const reader = new SqliteAudit(plan.auditPath, { readonly: true });
        try {
          const { sandboxBindings, auditEvents } = reader.readExecution(id);
          assert.equal(sandboxBindings[0]?.egressMode, "gateway");
          assert.equal(auditEvents.at(-1)?.kind, "operation.allowed");
          assert.equal(auditEvents.at(-1)?.operation, "sandbox.create");
        } finally {
          reader.close();
        }
      } else assert.equal(extraEnv, undefined);
      return "";
    },
    async openGateway({ audit, executionId, sandboxLabel, policy }) {
      id = executionId;
      assert.deepEqual(policy.allow, plan.allow);
      assert.deepEqual(policy.allowIps, []);
      assert.deepEqual(policy.hostServices, []);
      report = () => {
        const metadata = {
          invocationId: id,
          sandboxId: sandboxLabel,
          policyId: policy.policyId,
        };
        audit.appendDnsQuery({
          ...metadata,
          queryId: randomUUID(),
          protocol: "udp",
          qname: "snapshot.debian.org",
          qtype: 1,
          decision: "allow",
          reasonCode: "allowlisted-host",
          answerIps: ["203.0.113.1"],
        });
        audit.appendNetwork({
          ...metadata,
          connectionId: randomUUID(),
          destinationIp: "203.0.113.1",
          destinationPort: 80,
          hostname: "snapshot.debian.org",
          channel: "egress",
          decision: "allow",
          reasonCode: "allowlisted-host",
        });
      };
      return {
        socksPort: 19100,
        dnsPort: 19153,
        username: "fixture",
        password: "fixture-gateway",
        quarantined: false,
        async close() {
          calls.push("close");
        },
      };
    },
    async use(name, run) {
      report();
      await run(["exec", name], 500);
    },
  });
  assert.deepEqual(calls, ["create", "exec", "rm", "close"]);
  const audit = new SqliteAudit(plan.auditPath, { readonly: true });
  try {
    const { auditEvents, networkEvents } = audit.readExecution(id);
    assert.deepEqual(
      networkEvents.map(({ phase }) => phase),
      ["dns", "requested", "decided"],
    );
    assert.deepEqual(
      auditEvents
        .filter(({ kind }) => kind === "operation.finished")
        .map(({ operation, outcome }) => [operation, outcome]),
      [
        ["sandbox.create", "ok"],
        ["sandbox.destroy", "ok"],
      ],
    );
  } finally {
    audit.close();
  }

  const fenced = {
    ...base,
    async run(): Promise<string> {
      assert.fail("backend should remain untouched");
    },
    async use() {
      assert.fail("build should remain untouched");
    },
  };
  await assert.rejects(
    withBuildSandbox({
      ...fenced,
      async openGateway() {
        throw new Error("fixture gateway failed");
      },
    }),
    /fixture gateway failed/,
  );
  const badRoot = join(root, "bad");
  const badEnv = { XDG_STATE_HOME: badRoot };
  const bad = buildSandboxPlan("browser", badEnv);
  await mkdir(join(badRoot, "agent-bootstrap", "builds"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(bad.auditPath, "invalid SQLite");
  await assert.rejects(
    withBuildSandbox({
      ...fenced,
      env: badEnv,
      async openGateway() {
        assert.fail("gateway should remain untouched");
      },
    }),
    { code: "open-failed" },
  );
});

test("smoke tests run with no network and open no gateway", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "build-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: root };
  const plan = buildSandboxPlan("browser", env);
  const digest = "b".repeat(64);
  const creates: string[][] = [];
  const output = await withBuildSandbox({
    profile: "browser",
    image: `example.invalid/browser@sha256:${digest}`,
    digest,
    memoryMiB: 1024,
    cpus: 1,
    smoke: true,
    env,
    async run(args, _timeout, extraEnv) {
      if (args[0] === "create") {
        creates.push(args);
        assert.deepEqual(extraEnv, {});
      }
      return "";
    },
    openGateway: () => {
      throw new Error("smoke tests must not open a gateway");
    },
    use: async () => "smoke-ok",
  });
  assert.equal(output, "smoke-ok");
  assert.equal(creates.length, 1);
  const args = creates[0]!;
  assert.ok(args.includes("--no-net"));
  for (const flag of ["--net-rule", "--proxy", "--dns-nameserver"])
    assert.ok(!args.includes(flag), flag);
  const label = args[args.indexOf("--label") + 1]!;
  const id = label.slice("agent-bootstrap-invocation=".length);
  const reader = new SqliteAudit(plan.auditPath, { readonly: true });
  try {
    const { sandboxBindings } = reader.readExecution(id);
    assert.equal(sandboxBindings.length, 1);
    assert.equal(sandboxBindings[0]?.egressMode, "none");
  } finally {
    reader.close();
  }
});
