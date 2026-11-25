import {
  configRoot,
  projectConfigDirectory,
  loadConfig,
  projectName,
  hasEditableConfig,
  readLayer,
  userConfigPath,
  writePrivateConfig,
} from "../config/layers.ts";
import { ConfigError, invalid } from "../config/messages.ts";
import { MsbHomeError, requireMsbHome } from "../config/msb-home.ts";
import { migrate } from "../config/migrate.ts";
import {
  addProject,
  approveProject,
  escapedJson,
  listProjects,
  moveProject,
  projectMissing,
  removeProject,
  requireProject,
} from "../config/projects.ts";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type CliIo } from "../local-orchestrator/cli.ts";
import { runSecretTest } from "../local-orchestrator/secret-test.ts";
import { isSafeCredentialVariable } from "../sandbox-runtime.ts";
import {
  ClaudeConfigError,
  parseClaudeAuthMode,
  userStateDirectory,
  type ClaudeAuthMode,
} from "../local-orchestrator/claude-config.ts";
import {
  ClaudeRunError,
  claudeNext,
} from "../local-orchestrator/claude-errors.ts";
import { VolumeError, Volume } from "../volumes/volume.ts";
import { resolveTarget } from "../local-orchestrator/target.ts";
import { parseConciergeArgs } from "../local-orchestrator/concierge.ts";
import { parseWorkplaceArgs } from "../local-orchestrator/workplace.ts";
import {
  exitCodes,
  helpTopics,
  onboardingOutputs,
  operatorOutputs,
  renderAgentGuide,
  renderHelpTopic,
  type HelpTopic,
} from "./help.ts";
import { doctor, systemHost, type Host } from "./prerequisites.ts";
import {
  parseSandboxShell,
  runSandboxShell,
  sandboxShellPlan,
} from "./sandbox-shell.ts";
import {
  applySetup,
  authorizedAgentWarning,
  SetupError,
  setupPlan,
} from "./setup.ts";

type Exit = keyof typeof exitCodes;

export interface BootstrapIo extends CliIo {
  conciergeTTY: boolean;
  approvalTTY?: boolean;
  confirmProject?(question: string): Promise<string | undefined>;
  launch?(root: string, args: string[], json: boolean): Promise<boolean>;
  launchWorkplace?(root: string, args: string[]): Promise<number>;
}

function launchSession(
  root: string,
  args: string[],
  json: boolean,
  forwardSignals = false,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--no-env-file",
        join(root, "spike/local-orchestrator/concierge.ts"),
        ...args,
      ],
      {
        stdio: forwardSignals
          ? ["inherit", "inherit", "inherit", "pipe"]
          : json
            ? [0, 2, 2]
            : "inherit",
        // The launcher stops when this lifeline closes, so it cannot outlive
        // this CLI even after SIGKILL.
        ...(forwardSignals && {
          env: { ...process.env, AGENT_BOOTSTRAP_LIFELINE_FD: "3" },
        }),
        // Route terminal signals through this CLI without interrupting the
        // launcher's backend cleanup subprocesses in the same process group.
        ...(forwardSignals ? { detached: true } : {}),
      },
    );
    // The launcher stops cleanly on the first signal and exits at once on
    // the second. A third one kills it, in case it no longer responds.
    let forwarded = 0;
    const forward = (signal: NodeJS.Signals) =>
      child.kill(++forwarded > 2 ? "SIGKILL" : signal);
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    if (forwardSignals) {
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      process.on("SIGHUP", terminate);
    }
    child.once("error", () => resolve(1));
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", terminate);
      resolve(
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
      );
    });
  });
}

async function launch(root: string, args: string[], json: boolean) {
  return (await launchSession(root, ["--run", ...args], json)) === 0;
}

function launchWorkplace(root: string, args: string[]) {
  return launchSession(root, ["workplace", ...args], false, true);
}

