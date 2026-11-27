import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { AuditInput } from "../audit.ts";
import { EnvironmentError, type EnvironmentStep } from "./adapter.ts";
import {
  environmentArchiveLimit,
  validateEnvironmentArchive,
} from "./archive.ts";

const minute = 60_000;
const lockLimit = 16 * 1024 * 1024;
const outputDirectory = "/tmp/environment-result";
const guestHome = "/tmp/environment-home";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function execArgs(name: string, script: string, timeout: number) {
  return [
    "exec",
    "--no-stdin",
    "--no-tty",
    "--timeout",
    `${timeout / 1000}s`,
    name,
    "--",
    "/bin/sh",
    "-ec",
    script,
  ];
}

async function readOutput(path: string, limit: number) {
  if (!(await lstat(path)).isFile()) throw new EnvironmentError();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new EnvironmentError();
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || (await file.stat()).size !== bytes.length)
      throw new EnvironmentError();
    return bytes;
  } finally {
    await file.close();
  }
}

interface GuestOutput {
  archive?: Uint8Array;
  lock?: Uint8Array;
  outdated?: string;
}

export async function runProvisionerGuest(
  name: string,
  step: EnvironmentStep,
  roots: readonly string[],
  linkTargets: readonly string[],
  staging: string,
  write: (event: Omit<AuditInput, "invocationId" | "role">) => void,
  run: (args: string[], timeout: number) => Promise<string>,
  packagePhase: (active: boolean) => void,
): Promise<GuestOutput> {
  const result: GuestOutput = {};
  const response = join(staging, "outputs.tar");
  const responseLock = join(staging, "bun.lock");
  const audited = async (
    operation: "sandbox.exec" | "sandbox.collect",
    args: string[],
    timeout: number,
  ) => {
    write({ kind: "operation.requested", operation });
    write({ kind: "operation.allowed", operation });
    let outcome: "ok" | "failed" = "failed";
    try {
      const output = await run(args, timeout);
      outcome = "ok";
      return output;
    } finally {
      write({ kind: "operation.finished", operation, outcome });
    }
  };
  const outputs = roots.map(quote).join(" ");
  const setup = [
    "mkdir -m 0755 /tmp/environment-work",
    `mkdir -m 0700 ${outputDirectory} ${guestHome}`,
    `chown nobody ${guestHome}`,
    "chown root /tmp/environment-input /tmp/environment-input/tree.tar",
    "chmod 0500 /tmp/environment-input",
    "chmod 0400 /tmp/environment-input/tree.tar",
    "cd /tmp/environment-work",
    "tar -xf /tmp/environment-input/tree.tar",
    "chmod -R a-w .",
    ...(step.archive
      ? [
          `mkdir -p -- ${outputs}`,
          `chown nobody -- ${outputs}`,
          `chmod 0755 -- ${outputs}`,
        ]
      : []),
    ...(step.writesLock
      ? [
          "chmod 1777 .",
          "if [ -f bun.lock ]; then chown nobody bun.lock; chmod 0600 bun.lock; fi",
        ]
      : []),
  ].join("\n");
  await audited("sandbox.exec", execArgs(name, setup, minute), minute * 2);
  const command = step.argv.map(quote).join(" ");
  const asGuest = (script: string) => `cd /tmp/environment-work
exec su -s /bin/sh nobody -c ${quote(`export HOME=${guestHome}
${script}`)}`;
  // Open the response as root in a private directory and set a hard
  // file-size limit before dropping privileges for the producer.
  const capture = (script: string, file: string, limit: number) =>
    `umask 077
ulimit -f ${limit / 512}
${asGuest(script)} > ${outputDirectory}/${file}`;
  packagePhase(true);
  try {
    const commandOutput = await audited(
      "sandbox.exec",
      execArgs(name, asGuest(`exec ${command}`), 10 * minute),
      11 * minute,
    );
    if (step.reportsOutdated) result.outdated = commandOutput;
  } finally {
    packagePhase(false);
  }
  if (step.archive) {
    await audited(
      "sandbox.exec",
      execArgs(
        name,
        capture(
          `tar -cf - -- ${outputs}`,
          "outputs.tar",
          environmentArchiveLimit,
        ),
        minute,
      ),
      minute * 2,
    );
    await audited(
      "sandbox.collect",
      ["copy", `${name}:${outputDirectory}/outputs.tar`, response],
      minute,
    );
    result.archive = validateEnvironmentArchive(
      await readOutput(response, environmentArchiveLimit),
      roots,
      environmentArchiveLimit,
      linkTargets,
    );
  }
  if (step.writesLock) {
    await audited(
      "sandbox.exec",
      execArgs(
        name,
        capture(
          `if [ -L bun.lock ]; then exit 1; fi
if [ -f bun.lock ]; then cat bun.lock; fi`,
          "bun.lock",
          lockLimit,
        ),
        minute,
      ),
      minute * 2,
    );
    await audited(
      "sandbox.collect",
      ["copy", `${name}:${outputDirectory}/bun.lock`, responseLock],
      minute,
    );
    result.lock = await readOutput(responseLock, lockLimit);
  }
  return result;
}
