import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  SqliteAudit,
  type ExecutionAudit,
  type NetworkEvent,
} from "../../src/audit.ts";
import { exportAudit } from "../../src/audit-export.ts";
import {
  EgressGateway,
  type EgressGatewayOptions,
} from "../../src/egress-gateway.ts";
import {
  HOST_SERVICE_NAME,
  type HostService,
} from "../../src/egress-policy.ts";
import { createObservedHost } from "../../src/observed-host.ts";
import { parseProfileLock, profileCatalog } from "../../src/profile-lock.ts";
import type { SandboxProvider } from "../../src/sandbox-runtime.ts";
import { HostAuditError, type WorkerPlan } from "../../src/trusted-host.ts";
import {
  bypassGuest,
  canary,
  captureBypasses,
  dnsClient,
  guestPerl,
  holdGuest,
  loopback,
  probeIp,
  directIp,
  probeV6,
  providerFixture,
  providerIp,
  providerName,
  runFile,
  secretEnv,
  serviceIp,
  socksAuth,
  tcpFixture,
  until,
} from "./fixtures.ts";

const alpine =
  "docker.io/library/alpine@sha256:5dda816445facf5f7282dc7689a333278834c74265ba25db2e2eb90509e3a9dd";
const expectedRules =
  "allow@dns,deny@host,deny@0.0.0.0/0:tcp:53,deny@[::/0]:tcp:53,deny@0.0.0.0/0:tcp:853,deny@[::/0]:tcp:853,allow@0.0.0.0/0:tcp,allow@[::/0]:tcp";
type Observed = Awaited<ReturnType<typeof createObservedHost>>;
type Limits = NonNullable<EgressGatewayOptions["limits"]>;
type Decision = Extract<NetworkEvent, { phase: "decided" }>;
type Evidence = Record<string, unknown>;
type Case = (scope: Scope) => Promise<Evidence | Map<string, Evidence>>;

class Scope {
  readonly auditPath: string;
  readonly ids = new Set<string>();
  readonly gateways = new Map<string, EgressGateway>();
  readonly cleanups: (() => void | Promise<void>)[] = [];
  readonly root: string;
  readonly home: string;
  readonly binary: string;
  constructor(root: string, home: string, binary: string) {
    this.root = root;
    this.home = home;
    this.binary = binary;
    this.auditPath = join(root, "audit.sqlite");
  }

  async msb(args: string[]) {
    try {
      return (
        await runFile(this.binary, args, {
          cwd: this.root,
          env: {
            PATH: "/usr/bin:/bin",
            MSB_BACKEND: "local",
            MSB_HOME: this.home,
          },
          timeout: 20_000,
          killSignal: "SIGKILL",
        })
      ).stdout.trim();
    } catch {
      throw new Error(`Microsandbox ${args[0]} failed`);
    }
  }

  async list(invocationId?: string): Promise<string[]> {
    const rows: unknown = JSON.parse(
      await this.msb([
        "ls",
        "--format",
        "json",
        ...(invocationId
          ? ["--label", `agent-bootstrap-invocation=${invocationId}`]
          : []),
      ]),
    );
    assert.ok(Array.isArray(rows), "Unexpected msb ls JSON format");
    return rows.map((row: { name?: string }) => {
      assert.match(
        row.name ?? "",
        /^bootstrap-[a-f0-9-]+$/,
        "Unexpected sandbox in dedicated MSB_HOME",
      );
      return row.name!;
    });
  }

  async observed(
    options: {
      limits?: Limits | ((id: string) => Limits | undefined);
      mode?: "required" | "disabled";
      debianBase?: boolean;
      upstream?: number;
      token?: string;
      provider?: SandboxProvider;
      failFactoryFor?: string;
      onDial?: (id: string, ip: string, port: number) => void;
    } = {},
  ) {
    const stagingRoot = join(this.root, "staging");
    await mkdir(stagingRoot, { recursive: true });
    const lock = parseProfileLock(
      await readFile(
        new URL("../../images/profiles.lock.json", import.meta.url),
        "utf8",
      ),
    );
    const observed = await createObservedHost({
      config: {
        directory: join(this.root, "observability"),
        telemetry: { enabled: false },
        audit: { mode: options.mode ?? "required" },
      },
      auditPath: this.auditPath,
      msb: { binary: this.binary, home: this.home, stagingRoot },
      profiles: profileCatalog(
        options.debianBase ? lock.profiles.browser!.image : alpine,
        lock,
      ),
      ...(options.provider && options.token
        ? {
            providers: [options.provider],
            credentials: {
              withAccessToken: (consume) => consume(options.token!),
            },
          }
        : {}),
      openGateway: async (opts) => {
        if (opts.executionId === options.failFactoryFor)
          throw new Error("Injected listener outage");
        const limits =
          typeof options.limits === "function"
            ? options.limits(opts.executionId)
            : options.limits;
        const gateway = await EgressGateway.open({
          ...opts,
          ...(limits ? { limits } : {}),
          resolver: async (name, type) =>
            name === providerName && type === 1
              ? [{ address: providerIp, ttl: 300 }]
              : [],
          connect: ({ ip, port }) => {
            // Every real dial must point to an explicit local fixture. Never
            // pass a guest-controlled destination to a host socket.
            const target =
              ip === providerIp &&
              port === 443 &&
              options.upstream !== undefined
                ? options.upstream
                : ip === loopback &&
                    opts.policy.hostServices.some(
                      (service) => service.loopbackPort === port,
                    )
                  ? port
                  : undefined;
            options.onDial?.(opts.executionId, ip, port);
            assert.ok(target, "Unexpected gateway dial");
            return connect({
              host: loopback,
              port: target,
              allowHalfOpen: true,
            });
          },
        });
        this.gateways.set(opts.executionId, gateway);
        return gateway;
      },
    });
    this.cleanups.push(() => observed.close());
    return observed;
  }

