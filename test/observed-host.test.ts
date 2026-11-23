import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteAudit } from "../src/audit.ts";
import { GATEWAY_NET_RULES } from "../src/microsandbox.ts";
import {
  createObservedHost,
  type ObservedHostOptions,
} from "../src/observed-host.ts";
import {
  createResourceSampler,
  type ResourceSampler,
} from "../src/resource-sampler.ts";
import { ProfileCatalog } from "../src/sandbox-profiles.ts";
import type { ResourceSample } from "../src/sandbox-runtime.ts";
import { fakeGateway } from "./fake-gateway.ts";

const profiles = new ProfileCatalog({
  base: { image: `fixture.invalid/alpine@sha256:${"a".repeat(64)}` },
});
const plan = {
  sandbox: {},
  command: { argv: ["/fixture"], timeoutMs: 30_000 },
  collectPaths: [],
};
const hostServices = [{ ip: "192.0.2.1", port: 8080, loopbackPort: 8080 }];
type BackendEvent = {
  args: string[];
  hasGatewayPassword?: boolean;
  durableBinding?: boolean;
  credentialMatches?: boolean;
};

async function fixture(t: TestContext, version = "msb 0.7.16") {
  const root = await mkdtemp(join(tmpdir(), "observed-host-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auditPath = join(root, "audit.sqlite");
  const binary = join(root, "fixture-backend");
  const log = join(root, "backend.jsonl");
  const sampled = join(root, "sampled");
  const home = join(root, "home");
  const calls: string[] = [];
  await mkdir(home);
  await writeFile(
    binary,
    `#!${process.execPath}
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const event = { args };
const option = (key) => args[args.indexOf(key) + 1];
if (args[0] === "create" && args.includes("--proxy")) {
  event.hasGatewayPassword = /^[a-f0-9]{64}$/.test(process.env[option("--socks5-password-env")] ?? "");
  const audit = new Database(${JSON.stringify(auditPath)}, { readonly: true });
  event.durableBinding = !!audit.query("SELECT 1 FROM sandbox_bindings WHERE sandbox_id = ? AND egress_mode = 'gateway'").get(option("--name"));
  audit.close();
  if (args.includes("--secret")) {
    const variable = option("--secret").split(":")[0];
    event.credentialMatches = process.env[variable] === variable + "-fixture" &&
      ["FIXTURE_OPENAI_TOKEN", "FIXTURE_ANTHROPIC_KEY"].every((other) =>
        other === variable || process.env[other] === undefined);
  }
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + "\\n");
switch (args[0]) {
  case "--version": console.log(${JSON.stringify(version)}); break;
  case "image": console.log(JSON.stringify({ digest: args.at(-1).split("@").at(-1) })); break;
  case "list": console.log("[]"); break;
  case "create":
  case "rm": break;
  case "metrics": console.log(JSON.stringify({ memory_bytes: 456 })); break;
  case "exec":
    if (args.at(-1) === "wait-for-sample")
      while (!existsSync(${JSON.stringify(sampled)}))
        await Bun.sleep(5);
    break;
  default: process.exitCode = 1;
}
`,
    { mode: 0o700 },
  );
  return {
    calls,
    sampled,
    events: async (): Promise<BackendEvent[]> =>
      (
        await readFile(log, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    options: {
      config: { directory: join(root, "observability") },
      auditPath,
      msb: { binary, home, stagingRoot: join(root, "staging") },
      profiles,
      openGateway: async (options) => fakeGateway(calls).open(options),
    } satisfies ObservedHostOptions,
  };
}

test("required mode refuses an unavailable audit before probing the backend", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createObservedHost({
      ...f.options,
      auditPath: join(f.options.msb.home, "missing-parent", "audit.sqlite"),
    }),
    { code: "open-failed" },
  );
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(f.calls, []);
});

test("required mode refuses a backend version mismatch before binding", async (t) => {
  const f = await fixture(t, "msb 0.7.17");
  await assert.rejects(
    createObservedHost(f.options),
    /Microsandbox 0\.7\.16 required/,
  );
  assert.deepEqual(
    (await f.events()).map(({ args }) => args),
    [["--version"]],
  );
  assert.deepEqual(f.calls, []);
});

test("required mode refuses a failed gateway bind and closes the audit", async (t) => {
  const f = await fixture(t);
  let audit: SqliteAudit | undefined;
  await assert.rejects(
    createObservedHost({
      ...f.options,
      async openGateway(options) {
        assert.equal(options.policy.allow.length, 0);
        assert.equal(options.policy.hostServices.length, 0);
        assert.ok(options.audit instanceof SqliteAudit);
        assert.equal(options.audit.isV5Writable, true);
        audit = options.audit;
        throw new Error("EPERM");
      },
    }),
    /Egress gateway startup check failed/,
  );
  assert.equal(audit?.isV5Writable, false);
  assert.deepEqual(
    (await f.events()).map(({ args }) => args),
    [["--version"]],
  );
});

test("required mode creates the durably bound sandbox and samples its original handle", async (t) => {
  const f = await fixture(t);
  let sampler: ResourceSampler | undefined;
  let finalSample: ResourceSample | undefined;
  let sampledId: string | undefined;
  let executionId: string | undefined;
  const limits = {
    attemptBurst: 24,
    attemptsPerSecond: 12,
    maxNetworkRows: 512,
    maxRelays: 8,
  };
  const passedLimits: unknown[] = [];
  const observed = await createObservedHost({
    ...f.options,
    config: { ...f.options.config, audit: { network: limits } },
    openGateway(options) {
      passedLimits.push(options.limits);
      return f.options.openGateway(options);
    },
    observers: [
      {
        observe(event) {
          if (event.eventType === "execution.finished") sampler?.finish();
        },
        startResourceSampling(id, handle, runtime) {
          executionId = id;
          sampledId = handle.id;
          sampler = createResourceSampler(
            {
              async sampleResources(original) {
                const sample = await runtime.sampleResources?.(original);
                await writeFile(f.sampled, "");
                return sample ?? null;
              },
              finalResourceSample: () => finalSample ?? null,
            },
            handle,
            1000,
            {
              setInterval(tick) {
                queueMicrotask(tick);
                return () => {};
              },
            },
          );
        },
        observeFinalResourceSample(_id, _sandboxId, sample) {
          finalSample = sample;
        },
      },
    ],
  });
  t.after(() => observed.close());
  assert.equal(observed.audit.schemaVersion, 7);
  assert.deepEqual(Object.keys(observed.runtime), ["sampleResources"]);
  assert.deepEqual(f.calls, ["gateway.open", "gateway.close"]);
  const run = await observed.host.runWorker(
    {
      ...plan,
      command: { ...plan.command, argv: ["/fixture", "wait-for-sample"] },
    },
    undefined,
    undefined,
    { hostServices },
  );
  assert.equal(run.outcome, "ok");
  assert.equal(run.id, executionId);
  const binding = observed.audit.readExecution(run.id).sandboxBindings[0];
  assert.match(binding?.sandboxId ?? "", /^bootstrap-[0-9a-f-]{36}$/);
  assert.equal(sampledId, binding?.sandboxId);
  const events = await f.events();
  const create = events.find(({ args }) => args[0] === "create");
  assert.ok(create?.durableBinding);
  assert.ok(create.hasGatewayPassword);
  assert.equal(create.args[create.args.indexOf("--name") + 1], sampledId);
  assert.ok(create.args.includes(GATEWAY_NET_RULES));
  assert.ok(create.args.includes("--proxy"));
  assert.equal(events.filter(({ args }) => args[0] === "metrics").length, 2);
  assert.equal(sampler?.finish().sampleCount, 2);
  assert.equal(sampler?.finish().sampledPeakMemoryBytes, 456);
  assert.deepEqual(f.calls, [
    "gateway.open",
    "gateway.close",
    "gateway.open",
    "gateway.close",
  ]);
  assert.deepEqual(passedLimits, [limits, limits]);
  await observed.close();
  assert.equal(observed.audit.isV5Writable, false);
});

test("one required host routes provider bindings to isolated credentials", async (t) => {
  const f = await fixture(t);
  const providers = [
    { host: "openai.invalid", secretEnv: "FIXTURE_OPENAI_TOKEN" },
    {
      host: "anthropic.invalid",
      secretEnv: "FIXTURE_ANTHROPIC_KEY",
      header: "x-api-key" as const,
    },
  ];
  const opened: Parameters<
    NonNullable<ObservedHostOptions["openGateway"]>
  >[0][] = [];
  const observed = await createObservedHost({
    ...f.options,
    gatewayHosts: ["openai.invalid"],
    providerBindings: providers.map((provider) => ({
      provider,
      credentials: {
        async withAccessToken(use) {
          return use(provider.secretEnv + "-fixture");
        },
      },
    })),
    async openGateway(options) {
      opened.push(options);
      return f.options.openGateway(options);
    },
  });
  t.after(() => observed.close());

  for (const provider of providers) {
    const run = await observed.host.runWorker({
      ...plan,
      sandbox: { provider },
    });
    assert.equal(run.outcome, "ok");
    const gateway = opened.at(-1)!;
    assert.equal(gateway.executionId, run.id);
    assert.deepEqual(gateway.policy.providerBinding, {
      hostname: provider.host,
      port: 443,
    });
    assert.equal(gateway.audit, observed.audit);
    assert.equal(
      observed.audit.readExecution(run.id).sandboxBindings[0]?.sandboxId,
      gateway.sandboxLabel,
    );
  }
  const offline = await observed.host.runVerification({
    sandbox: {},
    command: plan.command,
  });
  assert.equal(offline.outcome, "ok");
  assert.equal(opened.length, 3); // Startup probe and one gateway per provider run.
  assert.deepEqual(
    f.calls,
    Array.from({ length: 3 }, () => ["gateway.open", "gateway.close"]).flat(),
  );
  const events = await f.events();
  const creates = events.filter(({ args }) => args[0] === "create");
  assert.equal(creates.length, 3);
  for (const [index, provider] of providers.entries()) {
    const create = creates[index]!;
    assert.ok(
      create.hasGatewayPassword &&
        create.durableBinding &&
        create.credentialMatches,
    );
    assert.ok(
      create.args.includes(
        `${provider.secretEnv}:headers=${"header" in provider ? provider.header : "authorization"}@${provider.host}`,
      ),
    );
    assert.ok(create.args.includes(GATEWAY_NET_RULES));
    assert.ok(create.args.includes("--tls-intercept"));
    assert.equal(create.args.filter((arg) => arg === "--net-rule").length, 1);
  }
  assert.ok(!creates[2]?.args.includes("--proxy"));
  assert.equal(events.filter(({ args }) => args[0] === "metrics").length, 3);
  assert.equal(events.filter(({ args }) => args[0] === "rm").length, 3);
});

test("close drains a pending gateway before closing the audit", async (t) => {
  const f = await fixture(t);
  const opening = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = fakeGateway(f.calls);
  let first = true;
  const observed = await createObservedHost({
    ...f.options,
    config: { ...f.options.config, telemetry: { enabled: false } },
    async openGateway(options) {
      if (first) {
        first = false;
        return f.options.openGateway(options);
      }
      opening.resolve();
      await release.promise;
      const gateway = await fake.open(options);
      return {
        ...gateway,
        async close() {
          assert.equal(observed.audit.isV5Writable, true);
          await gateway.close();
        },
      };
    },
  });
  t.after(() => observed.close());
  const run = observed.host.runWorker(plan, randomUUID(), undefined, {
    hostServices,
  });
  // Capture the result before shutdown may interrupt the invocation.
  const settled = Promise.allSettled([run]);
  await opening.promise;
  const closed = observed.close();
  assert.equal(observed.close(), closed);
  await Promise.resolve();
  assert.equal(observed.audit.isV5Writable, true);
  release.resolve();
  await closed;
  await settled;
  assert.equal(observed.audit.isV5Writable, false);
  assert.deepEqual(f.calls, [
    "gateway.open",
    "gateway.close",
    "gateway.open",
    "gateway.close",
  ]);
  assert.deepEqual(
    (await f.events()).map(({ args }) => args),
    [["--version"]],
  );
});

test("disabled mode skips gateway startup and refuses unaudited agent specs", async (t) => {
  const f = await fixture(t);
  const observed = await createObservedHost({
    ...f.options,
    config: { ...f.options.config, audit: { mode: "disabled" } },
  });
  t.after(() => observed.close());
  assert.deepEqual(await f.events(), []);
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    observed.host.runWorker({
      ...plan,
      sandbox: { tools: [] },
    }),
    /require durable audit/,
  );
  assert.deepEqual(await f.events(), []);
});

test("operator shell uses a bounded audited terminal with no provider or credential mounts", async (t) => {
  const f = await fixture(t);
  let opened = 0;
  const observed = await createObservedHost({
    ...f.options,
    async openGateway(options) {
      assert.deepEqual(
        options.policy.allow,
        opened++ === 0 ? [] : [{ hostname: "example.net", port: 80 }],
      );
      return f.options.openGateway(options);
    },
  });
  t.after(() => observed.close());
  const mount = join(f.options.msb.home, "..", "mount");
  await mkdir(mount);
  const run = await observed.host.runSandboxShell(
    "base",
    [{ hostname: "example.net", port: 80 }],
    [{ host: mount, guest: "/inspect", readOnly: true }],
  );
  assert.equal(run.outcome, "ok");
  const execution = observed.audit.readExecution(run.id);
  assert.equal(execution.sandboxBindings[0]?.egressMode, "gateway");
  assert.equal(
    execution.executionContexts[0]?.attributes?.purpose,
    "sandbox-shell",
  );
  assert.equal(execution.processResults[0]?.exitCode, 0);
  assert.equal(execution.auditEvents.at(-1)?.outcome, "ok");
  const events = await f.events();
  const create = events.find(({ args }) => args[0] === "create")!;
  assert.ok(create.durableBinding);
  assert.equal(create.args[create.args.indexOf("--max-duration") + 1], "300s");
  assert.ok(create.args.includes(`${mount}:/inspect:ro`));
  for (const arg of [
    "--secret",
    "--tls-intercept",
    "--vsock",
    "--mount-named",
    "--mount-file",
  ])
    assert.ok(!create.args.includes(arg));
  assert.deepEqual(
    events.find(({ args }) => args[0] === "exec")?.args.slice(-2),
    ["--", "/bin/sh"],
  );
});
