import {
  configuredCredentialScanner,
  type CredentialScanner,
} from "./credential-scan.ts";
import { spawnSync } from "node:child_process";
import { createWriteStream, constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { exportAudit, exportAuditChecked } from "../audit-export.ts";
import { MISE_DUCKDB as miseArgs, offlineMiseEnv } from "../mise-tools.ts";
import { checkPrivateDirectory } from "../private-journal.ts";
import { exportOrchestrator, exportOrchestratorChecked } from "./export.ts";
import {
  checkDirectory,
  discoverAnalysisTargets,
  prepareTargetDirectory,
  type resolveTarget,
} from "./target.ts";

export type AnalysisCommand =
  | { kind: "analyze"; out?: string; sql?: string; audit?: string }
  | { kind: "denials"; since?: string; limit?: number };

const terminalControls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export function escapeTerminalControls(text: string): string {
  return text.replace(terminalControls, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

export function runDuckDb(args: readonly string[], input?: string) {
  return spawnSync("mise", [...miseArgs, ...args], {
    env: offlineMiseEnv(process.env),
    input,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await checkPrivateDirectory(path);
}

async function outputDirectory(path: string): Promise<string> {
  // Resolve existing parents (including the macOS /tmp alias) without creating
  // any intervening directories through an unchecked path.
  const existing = await realpath(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (existing !== undefined) {
    await checkDirectory(existing);
    return existing;
  }
  const parent = await outputDirectory(dirname(path));
  const canonical = join(parent, basename(path));
  await privateDirectory(canonical);
  return canonical;
}

async function isDatabase(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!stat) return false;
  if (!stat.isFile()) throw new Error("Unsafe analysis database");
  return true;
}

async function copyTelemetry(
  source: string,
  destination: string,
  scan?: CredentialScanner,
) {
  await privateDirectory(destination);
  for (const signal of ["traces", "metrics", "logs"]) {
    const from = join(source, signal);
    const to = join(destination, signal);
    await privateDirectory(to);
    const names = await checkDirectory(from)
      .then(() => readdir(from))
      .catch((error: unknown) => {
        if (missing(error)) return [];
        throw error;
      });
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/.test(name)) continue;
      const file = await open(
        join(from, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const temporary = join(to, `.copy-${randomUUID()}.partial`);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Unsafe telemetry rotation");
        if (scan && stat.size > 16 * 1024 * 1024)
          throw new Error("Telemetry rotation exceeds scan limits");
        await pipeline(
          file.createReadStream({ autoClose: false }),
          createWriteStream(temporary, {
            flags: "wx",
            mode: 0o600,
          }),
        );
        if (scan) await scan(await readFile(temporary));
        await rename(temporary, join(to, name));
      } finally {
        await file.close();
        await rm(temporary, { force: true });
      }
    }
  }
}

const sqlLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const shellLiteral = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'";
const sqlDirectory = new URL("../../observability/duckdb/", import.meta.url);

const summaries = `
SELECT target, actor, mode, runs, succeeded, failed, round(success_rate, 3) AS success_rate,
       round(p50_duration_ms, 1) AS p50_ms, round(p95_duration_ms, 1) AS p95_ms,
       round(total_cost_usd, 6) AS cost_usd, total_budget_tokens AS budget_tokens, failures_by_code
FROM actor_summary ORDER BY target, actor, mode LIMIT 40;
SELECT target, goal_id, status, tasks, succeeded, failed, approval_to_last_integration_ms AS wall_ms,
       round(total_cost_usd, 6) AS cost_usd, total_budget_tokens AS budget_tokens
FROM goal_summary ORDER BY approved_at DESC, target, goal_id LIMIT 40;
SELECT target, proposal_id, gate, policy, answerer_kind, decision, duration_ms
FROM gate_latency ORDER BY decided_at DESC, target, proposal_id LIMIT 40;
`;

function denialReport(since: string | undefined, limit: number | undefined) {
  const cutoff =
    since === undefined ? undefined : `TIMESTAMPTZ ${sqlLiteral(since)}`;
  const summary = cutoff ? `count_denials(${cutoff})` : "denial_summary";
  const latest =
    limit === undefined
      ? ""
      : `SELECT * FROM denials
${cutoff ? `WHERE recorded_at >= ${cutoff}` : ""}
ORDER BY recorded_at DESC NULLS LAST, target, execution_id, kind, hostname, destination, reason_code
LIMIT ${limit};\n`;
  return `SELECT * FROM ${summary} ORDER BY target, kind, hostname, reason_code;\n${latest}`;
}

export async function analyze(
  target: Awaited<ReturnType<typeof resolveTarget>>,
  allTargets: boolean,
  options: AnalysisCommand,
  io: {
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
  },
): Promise<0 | 1> {
  const snapshot =
    options.kind === "analyze" && options.audit !== undefined
      ? resolve(options.audit)
      : undefined;
  if (snapshot !== undefined && !(await isDatabase(snapshot)))
    throw new Error("Analysis audit snapshot is missing");
  const targets = allTargets ? await discoverAnalysisTargets(target) : [target];
  const out =
    options.kind === "analyze" && options.out
      ? await outputDirectory(resolve(options.out))
      : await mkdtemp(
          join(
            await prepareTargetDirectory(
              target.bootstrapRoot,
              join(
                target.bootstrapRoot,
                ".local",
                "local-orchestrator",
                "analysis",
              ),
            ),
            `${new Date().toISOString().replace(/[:.]/g, "-")}-`,
          ),
        );
  await checkPrivateDirectory(out);
  if (/[*?[\]\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(out))
    throw new Error("Invalid DuckDB analysis directory");

  const scans: CredentialScanner[] = [];
  for (const { slug, directory } of targets) {
    await checkDirectory(directory).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
    const scan = configuredCredentialScanner(directory, (message) =>
      io.stderr.write(message + "\n"),
    );
    if (scan) scans.push(scan);
    const destination = join(out, slug);
    await privateDirectory(destination);
    const audit = snapshot ?? join(directory, "audit.sqlite");
    const state = join(directory, "state.db");
    await privateDirectory(join(destination, "audit"));
    // Open the source read-only. Live databases keep their SQLite WAL sidecars.
    if (snapshot !== undefined || (await isDatabase(audit))) {
      if (scan) await exportAuditChecked(audit, destination, scan);
      else exportAudit(audit, destination);
    }
    if (await isDatabase(state)) {
      if (scan) await exportOrchestratorChecked(state, destination, scan);
      else exportOrchestrator(state, destination);
    }
    await copyTelemetry(
      join(directory, "observability", "telemetry"),
      join(destination, "telemetry"),
      scan,
    );
  }

  const [views, orchestrator] = await Promise.all(
    ["views.sql", "orchestrator.sql"].map((name) =>
      readFile(new URL(name, sqlDirectory), "utf8"),
    ),
  );
  const loader = `SET VARIABLE obs_dir = ${sqlLiteral(out)};
SET VARIABLE obs_targets = [${targets.map(({ slug }) => sqlLiteral(slug)).join(", ")}];
${views}
${orchestrator}
`;
  const loaderPath = join(out, "load.sql");
  const temporary = join(out, `.load-${randomUUID()}.partial`);
  try {
    await writeFile(temporary, loader, { flag: "wx", mode: 0o600 });
    await rename(temporary, loaderPath);
  } finally {
    await rm(temporary, { force: true });
  }
  const report =
    options.kind === "denials"
      ? denialReport(options.since, options.limit)
      : summaries;
  const printExport = () => {
    const query =
      options.kind === "denials"
        ? report.trim().replaceAll("\n", " ")
        : "SELECT * FROM actor_summary LIMIT 40;";
    const manual = `env MISE_OFFLINE=1 MISE_NOT_FOUND_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false mise ${miseArgs.join(" ")} :memory: -f ${shellLiteral(loaderPath)} -c ${shellLiteral(query)}`;
    io.stdout.write(
      `Analysis export ${escapeTerminalControls(JSON.stringify(out))}\nAd-hoc queries\n${manual}\n`,
    );
  };
  if (runDuckDb(["-version"]).status !== 0) {
    printExport();
    io.stderr.write(
      "Pinned DuckDB 1.5.6 is unavailable. The export is ready for the manual command.\n",
    );
    if (options.kind === "analyze" && options.sql)
      io.stderr.write("The extra SQL was not run.\n");
    return options.kind === "denials" ? 1 : 0;
  }

  let extra = "";
  if (options.kind === "analyze" && options.sql) {
    try {
      extra = await readFile(resolve(options.sql), "utf8");
    } catch {
      printExport();
      io.stderr.write(
        "Could not read the operator SQL file. The export is ready.\n",
      );
      return 1;
    }
  }
  const result = runDuckDb(
    ["-bail", "-box", ":memory:"],
    loader +
      "SELECT * FROM input_issues ORDER BY stream, filename, issue;\n" +
      report +
      extra +
      "\n",
  );
  if (result.stdout) {
    for (const scan of scans) await scan(result.stdout);
    io.stdout.write(
      result.stdout.split("\n").map(escapeTerminalControls).join("\n"),
    );
  }
  printExport();
  if (result.status !== 0) {
    io.stderr.write("DuckDB analysis query failed.\n");
    if (result.stderr) {
      for (const scan of scans) await scan(result.stderr);
      io.stderr.write(
        result.stderr.split("\n").map(escapeTerminalControls).join("\n"),
      );
    }
    return 1;
  }
  return 0;
}