  worker(
    observed: Observed,
    id: string,
    argv: string[],
    services: HostService[],
    options: {
      profile?: "base" | "browser";
      provider?: SandboxProvider;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    this.ids.add(id);
    const plan: WorkerPlan = {
      sandbox: {
        profile: options.profile ?? "browser",
        maxLifetimeMs: 270_000,
        ...(options.provider ? { provider: options.provider } : {}),
      },
      command: {
        argv,
        timeoutMs: options.timeoutMs ?? 70_000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      collectPaths: [],
    };
    return observed.host.runWorker(plan, id, undefined, {
      hostServices: services,
    });
  }

  read(id: string) {
    const audit = new SqliteAudit(this.auditPath, { readonly: true });
    try {
      return audit.readExecution(id);
    } finally {
      audit.close();
    }
  }

  async exported() {
    const dir = join(this.root, "export");
    exportAudit(this.auditPath, dir);
    const files = (await readdir(join(dir, "audit"))).filter((name) =>
      name.endsWith(".jsonl"),
    );
    assert.ok(files.length, "No audit JSONL exported");
    return (
      await Promise.all(
        files.map((file) => readFile(join(dir, "audit", file), "utf8")),
      )
    ).join("\n");
  }

  async cleanup() {
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    const existing = await this.list();
    if (existing.length) {
      const bindings = new Set<string>();
      for (const id of this.ids) {
        // The adapter labels every invocation, including the disabled-audit
        // latency baseline, which has no sandbox binding row.
        for (const sandbox of await this.list(id)) bindings.add(sandbox);
      }
      for (const name of existing) {
        assert.ok(
          bindings.has(name),
          "Unexpected sandbox in dedicated MSB_HOME",
        );
        await this.msb(["rm", "-f", name]);
      }
    }
    assert.equal(
      (await this.list()).length,
      0,
      "Microsandbox inventory must be empty",
    );
    if (errors.length) throw errors[0];
  }
}

const perl = (script: string, ...args: (string | number)[]) => [
  "/usr/bin/perl",
  "-e",
  script,
  "--",
  ...args.map(String),
];

function service(
  loopbackPort: number,
  ip = serviceIp,
  name = HOST_SERVICE_NAME,
  port = 18080,
): HostService {
  return { ip, port, loopbackPort, hostname: name };
}

function binding(
  scope: Scope,
  history: ExecutionAudit,
  id: string,
  provider?: SandboxProvider,
) {
  const [row] = history.sandboxBindings;
  assert.equal(
    history.sandboxBindings.length,
    1,
    "Expected one durable sandbox binding",
  );
  assert.ok(row);
  assert.equal(row.invocationId, id);
  assert.match(row.sandboxId, /^bootstrap-/);
  assert.equal(row.egressMode, "gateway");
  const gateway = scope.gateways.get(id);
  assert.ok(gateway, "Missing observed gateway");
  const suffix = row.sandboxId
    .slice("bootstrap-".length)
    .replaceAll("-", "")
    .toUpperCase();
  const args = [
    "--no-net",
    "--net-rule",
    expectedRules,
    "--dns-nameserver",
    `127.0.0.1:${gateway.dnsPort}`,
    "--proxy",
    `socks5://127.0.0.1:${gateway.socksPort}`,
    "--socks5-username",
    gateway.username,
    "--socks5-password-env",
    `AGENT_GATEWAY_${suffix}_SECRET`,
  ];
  if (provider)
    args.push(
      "--tls-intercept",
      "--tls-upstream-ca-cert-for",
      `${provider.host}=${provider.upstreamCaCertPath}`,
      "--secret",
      `${provider.secretEnv}:headers=authorization@${provider.host}`,
      "--secret-violation-action",
      "block",
    );
  assert.equal(
    row.netRuleDigest,
    createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    "Durable rule digest differs from the ADR rule set",
  );
  for (const event of history.networkEvents) {
    assert.equal(event.invocationId, id);
    assert.equal(event.sandboxId, row.sandboxId);
    if (event.phase === "decided" || event.phase === "dns")
      assert.equal(event.policyId, row.gatewayPolicyId);
  }
  return row.sandboxId;
}

function connected(
  history: ExecutionAudit,
  ip: string,
  channel: Decision["channel"],
  endReason?: string | readonly string[],
) {
  const decision = findDecision(history, ip, undefined, "allow");
  assert.equal(decision.channel, channel);
  const finished = history.networkEvents.find(
    (row) =>
      row.phase === "finished" && row.connectionId === decision.connectionId,
  );
  assert.ok(
    finished?.phase === "finished" && finished.sequence > decision.sequence,
    "Missing durable network outcome",
  );
  assert.equal(finished.result, "connected");
  assert.ok(
    finished.bytesReceived > 0 && finished.durationMs >= 0,
    "Missing relay accounting",
  );
  if (endReason)
    assert.ok(
      [endReason].flat().includes(finished.endReason ?? ""),
      "Unexpected relay end reason",
    );
  return decision;
}

function findDecision(
  history: ExecutionAudit,
  ip: string,
  port?: number,
  kind: "allow" | "deny" = "deny",
) {
  const decision = history.networkEvents.find(
    (row) =>
      row.phase === "decided" &&
      row.destinationIp === ip &&
      (port === undefined || row.destinationPort === port) &&
      row.decision === kind,
  );
  assert.ok(
    decision?.phase === "decided",
    `Missing ${kind} decision for ${ip}${port === undefined ? "" : ":" + port}`,
  );
  assert.ok(
    history.networkEvents.some(
      (row) =>
        row.phase === "requested" &&
        row.connectionId === decision.connectionId &&
        row.sequence < decision.sequence,
    ),
    "Missing durable network intent",
  );
  return decision;
}

function exitOk(history: ExecutionAudit) {
  assert.ok(
    history.processResults.some(
      (result) => result.exitCode === 0 && result.guestReported,
    ),
    "The guest probe did not exit successfully (see retained audit)",
  );
}

function assertClosedTraffic(history: ExecutionAudit) {
  const allowed = history.networkEvents.filter(
    (row) => row.phase === "decided" && row.decision === "allow",
  );
  assert.equal(allowed.length, 1, "Unexpected durable allow for a second dial");
  assert.ok(allowed[0]?.phase === "decided");
  return allowed[0];
}

async function assertUnknown(scope: Scope, id: string, decision: Decision) {
  const records = (await scope.exported())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const outcomes = records.filter(
    (row) =>
      row.executionId === id &&
      row.sandboxId === decision.sandboxId &&
      row.operationId === decision.connectionId &&
      row.action === "network.connect" &&
      row.phase === "outcome",
  );
  assert.equal(outcomes.length, 1, "Expected one exported outcome");
  assert.equal(outcomes[0].result, "unknown");
  assert.equal(outcomes[0].derived, true);
}

function scopedEvidence(
  scope: Scope,
  id: string,
  history: ExecutionAudit,
  provider?: SandboxProvider,
) {
  return {
    executionId: id,
    sandboxId: binding(scope, history, id, provider),
    networkRows: history.networkEvents.length,
  };
}

function register<T extends { close(): void | Promise<void> }>(
  scope: Scope,
  fixture: T,
) {
  scope.cleanups.push(() => fixture.close());
  return fixture;
}

const bypass: Case = async (scope) => {
  const capture = await captureBypasses();
  let checked = false;
  scope.cleanups.push(async () => {
    if (!checked) await capture();
  });
  const http = register(scope, await tcpFixture("reply"));
  const http6 = register(scope, await tcpFixture("reply", "::1"));
  const observed = await scope.observed();
  const id = randomUUID();
  const tunnel = `${randomUUID()}.tunnel.test`;
  // Gateway ports are assigned inside TrustedHost. Only the test's host
  // process can read them. Fetch them via a mapped fixture in the guest
  // when probing the direct host address.
  const control = register(
    scope,
    await tcpFixture("hold", loopback, (socket) => {
      const gateway = scope.gateways.get(id)!;
      socket.end(` ${gateway.socksPort} ${gateway.dnsPort}\n`);
    }),
  );
  const controlService = service(
    control.port,
    "192.0.2.41",
    `control.${HOST_SERVICE_NAME}`,
    18081,
  );
  const controlProbe = `
my ($af, $control_addr) = address("${controlService.ip}", ${controlService.port});
my $ctl = bounded(5, sub { dial("${controlService.ip}", ${controlService.port}, SOCK_STREAM) })
  or die "control unavailable";
my $cookie = read_n($ctl, length("${canary}"));
check($cookie eq "${canary}", "N-08");
my $ports = <$ctl>;
close $ctl;
check(scalar($ports =~ /^ ([0-9]+) ([0-9]+)$/), "N-21 fixture");
$ARGV[3] = $1; $ARGV[4] = $2;
`;
  const script = bypassGuest.replace(
    "my ($port,",
    controlProbe + "\nmy ($port,",
  );
  await scope.worker(
    observed,
    id,
    perl(script, 18080, http.port, http6.port, 0, 0, tunnel, probeIp, probeV6),
    [service(http.port), controlService],
  );
  checked = true;
  await capture();
  const history = scope.read(id);
  const evidence = scopedEvidence(scope, id, history);
  exitOk(history);
  assert.equal(
    http.connections + http6.connections,
    0,
    "A direct guest probe hit host loopback",
  );
  assert.equal(control.connections, 1);
  connected(history, controlService.ip, "host-service");
  findDecision(history, probeIp, 18080);
  assert.equal(findDecision(history, directIp, 18080).hostname, undefined);
  findDecision(history, probeV6, 18080);
  assert.equal(
    history.networkEvents.filter(
      (row) =>
        row.phase === "decided" &&
        row.destinationIp === probeIp &&
        row.destinationPort === 18080,
    ).length,
    2,
    "NAT64 address was not canonicalized",
  );
  for (const ip of [
    "169.254.169.254",
    "10.22.33.44",
    "169.254.10.11",
    "172.31.254.249",
    "fd42:6d73:62:ffff::2",
  ])
    assert.equal(findDecision(history, ip, 18080).reasonCode, "reserved-range");
  findDecision(history, probeIp, 443);
  for (const row of history.networkEvents) {
    if (row.phase === "requested" || row.phase === "decided")
      assert.ok(
        ![
          53,
          853,
          http.port,
          http6.port,
          scope.gateways.get(id)!.socksPort,
          scope.gateways.get(id)!.dnsPort,
        ].includes(row.destinationPort ?? 0),
        "A pre-gateway probe unexpectedly reached the gateway",
      );
    if (row.phase === "dns")
      assert.ok(
        !row.qname.endsWith(".refused.test"),
        "External resolver probe reached the host gateway",
      );
  }
  for (const protocol of ["tcp", "udp"]) {
    assert.ok(
      history.networkEvents.some(
        (row) =>
          row.phase === "dns" &&
          row.qname === tunnel &&
          row.protocol === protocol &&
          row.decision === "deny" &&
          row.answerIps.length === 0,
      ),
      "Missing tunnel denial",
    );
    assert.ok(
      history.networkEvents.some(
        (row) =>
          row.phase === "dns" &&
          row.qname === HOST_SERVICE_NAME &&
          row.protocol === protocol &&
          row.decision === "allow" &&
          row.answerIps.includes(serviceIp),
      ),
      "Missing DNS fixture answer",
    );
  }
  const mutation = randomUUID();
  const hostPort = http.port;
  const alpineProbe = `
command -v ip >/dev/null
command -v nslookup >/dev/null
dev=$(ip route | awk '$1=="default" {print $5; exit}')
gw=$(ip route | awk '$1=="default" {print $3; exit}')
test -n "$dev" && test -n "$gw"
test "$(id -u)" = 0
ip addr add 192.0.2.92/32 dev "$dev" || :
ip route replace ${probeIp}/32 via "$gw" dev "$dev" || :
ip link add dummy0 type dummy || :
ip link set dummy0 up || :
ip link set "$dev" address 02:00:00:00:00:99 || :
printf 1 > /proc/sys/net/ipv4/ip_forward || :
printf 'nameserver %s\\n' '${probeIp}' > /etc/resolv.conf || :
nslookup obs-root.refused.test '${probeIp}' >/dev/null 2>&1 || :
export http_proxy="http://$gw:${hostPort}" HTTP_PROXY="http://$gw:${hostPort}"
export https_proxy="$http_proxy" HTTPS_PROXY="$http_proxy"
if wget -T 2 -qO- http://${probeIp}:18080/; then exit 47; fi
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY
if wget -T 2 -qO- http://${probeIp}:18080/; then exit 47; fi
`;
  // Restart the witness for the second VM so captures never overlap.
  const mutationCapture = await captureBypasses();
  try {
    await scope.worker(
      observed,
      mutation,
      ["/bin/sh", "-ec", alpineProbe],
      [service(http.port)],
      { profile: "base" },
    );
  } finally {
    await mutationCapture();
  }
  const mutationHistory = scope.read(mutation);
  const mutationEvidence = scopedEvidence(scope, mutation, mutationHistory);
  exitOk(mutationHistory);
  findDecision(mutationHistory, probeIp, 18080);
  assert.equal(
    http.connections,
    0,
    "The root/proxy probe reached host loopback directly",
  );
  const rows = [
    2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  ];
  return new Map(
    rows.map((row) => [
      `N-${String(row).padStart(2, "0")}`,
      row === 19 || row === 20 ? mutationEvidence : evidence,
    ]),
  );
};

const provider: Case = async (scope) => {
  const tls = register(scope, await providerFixture(scope.root));
  const id = randomUUID();
  const spec = { host: providerName, secretEnv, upstreamCaCertPath: tls.ca };
  const observed = await scope.observed({
    provider: spec,
    token: tls.token,
    upstream: tls.port,
    onDial(execution, ip, port) {
      // Take a SQLite snapshot before the hook can return an upstream socket.
      findDecision(scope.read(execution), ip, port, "allow");
    },
  });
  const script = `
test "$${secretEnv}" = '$MSB_${secretEnv}'
body=$(printf 'GET /obs10 HTTP/1.1\\r\\nHost: ${providerName}\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n' "$${secretEnv}" |
  openssl s_client -quiet -ign_eof -ignore_unexpected_eof -connect '${providerName}:443' -servername '${providerName}' 2>/dev/null)
printf '%s\\n' "$body" | tr -d '\\r' | grep -qx '${canary}'
`;
  await scope.worker(observed, id, ["/bin/sh", "-ec", script], [], {
    provider: spec,
  });
  const history = scope.read(id);
  const evidence = scopedEvidence(scope, id, history, spec);
  exitOk(history);
  assert.equal(tls.hits, 1, "Exactly one fixture HTTPS request required");
  assert.equal(
    tls.correct,
    1,
    "Provider did not receive the synthetic credential",
  );
  const decision = connected(history, providerIp, "provider-egress");
  assert.equal(decision.hostname, providerName);
  assert.equal(decision.reasonCode, "allowlisted-host");
  assert.ok(
    history.networkEvents.some(
      (row) =>
        row.phase === "dns" &&
        row.qname === providerName &&
        row.decision === "allow" &&
        row.answerIps.includes(providerIp) &&
        row.sequence < decision.sequence,
    ),
    "Missing durable provider DNS pin",
  );
  const jsonl = await scope.exported();
  assert.ok(
    [JSON.stringify(history), jsonl].every(
      (data) =>
        !data.includes(tls.token) &&
        !data.includes(`$MSB_${secretEnv}`) &&
        !data.includes("/obs10"),
    ),
    "Provider data leaked into the audit",
  );
  return new Map<string, Evidence>([
    ["N-01", evidence],
    ["N-22", { ...evidence, syntheticCredentialVerified: true }],
  ]);
};

function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

const outage: Case = async (scope) => {
  const capture = await captureBypasses([serviceIp]);
  scope.cleanups.push(capture);
  const id = randomUUID();
  const creationFailure = randomUUID();
  const fixture = register(scope, await tcpFixture("hold"));
  const observed = await scope.observed({ failFactoryFor: creationFailure });
  const run = settled(
    scope.worker(observed, id, perl(holdGuest, serviceIp, 18080, "down"), [
      service(fixture.port),
    ]),
  );
  try {
    await until(
      () => fixture.active === 1 && fixture.bytes >= 3,
      "Initial relay did not exchange its canary",
    );
    await scope.gateways.get(id)!.close();
    const result = await run;
    assert.ok(
      "value" in result && result.value.outcome === "ok",
      "Outage probes failed",
    );
  } finally {
    await run;
  }
  const history = scope.read(id);
  exitOk(history);
  const evidence = scopedEvidence(scope, id, history);
  connected(history, serviceIp, "host-service", "sandbox-destroyed");
  assertClosedTraffic(history);
  assert.equal(fixture.connections, 1);
  assert.ok(
    !history.networkEvents.some((row) => row.phase === "dns"),
    "DNS fallback unexpectedly reached the gateway",
  );
  await scope.worker(
    observed,
    creationFailure,
    ["/bin/sh", "-c", "exit 47"],
    [service(fixture.port)],
  );
  const refused = scope.read(creationFailure);
  assert.ok(
    refused.auditEvents.some(
      (row) => row.kind === "invocation.finished" && row.outcome === "failed",
    ),
    "Gateway startup outage was not recorded as an invocation failure",
  );
  assert.equal(refused.sandboxBindings.length, 0);
  assert.equal(refused.processResults.length, 0);
  assert.equal(refused.networkEvents.length, 0);
  return { ...evidence, failedFactoryExecutionId: creationFailure };
};

const fault: Case = async (scope) => {
  const id = randomUUID();
  const { Database } = createRequire(import.meta.url)("bun:sqlite") as {
    Database: new (file: string) => {
      exec(statement: string): unknown;
      close(): void;
    };
  };
  let release: (() => void) | undefined;
  const fixture = register(
    scope,
    await tcpFixture("hold", loopback, () => {
      // WAL chmod after open leaves an already-open descriptor writable. An
      // independent SQLite RESERVED lock makes the real writer fail its next
      // transaction without replacing or altering the schema.
      if (release) return;
      const lock = new Database(scope.auditPath);
      lock.exec("BEGIN IMMEDIATE");
      release = () => {
        lock.close();
      };
    }),
  );
  const dns = register(scope, await dnsClient());
  const observed = await scope.observed();
  const run = settled(
    scope.worker(observed, id, perl(holdGuest, serviceIp, 18080, "fault"), [
      service(fixture.port),
    ]),
  );
  try {
    await until(
      () => release !== undefined,
      "Could not lock audit during an active relay",
    );
    const gateway = scope.gateways.get(id)!;
    await until(
      () => gateway.quarantineReason === "audit-failure",
      "The audit writer did not enter quarantine",
    );
    assert.equal(observed.audit.isV5Writable, false);
    const [auth, rcode] = await Promise.all([
      socksAuth(gateway.socksPort, gateway),
      dns.query(gateway.dnsPort, HOST_SERVICE_NAME),
    ]);
    assert.equal(auth, false, "Quarantined gateway still accepts SOCKS");
    assert.ok(
      rcode === undefined || rcode === 2,
      "Quarantined gateway still returns DNS policy replies",
    );
    await until(
      () => fixture.active === 0,
      "The active upstream relay was not closed",
    );
    const result = await run;
    assert.ok(
      "error" in result && result.error instanceof HostAuditError,
      "Invocation did not halt with HostAuditError",
    );
    assert.equal(
      (await scope.list()).length,
      0,
      "Emergency teardown left a sandbox",
    );
  } finally {
    release?.();
    await run;
  }
  const history = scope.read(id);
  const decision = assertClosedTraffic(history);
  const evidence = scopedEvidence(scope, id, history);
  assert.equal(fixture.connections, 1);
  assert.equal(
    history.processResults.length,
    0,
    "Host continued writing a normal process outcome",
  );
  assert.ok(
    !history.auditEvents.some((row) => row.kind === "invocation.finished"),
  );
  assert.ok(
    !history.networkEvents.some(
      (row) => row.phase === "dns" && row.qname === "obs-fault.test",
    ),
  );
  assert.ok(
    !history.networkEvents.some((row) => row.phase === "finished"),
    "Finish committed while the database was locked",
  );
  await assertUnknown(scope, id, decision);
  return { ...evidence, relayClosed: true, invocationHalted: true };
};

const concurrency: Case = async (scope) => {
  const ids = [randomUUID(), randomUUID()] as const;
  const ips = [serviceIp, "192.0.2.42"] as const;
  const sockets = new Map<string, import("node:net").Socket>();
  const first = register(
    scope,
    await tcpFixture("hold", loopback, (socket) => {
      sockets.set(ids[0], socket);
    }),
  );
  const second = register(
    scope,
    await tcpFixture("hold", loopback, (socket) => {
      sockets.set(ids[1], socket);
    }),
  );
  const observed = await scope.observed();
  const start = (index: 0 | 1, port: number) =>
    settled(
      scope.worker(
        observed,
        ids[index],
        perl(holdGuest, ips[index], 18080, "other", ips[1 - index]!),
        [service(port, ips[index])],
      ),
    );
  const runs = [start(0, first.port), start(1, second.port)];
  try {
    await until(() => sockets.size === 2, "Both VM relays must overlap");
    const gateways = [
      scope.gateways.get(ids[0])!,
      scope.gateways.get(ids[1])!,
    ] as const;
    const live = await scope.list();
    assert.equal(live.length, 2, "Expected exactly two live sandboxes");
    assert.equal(first.active + second.active, 2);
    assert.notEqual(gateways[0].socksPort, gateways[1].socksPort);
    assert.notEqual(gateways[0].dnsPort, gateways[1].dnsPort);
    assert.deepEqual(
      await Promise.all([
        socksAuth(gateways[0].socksPort, gateways[1]),
        socksAuth(gateways[1].socksPort, gateways[0]),
      ]),
      [false, false],
      "Cross-sandbox SOCKS identity was accepted",
    );
    ids.forEach((id, index) => {
      const other = gateways[1 - index]!;
      sockets.get(id)!.write(`${other.socksPort} ${other.dnsPort}\n`);
    });
    for (const result of await Promise.all(runs))
      assert.ok(
        "value" in result && result.value.outcome === "ok",
        "A concurrency guest probe failed",
      );
    const executions = ids.map((id, index) => {
      const history = scope.read(id);
      const evidence = scopedEvidence(scope, id, history);
      assert.ok(live.includes(evidence.sandboxId));
      exitOk(history);
      connected(history, ips[index]!, "host-service");
      findDecision(history, ips[1 - index]!, 18080);
      assert.ok(
        history.networkEvents.some(
          (row) =>
            row.phase === "decided" &&
            row.decision === "deny" &&
            row.reasonCode === "auth-failed",
        ),
        "Missing cross-identity denial",
      );
      assertClosedTraffic(history);
      assert.ok(
        history.networkEvents.some(
          (row) =>
            row.phase === "dns" &&
            row.qname === HOST_SERVICE_NAME &&
            row.decision === "allow" &&
            row.answerIps.length === 1 &&
            row.answerIps[0] === ips[index],
        ),
        "Missing DNS answer for this sandbox's mapped address",
      );
      assert.ok(
        !history.networkEvents.some(
          (row) => row.phase === "dns" && row.qname === "obs-cross.test",
        ),
        "A sandbox reached the other DNS listener",
      );
      return evidence;
    });
    assert.notEqual(executions[0]!.sandboxId, executions[1]!.sandboxId);
    assert.equal(first.connections, 1);
    assert.equal(second.connections, 1);
    return { executions };
  } finally {
    await Promise.all(runs);
  }
};

const forced: Case = async (scope) => {
  const id = randomUUID();
  const fixture = register(scope, await tcpFixture("hold"));
  const observed = await scope.observed();
  const run = settled(
    scope.worker(observed, id, perl(holdGuest, serviceIp, 18080, "hold"), [
      service(fixture.port),
    ]),
  );
  try {
    await until(
      () => fixture.active === 1 && fixture.bytes >= 3,
      "Could not observe an active relay",
    );
    const history = scope.read(id);
    const sandbox = binding(scope, history, id);
    const decision = assertClosedTraffic(history);
    assert.ok(
      !history.networkEvents.some((row) => row.phase === "finished"),
      "Relay ended before force removal",
    );
    await scope.msb(["rm", "-f", sandbox]);
    await run;
    await until(
      () => fixture.active === 0,
      "Forced removal did not close the upstream",
    );
    const final = scope.read(id);
    // Forced `msb rm -f` kills the VMM, whose netstack closes the guest-side
    // socket to the gateway. That close races the host's own gateway close.
    // Either order ends a durable "connected" relay with the upstream closed
    // (asserted below) and exactly one finished row; both reasons are truthful.
    connected(final, serviceIp, "host-service", [
      "sandbox-destroyed",
      "client-closed",
    ]);
    assert.equal(
      final.networkEvents.filter((row) => row.phase === "finished").length,
      1,
      "Forced removal must produce exactly one relay outcome",
    );
    assert.equal(
      assertClosedTraffic(final).connectionId,
      decision.connectionId,
    );
    assert.equal(fixture.connections, 1);
    return scopedEvidence(scope, id, final);
  } finally {
    await run;
  }
};

async function crashChild(scope: Scope, id: string, port: number) {
  const observed = await scope.observed();
  await scope.worker(
    observed,
    id,
    perl(holdGuest, serviceIp, 18080, "hold"),
    [service(port)],
    { timeoutMs: 240_000 },
  );
  throw new Error("Crash fixture returned without being killed");
}

const crashed: Case = async (scope) => {
  const capture = await captureBypasses([serviceIp]);
  scope.cleanups.push(capture);
  const fixture = register(scope, await tcpFixture("hold"));
  const id = randomUUID();
  scope.ids.add(id);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--crash-child",
      scope.root,
      scope.home,
      scope.binary,
      id,
      String(fixture.port),
    ],
    { stdio: "ignore", env: { PATH: "/usr/bin:/bin", OBS10_VM: "1" } },
  );
  let exited = false;
  const termination = new Promise<string | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => {
      exited = true;
      resolve(signal);
    });
  });
  void termination.catch(() => {});
  try {
    await until(
      () => (fixture.active === 1 && fixture.bytes >= 3) || exited,
      "Child host did not establish its relay",
    );
    assert.ok(!exited, "Child host exited before its relay became active");
    const before = scope.read(id);
    const decision = assertClosedTraffic(before);
    const [row] = before.sandboxBindings;
    assert.ok(
      row?.egressMode === "gateway" &&
        row.sandboxId === decision.sandboxId &&
        row.gatewayPolicyId === decision.policyId,
      "Crash relay was not bound to the audited sandbox",
    );
    assert.ok(
      !before.networkEvents.some((event) => event.phase === "finished"),
      "Crash relay already ended",
    );
    assert.ok(child.kill("SIGKILL"));
    assert.equal(await termination, "SIGKILL");
    await until(
      () => fixture.active === 0,
      "Host death left an active upstream",
    );
    // The VM remains up after the host dies. Exercise its stale gateway
    // binding before removing it, using the same local-only target.
    await scope.msb([
      "exec",
      "--no-stdin",
      "--no-tty",
      "--timeout",
      "10s",
      row.sandboxId,
      "--",
      ...perl(
        guestPerl +
          String.raw`
check(tcp($ARGV[0], 18080) ne "${canary}", "N-26 stale SOCKS");
check(dns(gateway(), "udp", "host-service.agent-bootstrap.internal") ne "0/1", "N-26 stale DNS");
`,
        serviceIp,
      ),
    ]);
    await scope.msb(["rm", "-f", row.sandboxId]);
    const after = scope.read(id); // Reopen the abrupt writer's SQLite/WAL.
    assert.deepEqual(
      after.networkEvents,
      before.networkEvents,
      "Crash produced unexpected network records",
    );
    assert.ok(
      !after.auditEvents.some((event) => event.kind === "invocation.finished"),
    );
    assert.equal(
      fixture.connections,
      1,
      "Outbound traffic continued after host death",
    );
    await assertUnknown(scope, id, decision);
    return {
      executionId: id,
      sandboxId: row.sandboxId,
      networkRows: after.networkEvents.length,
      outcome: "unknown",
    };
  } finally {
    if (!exited) child.kill("SIGKILL");
    await termination.catch(() => {});
  }
};