function includeJson(argv: readonly string[]) {
  const delimiter = argv.indexOf("--");
  const options = delimiter === -1 ? argv : argv.slice(0, delimiter);
  const json = options.includes("--json");
  return {
    json,
    args: [
      ...options.filter((arg) => arg !== "--json"),
      ...(delimiter === -1 ? [] : argv.slice(delimiter)),
    ],
  };
}

function claudeOptions(args: readonly string[]) {
  let target: string | undefined;
  let override: ClaudeAuthMode | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--target") {
      const path = args[++index];
      if (
        target !== undefined ||
        !path ||
        path.startsWith("--") ||
        path.includes("\0")
      )
        throw new Error("usage");
      target = path;
    } else if (arg === "--claude-auth") {
      if (override !== undefined) throw new Error("usage");
      override = parseClaudeAuthMode(args[++index]);
    } else remaining.push(arg);
  }
  return { target, override, remaining };
}

export async function runBootstrap(
  argv: readonly string[],
  root: string,
  io: BootstrapIo,
  host: Host = systemHost,
): Promise<number> {
  const { args, json } = includeJson(argv);
  const print = (value: unknown) => io.stdout.write(`${escapedJson(value)}\n`);
  const hint = (next: string) => io.stderr.write(`next: ${next}\n`);
  const fail = (code: Exclude<Exit, 0>, error: string, next: string) => {
    if (json) print({ error, next });
    else {
      io.stderr.write(`${error}\n`);
      hint(next);
    }
    return code;
  };
  const usage = () =>
    fail(
      2,
      "Invalid agent-bootstrap command or arguments.",
      "Run agent-bootstrap help --json for allowed commands and flags.",
    );

  const globalAuth = args[0] === "--claude-auth" ? args.splice(0, 2) : [];
  const leadingWorkplaceTarget =
    args[0] === "--target" && args[2] === "workplace" ? args.splice(0, 2) : [];
  const [command = "help", ...commandArgs] = args;
  const rest = [...commandArgs, ...globalAuth, ...leadingWorkplaceTarget];
  if (
    globalAuth.length &&
    !["doctor", "concierge", "workplace"].includes(command)
  )
    return usage();
  try {
    if (command === "help" || command === "--help" || command === "-h") {
      const [topic, ...extra] = rest;
      if (
        extra.length ||
        (topic && topic !== "--agent" && !Object.hasOwn(helpTopics, topic)) ||
        (topic === "--agent" && json)
      )
        return usage();
      if (json)
        print({
          topics: topic
            ? { [topic]: helpTopics[topic as HelpTopic] }
            : helpTopics,
          commands: { ...onboardingOutputs, ...operatorOutputs },
          exitCodes,
        });
      else if (topic === "--agent") io.stdout.write(renderAgentGuide());
      else if (topic) io.stdout.write(renderHelpTopic(topic as HelpTopic));
      else
        io.stdout.write(
          `agent-bootstrap — Audited, sandboxed coding agents\n\nagent-bootstrap help <topic>\nTopics: ${Object.keys(helpTopics).join(", ")}\n\nRun agent-bootstrap help --agent for the full manual or agent-bootstrap help --json for the command schema.\nnext: agent-bootstrap help start\n`,
        );
      return 0;
    }

    if (command === "secrets") {
      let options: ReturnType<typeof claudeOptions>;
      try {
        options = claudeOptions(rest);
      } catch {
        return usage();
      }
      const { target, override, remaining } = options;
      const [action, variable, ...extra] = remaining;
      if (
        action !== "test" ||
        !isSafeCredentialVariable(variable) ||
        override !== undefined ||
        extra.length
      )
        return usage();
      try {
        const report = await runSecretTest(root, host, variable, target);
        print(report);
        if (!report.pass)
          hint(
            "Review the failed checks and run agent-bootstrap help secrets.",
          );
        return report.pass ? 0 : 1;
      } catch (error) {
        if (
          error instanceof ConfigError ||
          error instanceof ClaudeConfigError ||
          error instanceof MsbHomeError
        )
          throw error;
        return fail(
          1,
          "The secret self-test stopped before a complete report was available.",
          "Check the pinned VM prerequisites and the configured Keychain item, then retry.",
        );
      }
    }

    if (command === "project") {
      const [action, name, option, value, ...extra] = rest;
      const arg = (value: string | undefined): value is string =>
        !!value && !value.startsWith("-") && !value.includes("\0");
      if (
        action === "add" &&
        arg(name) &&
        !extra.length &&
        (option === undefined || (option === "--name" && arg(value)))
      ) {
        print(addProject(name, value, host.env));
      } else if (action === "list" && rest.length === 1) {
        print(
          listProjects(host.env).map((project) => ({
            ...project,
            missing: projectMissing(project),
          })),
        );
      } else if (action === "show" && arg(name) && rest.length === 2) {
        const project = requireProject(name, host.env);
        print({ ...project, missing: projectMissing(project) });
      } else if (
        action === "move" &&
        arg(name) &&
        arg(option) &&
        rest.length === 3
      ) {
        print(moveProject(name, option, host.env));
      } else if (action === "remove" && arg(name) && rest.length === 2) {
        removeProject(name, host.env);
        print({ removed: true });
      } else if (action === "approve" && arg(name) && rest.length === 2) {
        await approveProject(name, host.env, {
          isTTY: io.approvalTTY ?? io.isTTY,
          write: (text) => (json ? io.stderr : io.stdout).write(text),
          confirm: async (question) =>
            io.confirmProject?.(question) ?? io.prompt(question),
        });
        print({ approved: true });
      } else return usage();
      return 0;
    }

    if (command === "config") {
      if (
        rest[0] !== "edit" ||
        (rest.length !== 1 &&
          (rest.length !== 3 || rest[1] !== "--project" || !rest[2]))
      )
        return usage();
      const editor = host.env.EDITOR;
      if (!editor)
        invalid(
          "editor",
          "Set EDITOR to choose a configuration editor.",
          "Set EDITOR and run agent-bootstrap config edit.",
        );
      const name = rest[2];
      if (name) requireProject(name, host.env);
      const directory = name
        ? projectConfigDirectory(name, host.env)
        : undefined;
      const path = directory
        ? join(directory, "local.json")
        : userConfigPath(host.env);
      const layer = directory ? "local" : "user";
      // Permit editing invalid JSON while preserving the file safety checks.
      if (!hasEditableConfig(path, configRoot(host.env), layer))
        writePrivateConfig(path, configRoot(host.env), { version: 1 }, true);
      const result = spawnSync(
        "/bin/sh",
        ["-c", editor + ' "$1"', "editor", path],
        { stdio: "inherit", env: host.env },
      );
      if (result.status !== 0)
        invalid(
          "editor",
          "The editor did not complete successfully.",
          "Check EDITOR and retry.",
        );
      readLayer(layer, directory, host.env, true);
      if (json) print({ edited: true });
      return 0;
    }

    if (command === "migrate") {
      if (
        rest.some(
          (path) => !path || path.startsWith("-") || path.includes("\0"),
        )
      )
        return usage();
      print(migrate(root, rest, host.env));
      return 0;
    }

    if (command === "doctor") {
      let path: string | undefined;
      let override: ClaudeAuthMode | undefined;
      try {
        const options = claudeOptions(rest);
        if (options.remaining.length) return usage();
        ({ target: path, override } = options);
      } catch {
        return usage();
      }
      const { checks, first } = await doctor(root, host, path, false, override);
      const next = first
        ? first.fix.join(" && ") || first.detail
        : path === undefined
          ? "Run agent-bootstrap doctor --target <path> or agent-bootstrap concierge."
          : "Run agent-bootstrap concierge --target <path> with the same target.";
      if (json) print(checks);
      else {
        const width = Math.max(...checks.map(({ id }) => id.length));
        io.stdout.write(`${"CHECK".padEnd(width)}  STATUS   DETAIL\n`);
        for (const { id, status, detail, fix, effective } of checks) {
          io.stdout.write(
            `${id.padEnd(width)}  ${status.padEnd(7)}  ${detail}${fix.length ? ` next: ${fix.join(" && ")}` : ""}\n`,
          );
          if (effective) io.stdout.write(escapedJson(effective) + "\n");
        }
      }
      hint(next);
      return first ? 3 : 0;
    }

    if (command === "sandbox") {
      let options: ReturnType<typeof parseSandboxShell>;
      try {
        options = parseSandboxShell(rest);
        if (json && options.run) return usage();
      } catch {
        return usage();
      }
      if (options.run && !io.conciergeTTY)
        return fail(
          1,
          "Sandbox shell requires an operator terminal.",
          "Run agent-bootstrap sandbox shell --run from a TTY.",
        );
      try {
        const prepared = await sandboxShellPlan(root, host.env, options);
        print(prepared.plan);
        if (options.run) {
          const { id, outcome } = await runSandboxShell(host, prepared);
          print({ id, outcome });
          if (outcome !== "ok")
            return fail(
              1,
              "Sandbox shell did not complete successfully.",
              "Check the invocation in the audit database shown above.",
            );
        }
        return 0;
      } catch (error) {
        if (error instanceof ConfigError || error instanceof MsbHomeError)
          throw error;
        return fail(
          1,
          "Sandbox shell could not be prepared or run.",
          "Check the profile, Microsandbox home, mount directories and audit path. See agent-bootstrap help troubleshoot.",
        );
      }
    }

    if (command === "setup") {
      const options = (() => {
        try {
          return claudeOptions(rest);
        } catch {
          return undefined;
        }
      })();
      if (
        !options ||
        options.override !== undefined ||
        options.remaining.length !== new Set(options.remaining).size ||
        options.remaining.some(
          (arg) => !["--allow-network", "--yes", "--profiles"].includes(arg),
        )
      )
        return usage();
      const allowNetwork = rest.includes("--allow-network");
      const yes = rest.includes("--yes");
      if (yes) io.stderr.write(`${authorizedAgentWarning}\n`);
      const plan = await setupPlan(
        root,
        rest.includes("--profiles"),
        host.env,
        options.target,
      ).catch((error: unknown) => {
        if (error instanceof ConfigError) throw error;
        throw new SetupError(
          "The setup plan could not load the required profile lock.",
          "Restore the checked-in lock and matching recipes.",
          3,
        );
      });
      if (allowNetwork && !yes) {
        if (!io.isTTY)
          return fail(
            1,
            "Setup requires a terminal confirmation or explicit --yes.",
            "Review agent-bootstrap setup --json and obtain operator authorization.",
          );
        io.stderr.write(`${JSON.stringify(plan, null, 2)}\n`);
        if (
          (await io.prompt(
            'Type "setup" to authorize network access and sequential VM image builds: ',
          )) !== "setup"
        )
          return fail(
            1,
            "Setup confirmation did not match.",
            "Review the plan and rerun agent-bootstrap setup --allow-network when ready.",
          );
      }
      if (!allowNetwork) {
        const next = `Review the plan, then run agent-bootstrap setup --allow-network${rest.includes("--profiles") ? " --profiles" : ""}${options.target ? " with the same target" : ""} when authorized.`;
        print({ mode: "plan", ...plan, next });
        if (!json) hint(next);
        return 0;
      }
      const result = await applySetup(root, host, plan, allowNetwork);
      const next =
        "Provision the Keychain item from an operator terminal if needed, then run agent-bootstrap doctor.";
      print({ mode: "applied", ...plan, result, next });
      if (!json) hint(next);
      return 0;
    }

    if (command === "volume") {
      let options: ReturnType<typeof claudeOptions>;
      try {
        options = claudeOptions(rest);
      } catch {
        return usage();
      }
      const { target: path, override, remaining } = options;
      const [action, name, ...extra] = remaining;
      if (
        override ||
        !name ||
        !projectName.test(name) ||
        !["status", "attach", "detach", "init", "shell"].includes(
          action ?? "",
        ) ||
        (action !== "shell" && path !== undefined) ||
        (extra.length &&
          !(
            action === "detach" &&
            extra.length === 1 &&
            extra[0] === "--force"
          ))
      )
        return usage();
      if (action === "shell") {
        if (json) return usage();
        if (!io.conciergeTTY)
          return fail(
            1,
            "An operator terminal is required.",
            "Run agent-bootstrap volume shell from a TTY.",
          );
        const target = await resolveTarget(path, root, host.env);
        const { config, user } = loadConfig(host.env, target.configDirectory);
        if (!Object.hasOwn(config.mounts ?? {}, name))
          invalid(
            "mounts",
            "The selected mount is undefined.",
            "Select a mount from the effective configuration.",
          );
        await requireMsbHome(host.env, user);
        const launchArgs = ["--volume-shell", name];
        if (path) launchArgs.push("--target", path);
        if (!(await (io.launch ?? launch)(root, launchArgs, false)))
          return fail(
            1,
            "Volume shell failed.",
            "Review the terminal output and run agent-bootstrap doctor.",
          );
        print({ status: "ok" });
        return 0;
      }
      const { config } = loadConfig(host.env);
      const definition = config.volumes?.[name];
      if (!definition)
        invalid(
          "volumes",
          "The selected volume is undefined.",
          "Define the volume in the user config.",
        );
      const volume = new Volume(
        definition,
        userStateDirectory(host.env),
        undefined,
        { volume: name },
      );
      if (action === "status") {
        const status = volume.status();
        print(status);
        if (status.stale)
          hint(
            `Run agent-bootstrap doctor and confirm no VM is running before using agent-bootstrap volume detach ${name} --force.`,
          );
        return 0;
      }
      if (action === "init") volume.init();
      if (action === "attach") volume.attach();
      if (action === "detach") volume.detach(extra[0] === "--force");
      print({ status: "ok" });
      return 0;
    }

    if (command === "concierge") {
      let path: string | undefined;
      let override: ClaudeAuthMode | undefined;
      try {
        if (rest.includes("--run") || rest.includes("--volume-shell"))
          return usage();
        ({ target: path, claudeAuth: override } = parseConciergeArgs(rest));
      } catch {
        return usage();
      }
      if (!io.conciergeTTY)
        return fail(
          1,
          "Concierge requires an operator terminal.",
          "Run agent-bootstrap concierge from a TTY with OSC 52 clipboard access disabled.",
        );
      const { first } = await doctor(root, host, path, true, override);
      if (first)
        return fail(
          3,
          "Concierge prerequisites are missing.",
          first.fix.join(" && ") ||
            "Run agent-bootstrap doctor with the same target.",
        );
      if (!(await (io.launch ?? launch)(root, rest, json)))
        return fail(
          1,
          "Concierge launcher failed.",
          "Review the terminal transcript and run agent-bootstrap help troubleshoot.",
        );
      const next =
        "Run agent-bootstrap status using the same target or restart Concierge with --continue.";
      if (json) print({ status: "ok", next });
      else hint(next);
      return 0;
    }

    if (command === "workplace") {
      if (json) return usage();
      let flags: ReturnType<typeof parseWorkplaceArgs>;
      try {
        flags = parseWorkplaceArgs(rest);
      } catch {
        return usage();
      }
      const { first } = await doctor(
        root,
        host,
        flags.target,
        true,
        flags.claudeAuth,
      );
      if (first)
        return fail(
          3,
          "Workplace prerequisites are missing.",
          first.fix.join(" && ") ||
            "Run agent-bootstrap doctor with the same target.",
        );
      return await (io.launchWorkplace ?? launchWorkplace)(root, rest);
    }

    let index = 0;
    while (
      ["--db", "--target", "--repo", "--all-targets"].includes(
        args[index] ?? "",
      )
    )
      index += args[index] === "--all-targets" ? 1 : 2;
    const operator = args[index] as keyof typeof operatorOutputs;
    if (
      !Object.hasOwn(operatorOutputs, operator) ||
      (operator === "watch" && json)
    )
      return usage();

    const output = operatorOutputs[operator];
    let error = "";
    let report = "";
    const records: unknown[] = [];
    const isReport = operator === "analyze" || operator === "denials";
    const code = await runCli(
      args,
      {
        ...io,
        stderr: {
          write(message) {
            error ||= message.trim();
            if (isReport) io.stderr.write(message);
          },
        },
        ...(json && {
          json(serialized: string) {
            records.push(JSON.parse(serialized));
            if (io.isTTY) io.stderr.write(`${serialized}\n`);
          },
          stdout: {
            write(message: string) {
              if (isReport) report += message;
              else io.stderr.write(message);
            },
          },
        }),
      },
      root,
      host.env,
    );
    if (code === 2) return usage();
    if (code === 1) {
      if (json && report) io.stderr.write(report);
      const [detail, action] = error.split("\nnext: ");
      if (action) return fail(1, detail!, action);
      return fail(
        1,
        !isReport && error ? error : "Local orchestrator command failed.",
        isReport
          ? "Check the target and DuckDB prerequisites with agent-bootstrap help performance."
          : `Check agent-bootstrap help --json for ${operator}.`,
      );
    }
    if (json)
      print(
        isReport
          ? { report }
          : operator === "reconcile"
            ? records.at(-1)
            : records.length === 2
              ? { preview: records[0], result: records[1] }
              : records.length === 1
                ? records[0]
                : { updated: true },
      );
    if (operator !== "watch") hint(output.next);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof MsbHomeError)
      return fail(1, error.message, error.next);
    if (error instanceof ClaudeConfigError)
      return fail(
        1,
        error.message,
        "Review the private Claude config.json and run agent-bootstrap doctor.",
      );
    if (error instanceof VolumeError) return fail(1, error.message, error.next);
    if (error instanceof ClaudeRunError)
      return fail(1, error.code, claudeNext(error.code));
    if (error instanceof SetupError)
      return fail(error.code, error.message, error.next);
    return fail(
      1,
      "Agent-bootstrap command failed.",
      `Run agent-bootstrap help ${command === "setup" ? "setup" : "troubleshoot"}.`,
    );
  }
}

export function terminalIo(json: boolean): BootstrapIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY:
      process.stdin.isTTY === true &&
      (json ? process.stderr : process.stdout).isTTY === true,
    approvalTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    async confirmProject(question) {
      let fd: number | undefined;
      try {
        fd = openSync("/dev/tty", "r+");
        writeFileSync(fd, question);
        const byte = Buffer.alloc(1);
        let answer = "";
        for (;;) {
          if (readSync(fd, byte) !== 1) return undefined;
          if (byte[0] === 10) return answer;
          if (answer.length > 48) return undefined;
          answer += byte.toString("latin1");
        }
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    conciergeTTY:
      process.stdin.isTTY === true &&
      process.stderr.isTTY === true &&
      (json || process.stdout.isTTY === true),
    async prompt(question) {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return await new Promise((resolve) => {
          rl.once("close", () => resolve(undefined));
          rl.question(question, resolve);
        });
      } finally {
        rl.close();
      }
    },
  };
}

export function bootstrapMain(argv: string[], root: string) {
  return runBootstrap(argv, root, terminalIo(includeJson(argv).json));
}
