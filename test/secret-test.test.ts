import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecutionAudit } from "../src/audit.ts";
import {
  CLAUDE_BWRAP_OK,
  CLAUDE_CODE,
  CLAUDE_WORKER_USAGE_MARKER,
  SECRET_PROBE_HASH,
} from "../src/claude-code.ts";
import { evaluateSecretTest } from "../src/local-orchestrator/secret-test.ts";
import {
  hasSecretTestPass,
  recordSecretTestPass,
} from "../src/local-orchestrator/secret-test-record.ts";
import { SECRET_TOOL_DIRS, SECRET_FILE_PORT } from "../src/secret-file.ts";

const variable = "TOOL_TOKEN";
const nonce = "fixture-nonce";

test("secret self-test records match the variable, pinned CLI version and containment", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "ab-secret-pass-")));
  const state = join(temp, "state");
  try {
    assert.equal(hasSecretTestPass(state, variable), false);
    recordSecretTestPass(state, variable, "1.0.0");
    assert.equal(hasSecretTestPass(state, variable), false);
    assert.equal(hasSecretTestPass(state, variable, "1.0.0"), true);
    recordSecretTestPass(state, variable);
    assert.equal(hasSecretTestPass(state, variable), true);
    assert.equal(hasSecretTestPass(state, "OTHER_TOKEN"), false);
    assert.equal(
      hasSecretTestPass(state, variable, undefined, "sha256:" + "f".repeat(64)),
      false,
    );

    const directory = join(state, "secret-tests", CLAUDE_CODE.version);
    const path = join(directory, `${variable}.json`);
    const pass = await readFile(path);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    assert.equal(hasSecretTestPass(state, variable), false);
    await rm(path);
    const otherPath = join(temp, "record.json");
    await writeFile(otherPath, pass, { mode: 0o600 });
    await symlink(otherPath, path);
    assert.equal(hasSecretTestPass(state, variable), false);
    await rm(path);
    await writeFile(
      path,
      JSON.stringify({ schema: 1, variable, version: CLAUDE_CODE.version }),
      { mode: 0o600 },
    );
    assert.equal(hasSecretTestPass(state, variable), false);
    assert.equal(hasSecretTestPass(state, variable, "../../../state"), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function fixture() {
  const identities = {
    invocationId: "worker",
    sandboxId: "guest",
    connectionId: "connection",
    recordedAt: "2026-11-24T00:00:00Z",
  };
  const audit: ExecutionAudit = {
    auditEvents: [
      {
        invocationId: identities.invocationId,
        recordedAt: identities.recordedAt,
        kind: "operation.allowed",
        operation: "sandbox.exec",
        sequence: 1,
        detail: { event: "secret.served", variable },
      },
      {
        invocationId: identities.invocationId,
        recordedAt: identities.recordedAt,
        kind: "operation.finished",
        operation: "sandbox.exec",
        sequence: 2,
        detail: {
          event: "secret.delivery",
          variable,
          delivery: "acknowledged",
        },
      },
    ],
    networkEvents: [
      {
        ...identities,
        sequence: 1,
        phase: "decided",
        protocol: "tcp",
        decision: "allow",
        policyId: "policy",
        reasonCode: "allowlisted-host",
        hostname: "api.anthropic.com",
        destinationIp: "192.0.2.6",
        destinationPort: 443,
        channel: "egress",
      },
      {
        ...identities,
        sequence: 2,
        phase: "finished",
        protocol: "tcp",
        result: "connected",
        endReason: "client-closed",
        bytesReceived: 100,
        bytesSent: 100,
        durationMs: 1,
      },
    ],
    executionContexts: [],
    sandboxBindings: [],
    processResults: [],
    resourceEvents: [],
  };
  const signals = [
    "uid=1000",
    "env_has_variable=no",
    "proc_entries=7",
    "proc_readable=5",
    "proc_environ_with_variable=0",
    "managed_settings_readable=no",
    "config_write_allowed=no",
    "git_status=yes",
    "git_post_checkout=yes",
    "git_pre_commit=yes",
    "git_pins=yes",
    "home_readable=no",
    "config_readable=no",
    "probe_tools_present=yes",
    `vsock_${SECRET_FILE_PORT}_bytes=0`,
    `vsock_${SECRET_FILE_PORT}_connected=no`,
    "vsock_5000_bytes=0",
    "vsock_5000_connected=no",
    "core_limit=0",
    "core_hard_limit=0",
    "tcp_model=no",
    "tcp_ip=no",
    "dns=no",
  ];
  const permission_denials = [
    { tool_name: "Read", tool_input: { file_path: "/workspace/probe-self" } },
    { tool_name: "Read", tool_input: { file_path: "/workspace/probe-init" } },
    {
      tool_name: "Grep",
      tool_input: { path: "/workspace/probe-proc/1/environ" },
    },
    {
      tool_name: "Glob",
      tool_input: { path: "/workspace/probe-secrets", pattern: "*" },
    },
    ...Object.values(SECRET_TOOL_DIRS).flatMap((path) => [
      {
        tool_name: "Read",
        tool_input: { file_path: path + "/.isolation-fixture" },
      },
      { tool_name: "Grep", tool_input: { path: path + "/.isolation-fixture" } },
      { tool_name: "Glob", tool_input: { path, pattern: "**" } },
    ]),
  ];
  const bytes = Buffer.from(signals.join("\n"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const stderr = Buffer.from(
    [
      CLAUDE_BWRAP_OK,
      "agent-proc claude 1000 yes 20",
      "agent-proc git 1000 no 2",
      "agent-proc bwrap 1000 no 10",
      "agent-proc sh 1000 no 10",
      "agent-crash-status=139",
      "agent-core-files=0",
      `${SECRET_PROBE_HASH} ${hash}`,
      CLAUDE_WORKER_USAGE_MARKER +
        JSON.stringify({ result: "All denied.", permission_denials }),
    ].join("\n"),
  );
  const files = new Map([
    [
      "probe.txt",
      {
        mode: "100644" as const,
        bytes,
      },
    ],
    [
      `.probe-${nonce}.sha256`,
      {
        mode: "100644" as const,
        bytes: Buffer.from(`probe_nonce=${nonce}\nsha256=${hash}\n`),
      },
    ],
  ]);
  return {
    variable,
    nonce,
    stderr,
    files,
    audit,
    auditScreened: true,
    runSucceeded: true,
  };
}

test("the secret self-test requires complete signals and recorded permission denials", () => {
  const input = fixture();
  assert.equal(evaluateSecretTest(input).pass, true);
  const missingDenial = Buffer.from(
    input.stderr
      .toString()
      .replace('"/workspace/probe-self"', '"/workspace/other"'),
  );
  const saidDenied = evaluateSecretTest({ ...input, stderr: missingDenial });
  assert.equal(saidDenied.pass, false);
  assert.equal(saidDenied.checks.fileTools, false);

  const noObserver = Buffer.from(
    input.stderr.toString().replace(/^agent-proc .*\n/gm, ""),
  );
  assert.equal(
    evaluateSecretTest({ ...input, stderr: noObserver }).checks.helpers,
    false,
  );
  assert.equal(
    evaluateSecretTest({ ...input, auditScreened: false }).pass,
    false,
  );
  assert.equal(
    evaluateSecretTest({ ...input, files: new Map() }).checks.scrub,
    false,
  );
  input.audit.auditEvents.pop();
  assert.equal(evaluateSecretTest(input).checks.delivery, false);
});

test("workspace probe output requires the current nonce, root hash and uid-1000 sandbox processes", () => {
  const input = fixture();
  const files = new Map(input.files);
  files.delete(`.probe-${nonce}.sha256`);
  assert.equal(evaluateSecretTest({ ...input, files }).pass, false);
  assert.equal(
    evaluateSecretTest({ ...input, nonce: "previous-run" }).pass,
    false,
  );

  for (const [before, after] of [
    ["agent-proc bwrap 1000", "agent-proc bwrap 0"],
    ["agent-proc sh 1000", "agent-proc sh 0"],
    [SECRET_PROBE_HASH, "ignored-hash"],
    [SECRET_PROBE_HASH + " ", SECRET_PROBE_HASH + " f"],
  ] as const) {
    const stderr = Buffer.from(input.stderr.toString().replace(before, after));
    assert.equal(evaluateSecretTest({ ...input, stderr }).pass, false);
  }
});
