import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemHost } from "../../src/onboarding/prerequisites.ts";
import {
  parseSandboxShell,
  runSandboxShell,
  sandboxShellPlan,
} from "../../src/onboarding/sandbox-shell.ts";
import { directoryMetadata } from "./claude-policy-smoke.ts";

const guest = `
test "$(id -u)" = 0
mount_path=$1
failed=0
deny() {
  name=$1; shift
  if "$@" >/dev/null 2>&1; then
    printf '%s allowed\n' "$name"
    failed=1
  else
    printf '%s denied\n' "$name"
  fi
}
deny overwrite sh -c 'printf test >> "$1/fixture"' probe "$mount_path"
deny create sh -c 'printf test > "$1/new"' probe "$mount_path"
deny chmod chmod 0777 "$mount_path"
mount -o remount,rw "$mount_path" >/dev/null 2>&1 || :
deny create-after-remount sh -c 'printf test > "$1/second"' probe "$mount_path"
source=$(awk -v path="$mount_path" '$2 == path { print $1 }' /proc/mounts)
kind=$(awk -v path="$mount_path" '$2 == path { print $3 }' /proc/mounts)
mkdir /tmp/ro-probe
if mount -t "$kind" -o rw "$source" /tmp/ro-probe >/dev/null 2>&1; then
  deny create-via-second-mount sh -c 'printf test > /tmp/ro-probe/third'
fi
exit "$failed"
`;

if (import.meta.main) {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== "--run" ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stderr.isTTY
  ) {
    console.error(
      "Run bun run spike/local-orchestrator/ro-probe.ts --run from an operator terminal.",
    );
    process.exitCode = 1;
  } else {
    const path = await mkdtemp(
      join(await realpath(tmpdir()), "volume-ro-probe-"),
    );
    try {
      await writeFile(join(path, "fixture"), "test", { mode: 0o600 });
      const before = await directoryMetadata(path);
      const options = parseSandboxShell([
        "shell",
        "--run",
        "--mount-dir",
        `${path}:/mnt/probe:ro`,
      ]);
      const plan = await sandboxShellPlan(
        resolve(import.meta.dirname, "../.."),
        systemHost.env,
        options,
      );
      const result = await runSandboxShell(systemHost, plan, {
        argv: ["/bin/sh", "-ec", guest, "ro-probe", "/mnt/probe"],
        workdir: "/",
      });
      const unchanged =
        JSON.stringify(before) ===
        JSON.stringify(await directoryMetadata(path));
      console.log(
        unchanged
          ? "Host entry metadata unchanged."
          : "Host entry metadata changed.",
      );
      if (!unchanged || result.outcome !== "ok") process.exitCode = 1;
    } catch {
      console.error("The read-only mount probe failed to complete.");
      process.exitCode = 1;
    } finally {
      await rm(path, { force: true, recursive: true });
    }
  }
}