const limits: Case = async (scope) => {
  const [rateId, capId, overrideId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ] as const;
  const dns = register(scope, await dnsClient());
  const observed = await scope.observed({
    limits: (id) =>
      id === capId
        ? {
            attemptBurst: 8192,
            attemptsPerSecond: 8192,
            idleTimeoutMs: 220_000,
          }
        : id === overrideId
          ? { attemptBurst: 256, attemptsPerSecond: 256, maxNetworkRows: 12 }
          : undefined,
  });
  async function exercise<T extends Evidence>(
    id: string,
    load: (port: number) => Promise<T>,
    reason: string,
  ) {
    const fixture = register(scope, await tcpFixture("hold"));
    const abort = new AbortController();
    const run = settled(
      scope.worker(
        observed,
        id,
        perl(holdGuest, serviceIp, 18080, "hold"),
        [service(fixture.port)],
        { timeoutMs: 240_000, signal: abort.signal },
      ),
    );
    try {
      await until(
        () => fixture.active === 1 && fixture.bytes >= 3,
        "Limits fixture did not establish its relay",
      );
      const gateway = scope.gateways.get(id)!;
      const measured = await load(gateway.dnsPort);
      assert.equal(gateway.quarantineReason, reason);
      const result = await run;
      assert.ok(
        "error" in result && result.error instanceof HostAuditError,
        "Limit did not halt the invocation",
      );
      await until(
        () => fixture.active === 0,
        "Limit did not close its active relay",
      );
      const history = scope.read(id);
      const evidence = scopedEvidence(scope, id, history);
      assert.equal(fixture.connections, 1);
      assertClosedTraffic(history);
      assert.ok(
        history.resourceEvents.some((row) => row.kind === "limit-exceeded"),
        "Missing durable limit event",
      );
      return { ...evidence, ...measured };
    } finally {
      abort.abort();
      await run;
    }
  }

  const rate = await exercise(
    rateId,
    async (port) => {
      // A sustained load below 16/s should refill the bucket. A concentrated
      // load should then quarantine it. One TCP attempt is already charged.
      const steadyStart = performance.now();
      for (let i = 0; i < 48; i++) {
        assert.equal(await dns.query(port, `steady-${i}.limits.test`), 3);
        await delay(75);
      }
      const steadyMs = performance.now() - steadyStart;
      const start = performance.now();
      const responses = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          dns.query(port, `burst-${i}.limits.test`),
        ),
      );
      const admitted = responses.filter((rcode) => rcode === 3).length;
      return {
        answered: admitted,
        steadyPerSecond: 48_000 / steadyMs,
        elapsedMs: performance.now() - start,
      };
    },
    "rate-limited",
  );
  const rateRows = scope.read(rateId).networkEvents;
  const burstRows = rateRows.filter(
    (row) => row.phase === "dns" && row.qname.startsWith("burst-"),
  );
  assert.equal(
    rateRows.filter(
      (row) => row.phase === "dns" && row.qname.startsWith("steady-"),
    ).length,
    48,
  );
  assert.ok(
    burstRows.length >= 31 &&
      burstRows.length <= 32 + Math.ceil((rate.elapsedMs * 16) / 1000),
    "Durable burst admission did not match the default token bucket",
  );

  const measureCap = (cap: number) => async (port: number) => {
    const start = performance.now();
    // Reserve two decisions and a finish for the held TCP connection. Every
    // DNS decision uses one row. The next answer must fail closed.
    for (let i = 0; i < cap - 3; i++)
      assert.equal(
        await dns.query(port, `cap-${i}.limits.test`),
        3,
        "DNS refused before the row cap",
      );
    assert.notEqual(
      await dns.query(port, "over-cap.limits.test"),
      3,
      "DNS exceeded the row cap",
    );
    return { cap, elapsedMs: performance.now() - start };
  };
  const cap = await exercise(capId, measureCap(4096), "network-row-limit");
  const override = await exercise(
    overrideId,
    measureCap(12),
    "network-row-limit",
  );
  assert.equal(cap.networkRows, 4096);
  assert.equal(override.networkRows, 12);
  return {
    rate: {
      ...rate,
      durableBurstAdmissions: burstRows.length,
      burst: 32,
      perSecond: 16,
    },
    cap,
    override,
  };
};

