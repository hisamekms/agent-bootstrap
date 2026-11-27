import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SqliteAudit, type AuditInput } from "./audit.ts";
import { EgressGateway, type EgressGatewayOptions } from "./egress-gateway.ts";
import { EgressPolicy, gatewayPolicyDigest } from "./egress-policy.ts";
import { buildEgress } from "./image-recipes.ts";
import { digestNetworkArgs, networkArgs } from "./microsandbox.ts";
import { userStateDirectory } from "./local-orchestrator/claude-config.ts";
import { privateDirectory } from "./volumes/volume.ts";
import type { ProfileName } from "./sandbox-profiles.ts";
import type { HostGateway } from "./trusted-host.ts";

export function buildSandboxPlan(profile: string, env: NodeJS.ProcessEnv) {
  return {
    egress: "gateway",
    allow: buildEgress(profile),
    auditPath: join(userStateDirectory(env), "builds", "audit.sqlite"),
  };
}

type Run = (
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<string>;

export async function withBuildSandbox<T>({
  profile,
  image,
  digest,
  memoryMiB,
  cpus,
  packageDir,
  smoke = false,
  env,
  run,
  use,
  openGateway = EgressGateway.open,
  provisioner,
}: {
  profile: ProfileName;
  image: string;
  digest: string;
  memoryMiB: number;
  cpus: number;
  packageDir?: string;
  smoke?: boolean;
  env: NodeJS.ProcessEnv;
  run: Run;
  use: (name: string, run: Run) => Promise<T>;
  openGateway?: (options: EgressGatewayOptions) => Promise<HostGateway>;
  provisioner?: {
    readonly audit: SqliteAudit;
    readonly invocationId: string;
    readonly policy: EgressPolicy;
    readonly inputDirectory: string;
    readonly limits?: EgressGatewayOptions["limits"];
  };
}): Promise<T> {
  if (provisioner && (profile !== "bun" || smoke || packageDir !== undefined))
    throw new Error("Invalid Provisioner sandbox");
  const plan = provisioner ? undefined : buildSandboxPlan(profile, env);
  if (plan) {
    privateDirectory(userStateDirectory(env));
    privateDirectory(join(userStateDirectory(env), "builds"));
  }
  const policy =
    provisioner?.policy ??
    new EgressPolicy({ allow: smoke ? [] : plan!.allow });
  const audit = provisioner?.audit ?? new SqliteAudit(plan!.auditPath);
  const invocationId = provisioner?.invocationId ?? randomUUID();
  const sandboxId = `bootstrap-${randomUUID()}`;
  const write = (event: Omit<AuditInput, "invocationId">) =>
    audit.append({
      ...event,
      invocationId,
      role: provisioner ? "Provisioner" : "Verification",
    });
  const authorize = (operation: "sandbox.create" | "sandbox.destroy") => {
    write({
      kind: "operation.requested",
      operation,
      ...(operation === "sandbox.create" ? { profile, image: digest } : {}),
    });
    write({ kind: "operation.allowed", operation });
  };
  let gateway: HostGateway | undefined;
  let created = false;
  let outcome: "ok" | "failed" = "failed";
  const abort = new AbortController();
  // Smoke tests run with no network at all, like task VMs: a gateway with an
  // empty allowlist would quarantine on a browser's startup lookups.
  const gatewayDown = () => !smoke && gateway?.quarantined !== false;
  const ensureAudit = () => {
    if (!audit.isV5Writable || gatewayDown())
      throw new Error("Image build gateway or audit unavailable");
  };

  const remove = async () => {
    try {
      await run(["rm", "--force", sandboxId], 60_000);
    } catch (error) {
      write({
        kind: "operation.finished",
        operation: "sandbox.destroy",
        outcome: "failed",
      });
      throw error;
    }
  };

  const destroy = async () => {
    try {
      authorize("sandbox.destroy");
    } finally {
      // Emergency teardown remains necessary after a failed audit write.
      await remove();
    }
    write({
      kind: "operation.finished",
      operation: "sandbox.destroy",
      outcome: "ok",
    });
  };

  const finish = async () => {
    try {
      if (created) await destroy();
    } finally {
      await gateway?.close();
    }
  };

  try {
    write({ kind: "invocation.started" });
    audit.appendExecutionContext({
      executionId: invocationId,
      attributes: {
        purpose: provisioner
          ? "environment"
          : smoke
            ? "image-smoke"
            : "image-build",
      },
    });
    if (!smoke)
      gateway = await openGateway({
        executionId: invocationId,
        sandboxLabel: sandboxId,
        policy,
        audit,
        ...(provisioner?.limits && { limits: provisioner.limits }),
      });
    ensureAudit();
    const passwordEnv = "AGENT_GATEWAY_BUILD_SECRET";
    const args = networkArgs(
      gateway && {
        socksPort: gateway.socksPort,
        dnsPort: gateway.dnsPort,
        username: gateway.username,
        passwordEnv,
      },
    );
    authorize("sandbox.create");
    audit.appendSandboxBinding({
      invocationId,
      sandboxId,
      runtimeKind: "microsandbox",
      netRuleDigest: digestNetworkArgs(args),
      ...(gateway
        ? {
            egressMode: "gateway",
            gatewayPolicyId: policy.policyId,
            gatewayPolicyDigest: gatewayPolicyDigest(policy),
          }
        : { egressMode: "none" }),
    });
    const timer = setInterval(() => {
      if (!audit.isV5Writable || gatewayDown()) abort.abort();
    }, 25);
    try {
      ensureAudit();
      const password = gateway?.password;
      if (gateway && !/^[\x21-\x7e]{1,255}$/.test(password ?? ""))
        throw new Error("Image build gateway credential unavailable");
      ensureAudit();
      created = true; // A failing backend may still have created the VM.
      try {
        await run(
          [
            "create",
            "--name",
            sandboxId,
            "--label",
            `agent-bootstrap-invocation=${invocationId}`,
            "--pull",
            "never",
            ...args,
            "--memory",
            `${memoryMiB}M`,
            "--cpus",
            String(cpus),
            "--max-duration",
            "900s",
            ...(provisioner
              ? [
                  "--copy-dir",
                  `${provisioner.inputDirectory}:/tmp/environment-input`,
                ]
              : []),
            ...(packageDir ? ["--copy-dir", `${packageDir}:/tmp/pkgs`] : []),
            image,
          ],
          300_000,
          password === undefined ? {} : { [passwordEnv]: password },
          abort.signal,
        );
      } catch (error) {
        write({
          kind: "operation.finished",
          operation: "sandbox.create",
          outcome: "failed",
        });
        throw error;
      }
      ensureAudit();
      write({
        kind: "operation.finished",
        operation: "sandbox.create",
        outcome: "ok",
      });
      const result = await use(sandboxId, async (args, timeout) => {
        ensureAudit();
        const output = await run(args, timeout, undefined, abort.signal);
        ensureAudit();
        return output;
      });
      ensureAudit();
      outcome = "ok";
      return result;
    } finally {
      clearInterval(timer);
    }
  } finally {
    try {
      await finish().catch((error: unknown) => {
        outcome = "failed";
        throw error;
      });
    } finally {
      try {
        write({ kind: "invocation.finished", outcome });
      } finally {
        if (!provisioner) audit.close();
      }
    }
  }
}
