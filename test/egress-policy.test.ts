import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canonicalizeIp,
  DnsPinTable,
  EgressPolicy,
  HOST_SERVICE_NAME,
} from "../src/egress-policy.ts";

const sandbox = "sandbox-a";
const hostname = "api.example.test";
const publicIp = "93.184.215.14";
const hostServiceIp = "192.0.2.10";

describe("egress policy", () => {
  const scenarios = [
    {
      row: "N-02 non-allowlisted public IP",
      ip: publicIp,
      reason: "not-allowlisted",
    },
    {
      row: "N-03 direct IP without a pin",
      ip: publicIp,
      hosts: true,
      reason: "unpinned-ip",
    },
    {
      row: "N-03 explicit IP and port",
      ip: publicIp,
      explicitIp: true,
      reason: "allowlisted-ip",
      upstream: publicIp,
    },
    {
      row: "N-04 public IPv6 pinned",
      ip: "2606:4700:0000::1111",
      pinIp: "2606:4700::1111",
      reason: "allowlisted-host",
      upstream: "2606:4700::1111",
    },
    {
      row: "N-04 public IPv6 unpinned",
      ip: "2606:4700::1111",
      hosts: true,
      reason: "unpinned-ip",
    },
    {
      row: "N-05 NAT64 public IP",
      ip: "64:ff9b::5db8:d70e",
      pinIp: publicIp,
      reason: "allowlisted-host",
      upstream: publicIp,
    },
    {
      row: "N-06 metadata even with explicit allow",
      ip: "169.254.169.254",
      explicitIp: true,
      reason: "reserved-range",
    },
    {
      row: "N-07 msb IPv4 gateway if it reaches the policy",
      ip: "172.16.0.5",
      explicitIp: true,
      reason: "reserved-range",
    },
    {
      row: "N-07 msb IPv6 gateway if it reaches the policy",
      ip: "fd42:6d73:62:1::1",
      explicitIp: true,
      reason: "reserved-range",
    },
    {
      row: "N-08 published host service",
      ip: hostServiceIp,
      reason: "host-service",
      upstream: "127.0.0.1",
    },
    {
      row: "N-14 unlisted DoH resolver",
      ip: "1.1.1.1",
      reason: "not-allowlisted",
    },
    {
      row: "N-14 explicitly allowed HTTPS",
      ip: "1.1.1.1",
      explicitIp: true,
      reason: "allowlisted-ip",
      upstream: "1.1.1.1",
    },
  ];

  for (const {
    row,
    ip,
    hosts,
    explicitIp,
    pinIp,
    reason,
    upstream,
  } of scenarios) {
    test(row, () => {
      const policy = new EgressPolicy({
        allow: hosts || pinIp ? [{ hostname, port: 443 }] : [],
        allowIps: explicitIp ? [{ ip, port: 443 }] : [],
        hostServices: [
          {
            ip: hostServiceIp,
            hostname: HOST_SERVICE_NAME,
            port: 443,
            loopbackPort: 8080,
          },
        ],
      });
      if (pinIp) policy.dnsPins.pin(sandbox, hostname, pinIp, 60);
      const decision = policy.decideConnect({ ip, port: 443, sandbox });
      assert.equal(decision.reasonCode, reason);
      if (upstream) {
        assert.partialDeepStrictEqual(decision, {
          decision: "allow",
          channel: reason === "host-service" ? "host-service" : "egress",
          upstream: {
            ip: upstream,
            port: reason === "host-service" ? 8080 : 443,
          },
        });
      } else {
        assert.partialDeepStrictEqual(decision, {
          decision: "deny",
          upstream: null,
        });
      }
    });
  }

  for (const ip of [
    "0.0.0.0",
    "0.1.2.3",
    "10.255.1.2",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.1.2",
    "172.31.255.255",
    "192.168.1.2",
    "224.0.0.1",
    "239.255.255.255",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd42:6d73:62:1::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:172.16.0.5",
    "64:ff9b::ac10:5",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::",
    "64:ff9b::1",
    "::ffff:1",
    "64:ff9b:1::a9fe:a9fe",
  ])
    test(`reserved ${ip} overrides both IP and hostname allowance`, () => {
      const policy = new EgressPolicy({
        allow: [{ hostname, port: 443 }],
        allowIps: [{ ip, port: 443 }],
      });
      policy.dnsPins.pin(sandbox, hostname, ip, 60);
      assert.deepEqual(policy.decideConnect({ ip, port: 443, sandbox }), {
        decision: "deny",
        reasonCode: "reserved-range",
        channel: "egress",
        upstream: null,
      });
    });

  const examples: [string, string | undefined][] = [
    ["::ffff:93.184.215.14", publicIp],
    ["64:FF9B:0:0:0:0:5db8:D70E", publicIp],
    ["64:ff9b::0.1.0.0", "0.1.0.0"],
    ["0:0:0:0:0:ffff:0:1", "0.0.0.1"],
    ["64:ff9b::", "0.0.0.0"],
    ["64:ff9b::1", "0.0.0.1"],
    ["::ffff:1", "::ffff:1"],
    ["2001:0DB8:0000:0:0:0:0:1", "2001:db8::1"],
    ["93.184.215.14\n", undefined],
    ["[::1]", undefined],
    ["fe80::1%en0", undefined],
    ["0127.0.0.1", undefined],
    ["127.1", undefined],
    ["0x7f000001", undefined],
    ["1::2::3", undefined],
    ["::ffff:999.0.0.1", undefined],
    ["example.test", undefined],
  ];
  for (const [input, expected] of examples)
    test(`canonicalizes ${JSON.stringify(input)} without accepting ambiguous forms`, () => {
      assert.equal(canonicalizeIp(input), expected);
    });

  test("requires the same sandbox, exact hostname, port, and live TTL", () => {
    let now = 100;
    const pins = new DnsPinTable(() => now);
    const policy = new EgressPolicy({ allow: [{ hostname, port: 443 }] }, pins);
    const destination = { ip: publicIp, port: 443, sandbox };
    pins.pin(sandbox, `unlisted.${hostname}`, publicIp, 60);
    assert.equal(
      policy.decideConnect(destination).reasonCode,
      "not-allowlisted",
    );
    pins.pin(sandbox, "API.EXAMPLE.TEST.", "::ffff:93.184.215.14", 2);
    now = 2099;
    assert.partialDeepStrictEqual(policy.decideConnect(destination), {
      decision: "allow",
      hostname,
    });
    assert.equal(
      policy.decideConnect({ ...destination, sandbox: "sandbox-b" }).reasonCode,
      "unpinned-ip",
    );
    assert.equal(
      policy.decideConnect({ ...destination, port: 444 }).reasonCode,
      "not-allowlisted",
    );
    now = 2100;
    assert.equal(policy.decideConnect(destination).decision, "deny");
    pins.pin(sandbox, hostname, publicIp, 0);
    assert.equal(policy.decideConnect(destination).decision, "deny");
    pins.pin(sandbox, hostname, publicIp, 2);
    pins.clear(sandbox);
    assert.equal(policy.decideConnect(destination).reasonCode, "unpinned-ip");
  });

  test("uses the provider channel only with an exact allowed provider pin", () => {
    const provider = "provider.example.test";
    const providerBinding = { hostname: provider, port: 443 };
    const policy = new EgressPolicy({
      allow: [
        { hostname, port: 443 },
        providerBinding,
        { hostname: provider, port: 8443 },
      ],
      providerBinding,
      allowIps: [{ ip: publicIp, port: 443 }],
    });
    const destination = { ip: publicIp, port: 443, sandbox };
    assert.partialDeepStrictEqual(policy.decideConnect(destination), {
      reasonCode: "allowlisted-ip",
      channel: "egress",
    });
    policy.dnsPins.pin(sandbox, hostname, publicIp, 60);
    assert.partialDeepStrictEqual(policy.decideConnect(destination), {
      hostname,
      channel: "egress",
    });
    policy.dnsPins.pin(sandbox, provider, publicIp, 60);
    assert.partialDeepStrictEqual(policy.decideConnect(destination), {
      hostname: provider,
      channel: "provider-egress",
    });
    assert.partialDeepStrictEqual(
      policy.decideConnect({ ...destination, port: 8443 }),
      {
        channel: "egress",
      },
    );

    const bindingOnly = new EgressPolicy(
      { allow: [], providerBinding },
      policy.dnsPins,
    );
    assert.equal(bindingOnly.decideConnect(destination).decision, "deny");
    assert.equal(
      bindingOnly.decideDns({ qname: provider, qtype: 1 }).decision,
      "deny",
    );
  });

  test("serves exact A and AAAA names, with local answers for host services", () => {
    const policy = new EgressPolicy({
      allow: [{ hostname, port: 443 }],
      hostServices: [
        {
          ip: hostServiceIp,
          hostname: HOST_SERVICE_NAME,
          port: 443,
          loopbackPort: 8080,
        },
        {
          ip: hostServiceIp,
          hostname: HOST_SERVICE_NAME,
          port: 8443,
          loopbackPort: 8081,
        },
        {
          ip: "2001:db8::10",
          hostname: HOST_SERVICE_NAME,
          port: 443,
          loopbackPort: 8080,
        },
        {
          ip: "198.51.100.10",
          hostname: `mock.${HOST_SERVICE_NAME}`,
          port: 80,
          loopbackPort: 8080,
        },
        { ip: "203.0.113.10", port: 443, loopbackPort: 8080 },
      ],
    });
    for (const qtype of [1, 28]) {
      assert.deepEqual(
        policy.decideDns({ qname: "API.EXAMPLE.TEST.", qtype }),
        {
          decision: "allow",
          reasonCode: "allowlisted-host",
          hostname,
        },
      );
      assert.deepEqual(policy.decideDns({ qname: HOST_SERVICE_NAME, qtype }), {
        decision: "allow",
        reasonCode: "host-service",
        hostname: HOST_SERVICE_NAME,
        addresses: qtype === 1 ? [hostServiceIp] : ["2001:db8::10"],
      });
    }
    assert.partialDeepStrictEqual(
      policy.decideDns({ qname: `mock.${HOST_SERVICE_NAME}`, qtype: 28 }),
      { addresses: [] },
    );
    for (const qname of [
      `random.${hostname}`,
      `missing.${HOST_SERVICE_NAME}`,
      "host.microsandbox.internal",
      hostname + "\n",
      "foo..test",
      "203.0.113.10",
    ]) {
      assert.deepEqual(policy.decideDns({ qname, qtype: 1 }), {
        decision: "deny",
        reasonCode: "dns-not-allowlisted",
        response: "NXDOMAIN",
      });
    }
    for (const qtype of [5, 12, 16, 65, 255]) {
      assert.deepEqual(policy.decideDns({ qname: HOST_SERVICE_NAME, qtype }), {
        decision: "deny",
        reasonCode: "dns-type-refused",
        response: "NXDOMAIN",
      });
    }
    assert.partialDeepStrictEqual(
      policy.decideConnect({ ip: "::ffff:192.0.2.10", port: 8443, sandbox }),
      {
        upstream: { ip: "127.0.0.1", port: 8081 },
      },
    );
    assert.partialDeepStrictEqual(
      policy.decideConnect({ ip: "64:ff9b::c000:20a", port: 443, sandbox }),
      {
        upstream: { ip: "127.0.0.1", port: 8080 },
      },
    );
    const service = { ip: hostServiceIp, port: 443, sandbox };
    assert.equal("hostname" in policy.decideConnect(service), false);
    policy.dnsPins.pin(sandbox, HOST_SERVICE_NAME, hostServiceIp, 60);
    assert.partialDeepStrictEqual(policy.decideConnect(service), {
      hostname: HOST_SERVICE_NAME,
      channel: "host-service",
    });
    assert.equal(
      "hostname" in policy.decideConnect({ ...service, sandbox: "sandbox-b" }),
      false,
    );
    assert.equal(
      policy.decideConnect({ ip: hostServiceIp, port: 8080, sandbox }).decision,
      "deny",
    );
    assert.partialDeepStrictEqual(
      policy.decideConnect({ ip: "203.0.113.10", port: 443, sandbox }),
      {
        channel: "host-service",
        upstream: { ip: "127.0.0.1", port: 8080 },
      },
    );
  });

  test("rejects invalid destinations, UDP, and alternate DNS ports", () => {
    const policy = new EgressPolicy({
      allow: [],
      allowIps: [{ ip: publicIp, port: 443 }],
    });
    const destination = { ip: publicIp, port: 443, sandbox };
    for (const port of [-1, 0, 53, 853, 443.5, 65536, NaN])
      assert.equal(
        policy.decideConnect({ ...destination, port }).reasonCode,
        "invalid-destination",
      );
    assert.equal(
      policy.decideConnect({ ...destination, ip: "api.example.test" })
        .reasonCode,
      "invalid-destination",
    );
    assert.equal(
      policy.decideConnect({ ...destination, protocol: "udp" }).reasonCode,
      "udp-refused",
    );
    assert.throws(
      () => new EgressPolicy({ allow: [{ hostname, port: 853 }] }),
      TypeError,
    );
  });

  test("refuses unsafe and ambiguous host service configuration", () => {
    const valid = {
      ip: hostServiceIp,
      hostname: HOST_SERVICE_NAME,
      port: 443,
      loopbackPort: 8080,
    };
    for (const invalid of [
      { ...valid, ip: "127.0.0.1" },
      { ...valid, ip: "64:ff9b::a9fe:a9fe" },
      { ...valid, ip: publicIp },
      { ...valid, hostname },
      { ...valid, loopbackPort: 0 },
      { ...valid, loopbackPort: 53 },
      { ...valid, loopbackPort: 853 },
    ])
      assert.throws(
        () => new EgressPolicy({ allow: [], hostServices: [invalid] }),
        TypeError,
      );
    assert.throws(
      () =>
        new EgressPolicy({
          allow: [],
          hostServices: [
            valid,
            { ...valid, ip: "::ffff:192.0.2.10", loopbackPort: 8081 },
          ],
        }),
      TypeError,
    );
    for (const name of [
      HOST_SERVICE_NAME,
      "host.microsandbox.internal",
      "*.example.test",
    ])
      assert.throws(
        () => new EgressPolicy({ allow: [{ hostname: name, port: 443 }] }),
        TypeError,
      );
  });

  test("hashes normalized, ordered rules and freezes independent copies", () => {
    const rule = { hostname: "API.EXAMPLE.TEST.", port: 443 };
    const explicit = { ip: "::ffff:93.184.215.14", port: 8443 };
    const service = {
      ip: hostServiceIp,
      hostname: HOST_SERVICE_NAME,
      port: 443,
      loopbackPort: 8080,
    };
    const policy = new EgressPolicy({
      providerBinding: rule,
      hostServices: [service],
      allow: [rule, { hostname: "other.example.test", port: 443 }, rule],
      allowIps: [explicit],
    });
    const equivalent = new EgressPolicy({
      allowIps: [{ port: 8443, ip: publicIp }],
      allow: [
        { port: 443, hostname: "other.example.test" },
        { port: 443, hostname },
      ],
      hostServices: [
        {
          loopbackPort: 8080,
          port: 443,
          hostname: HOST_SERVICE_NAME,
          ip: hostServiceIp,
        },
      ],
      providerBinding: { port: 443, hostname },
    });
    assert.match(policy.policyId, /^[a-f0-9]{64}$/);
    assert.equal(policy.policyId, equivalent.policyId);
    assert.notEqual(
      policy.policyId,
      new EgressPolicy({
        allow: policy.allow,
        allowIps: policy.allowIps,
        providerBinding: rule,
        hostServices: [{ ...service, loopbackPort: 8081 }],
      }).policyId,
    );
    rule.port = 80;
    explicit.port = 80;
    service.loopbackPort = 80;
    assert.equal(policy.providerBinding?.port, 443);
    assert.equal(policy.allow[0]?.port, 443);
    assert.equal(policy.allowIps[0]?.port, 8443);
    assert.equal(policy.hostServices[0]?.loopbackPort, 8080);
    for (const value of [
      policy,
      policy.providerBinding,
      policy.allow,
      policy.allowIps,
      policy.hostServices,
      ...policy.allow,
      ...policy.allowIps,
      ...policy.hostServices,
    ])
      assert.equal(Object.isFrozen(value), true);
  });
});