const overhead: Case = async (scope) => {
  const fixture = register(scope, await tcpFixture("reply"));
  async function measure(mode: "required" | "disabled") {
    const observed = await scope.observed({ mode, debianBase: true });
    const id = randomUUID();
    scope.ids.add(id);
    const audited = mode === "required";
    const port = audited ? 18080 : fixture.port;
    const script =
      guestPerl +
      String.raw`
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC usleep);
my $ip = $ARGV[0] eq "direct" ? gateway() : $ARGV[0];
for (1 .. 100) {
  my $start = clock_gettime(CLOCK_MONOTONIC);
  check(tcp($ip, $ARGV[1]) eq "${canary}", "latency canary");
  printf "%.6f\n", 1000 * (clock_gettime(CLOCK_MONOTONIC) - $start);
  usleep(75000);
}
`;
    const result = await observed.host.runReviewer(
      {
        sandbox: audited ? {} : { hostTcpPort: port },
        command: {
          argv: perl(script, audited ? serviceIp : "direct", port),
          timeoutMs: 45_000,
        },
      },
      id,
      undefined,
      audited
        ? { hostServices: [service(fixture.port)] }
        : { allowUnauditedRun: true },
    );
    assert.equal(result.outcome, "ok");
    assert.ok(result.response, "Latency samples missing");
    const samples = new TextDecoder()
      .decode(result.response)
      .trim()
      .split("\n")
      .map(Number);
    assert.equal(samples.length, 100);
    assert.ok(
      samples.every((sample) => Number.isFinite(sample) && sample > 0),
      "Invalid latency sample",
    );
    const history = scope.read(id);
    if (audited) {
      scopedEvidence(scope, id, history);
      exitOk(history);
      assert.equal(
        history.networkEvents.filter(
          (row) =>
            row.phase === "decided" &&
            row.decision === "allow" &&
            row.channel === "host-service" &&
            row.destinationIp === serviceIp &&
            row.destinationPort === port,
        ).length,
        100,
      );
      assert.equal(
        history.networkEvents.filter(
          (row) =>
            row.phase === "finished" &&
            row.result === "connected" &&
            row.bytesReceived >= canary.length,
        ).length,
        100,
      );
    } else {
      // Disabled audit is the latency baseline: the guest exit was checked
      // above (result.outcome), and nothing may be written to the audit.
      assert.equal(history.auditEvents.length, 0, "Disabled audit wrote rows");
      assert.equal(history.networkEvents.length, 0);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    await observed.close();
    return {
      executionId: id,
      samples: samples.length,
      p50Ms: sorted[49]!,
      p95Ms: sorted[94]!,
    };
  }
  const direct = await measure("disabled");
  assert.equal(fixture.connections, 100);
  const gateway = await measure("required");
  assert.equal(fixture.connections, 200);
  return { direct, gateway, p50OverheadMs: gateway.p50Ms - direct.p50Ms };
};

const cases: Record<string, { run: Case; rows: string[] }> = {
  bypass: {
    run: bypass,
    rows: Array.from(
      { length: 20 },
      (_, i) => `N-${String(i + 2).padStart(2, "0")}`,
    ),
  },
  provider: { run: provider, rows: ["N-01", "N-22"] },
  outage: { run: outage, rows: ["N-23"] },
  fault: { run: fault, rows: ["N-24"] },
  concurrency: { run: concurrency, rows: ["N-25"] },
  forced: { run: forced, rows: ["N-26"] },
  crashed: { run: crashed, rows: ["N-26"] },
  limits: { run: limits, rows: ["sec-1-limits"] },
  overhead: { run: overhead, rows: ["gateway-overhead"] },
};

function report(data: Evidence) {
  console.log(JSON.stringify({ suite: "obs-10", ...data }));
}

async function main(selected: string) {
  assert.ok(
    Object.hasOwn(cases, selected),
    "Choose bypass, provider, outage, fault, concurrency, forced, crashed, limits or overhead",
  );
  assert.ok(
    process.env.OBS10_VM === "1",
    "Coordinator VM/socket opt-in required",
  );
  const requested = process.env.MSB_HOME;
  assert.ok(
    requested && isAbsolute(requested),
    "Set an absolute dedicated MSB_HOME with preloaded images",
  );
  const home = await realpath(requested);
  const work = fileURLToPath(new URL("../../.local/", import.meta.url));
  await mkdir(work, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(work, "obs10-"));
  const mise = (await runFile("/usr/bin/which", ["mise"])).stdout.trim();
  assert.ok(isAbsolute(mise), "Pinned Microsandbox launcher needs mise");
  const dataDir =
    process.env.MISE_DATA_DIR ??
    join(
      process.env.XDG_DATA_HOME ??
        join(process.env.HOME ?? "", ".local", "share"),
      "mise",
    );
  assert.ok(isAbsolute(dataDir), "Set an absolute MISE_DATA_DIR");
  await access(join(dataDir, "installs", "microsandbox", "0.7.16", "msb"));

  const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const env = ["HOME"].flatMap((key) => {
    const value = process.env[key];
    return value ? [`export ${key}=${shellQuote(value)}`] : [];
  });
  const binary = join(root, "pinned-msb");
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      ...env,
      `export MISE_DATA_DIR=${shellQuote(dataDir)} MISE_OFFLINE=1 MISE_NOT_FOUND_AUTO_INSTALL=false`,
      `exec ${shellQuote(mise)} --no-config --no-env --no-hooks exec microsandbox@0.7.16 -- msb "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const scope = new Scope(root, home, binary);
  const spec = cases[selected]!;
  let evidence: Evidence | Map<string, Evidence> | undefined;
  let stage = "inventory";
  let failure: string | undefined;
  let entered = false;
  try {
    assert.equal(
      await scope.msb(["--version"]),
      "msb 0.7.16",
      "Pinned Microsandbox version required",
    );
    assert.equal(
      (await scope.list()).length,
      0,
      "Start with an empty dedicated MSB_HOME",
    );
    entered = true;
    stage = "assert";
    evidence = await spec.run(scope);
  } catch (error) {
    failure =
      error instanceof assert.AssertionError
        ? error.message.split("\n")[0]!
        : `Failure at ${stage}`;
  } finally {
    if (entered) {
      try {
        await scope.cleanup();
      } catch (error) {
        const detail =
          error instanceof assert.AssertionError
            ? error.message.split("\n")[0]
            : "cleanup failed";
        failure = [failure, detail].filter(Boolean).join(" / ");
      }
    }
  }
  for (const row of spec.rows)
    report({
      case: selected,
      row,
      status: failure ? "fail" : "pass",
      artifacts: root,
      ...(failure
        ? { failure }
        : evidence instanceof Map
          ? evidence.get(row)
          : evidence),
    });
  if (failure) process.exitCode = 1;
  await rm(binary, { force: true });
}

const [selected = "", root, home, binary, id, port] = process.argv.slice(2);
if (selected === "--crash-child") {
  assert.ok(
    process.env.OBS10_VM === "1",
    "Coordinator VM/socket opt-in required",
  );
  assert.ok(root && home && binary && id && port);
  await crashChild(new Scope(root, home, binary), id, Number(port));
} else {
  await main(selected).catch((error: unknown) => {
    report({
      case: selected,
      status: "fail",
      failure:
        error instanceof assert.AssertionError
          ? error.message
          : "Prerequisite failed",
    });
    process.exitCode = 1;
  });
}
