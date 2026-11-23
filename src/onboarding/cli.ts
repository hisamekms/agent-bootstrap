import { spawn } from "node:child_process";
import { join } from "node:path";
import { runCli, type CliIo } from "../local-orchestrator/cli.ts";
import {
  ClaudeConfigError,
  loadClaudeConfig,
  parseClaudeAuthMode,
  userStateDirectory,
  validGroup,
  type ClaudeAuthMode,
} from "../local-orchestrator/claude-config.ts";
import { claudeNext } from "../local-orchestrator/claude-errors.ts";
import {
  ClaudeRunError,
  CredentialsVolume,
} from "../local-orchestrator/credentials-volume.ts";
import { checkDirectory, resolveTarget } from "../local-orchestrator/target.ts";
import { parseConciergeArgs } from "../local-orchestrator/concierge.ts";
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
  applySetup,
  authorizedAgentWarning,
  SetupError,
  setupPlan,
} from "./setup.ts";

type Exit = keyof typeof exitCodes;

export interface BootstrapIo extends CliIo {
  conciergeTTY: boolean;
  launch?(root: string, args: string[], json: boolean): Promise<boolean>;
}

function launch(root: string, args: string[], json: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--no-env-file",
        join(root, "spike/local-orchestrator/concierge.ts"),
        "--run",
        ...args,
      ],
      { stdio: json ? [0, 2, 2] : "inherit" },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
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
): Promise<Exit> {
  const { args, json } = includeJson(argv);
  const print = (value: unknown) =>
    io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  const [command = "help", ...commandArgs] = args;
  const rest = [...commandArgs, ...globalAuth];
  if (
    globalAuth.length &&
    !["doctor", "concierge", "credentials", "login"].includes(command)
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
        for (const { id, status, detail, fix } of checks)
          io.stdout.write(
            `${id.padEnd(width)}  ${status.padEnd(7)}  ${detail}${fix.length ? ` Fix: ${fix.join(" && ")}` : ""}\n`,
          );
      }
      hint(next);
      return first ? 3 : 0;
    }

    if (command === "setup") {
      if (
        rest.length !== new Set(rest).size ||
        rest.some(
          (arg) => !["--allow-network", "--yes", "--profiles"].includes(arg),
        )
      )
        return usage();
      const allowNetwork = rest.includes("--allow-network");
      const yes = rest.includes("--yes");
      if (yes) io.stderr.write(`${authorizedAgentWarning}\n`);
      const plan = await setupPlan(root, rest.includes("--profiles")).catch(
        () => {
          throw new SetupError(
            "The setup plan could not load the required profile lock.",
            "Restore the checked-in lock and matching recipes.",
            3,
          );
        },
      );
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
        const next = `Review the plan, then run agent-bootstrap setup --allow-network${rest.includes("--profiles") ? " --profiles" : ""} when authorized.`;
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

    if (command === "login" || command === "credentials") {
      let options: ReturnType<typeof claudeOptions>;
      try {
        options = claudeOptions(rest);
      } catch {
        return usage();
      }
      const { target: path, override, remaining } = options;
      const [action, ...extra] = remaining;
      const verifying = command === "credentials" && action === "verify";
      let group: string | undefined;
      if (command === "login" || verifying) {
        const groupArgs = verifying
          ? extra.filter((arg) => arg !== "--accept")
          : remaining;
        if (verifying && extra.filter((arg) => arg === "--accept").length !== 1)
          return usage();
        if (groupArgs.length) {
          if (
            groupArgs.length !== 2 ||
            groupArgs[0] !== "--group" ||
            !validGroup(groupArgs[1])
          )
            return usage();
          group = groupArgs[1];
        }
        if (command === "login" && !group) return usage();
        if (verifying ? !io.isTTY : !io.conciergeTTY)
          return fail(
            1,
            "An operator terminal is required.",
            `Run agent-bootstrap help ${command}.`,
          );
      } else if (
        extra.length ||
        !["status", "attach", "detach", "init"].includes(action ?? "")
      ) {
        return usage();
      }

      const target = await resolveTarget(path, root);
      await checkDirectory(target.directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      const effective = loadClaudeConfig(host.env, target.directory, override);
      for (const warning of effective.warnings) io.stderr.write(warning + "\n");
      const config = effective.configDir;
      if (!config || (group && !Object.hasOwn(config.groups, group)))
        throw new ClaudeRunError("config-invalid");

      if (command === "login") {
        const { first } = await doctor(root, host, path, true, override);
        if (first)
          return fail(
            3,
            "Login prerequisites are missing.",
            first.fix.join(" && ") || first.detail,
          );
        const launchArgs = ["--login-group", group!];
        if (path) launchArgs.push("--target", path);
        if (override) launchArgs.push("--claude-auth", override);
        if (!(await (io.launch ?? launch)(root, launchArgs, json)))
          return fail(
            1,
            "Login launcher failed.",
            "Review the terminal transcript and run agent-bootstrap help login.",
          );
        print({ status: "ok" });
        return 0;
      }

      const volume = new CredentialsVolume(
        config,
        userStateDirectory(host.env),
      );
      if (action === "status") {
        const status = volume.status();
        print(status);
        if (status.stale) hint("agent-bootstrap credentials detach");
        return 0;
      }
      if (action === "init") volume.init();
      if (action === "attach") volume.attach();
      if (action === "detach") volume.detach();
      if (verifying) {
        const { release } = volume.acquire();
        try {
          for (const name of group ? [group] : Object.keys(config.groups))
            volume.integrity(name, "accept", (note) =>
              io.stderr.write(note + "\n"),
            );
        } finally {
          release();
        }
      }
      print({ status: "ok" });
      return 0;
    }

    if (command === "concierge") {
      let path: string | undefined;
      let override: ClaudeAuthMode | undefined;
      try {
        if (rest.includes("--run") || rest.includes("--login-group"))
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

    let index = 0;
    while (
      ["--db", "--target", "--repo", "--all-targets"].includes(
        args[index] ?? "",
      )
    )
      index += args[index] === "--all-targets" ? 1 : 2;
    const operator = args[index] as keyof typeof operatorOutputs;
    if (!Object.hasOwn(operatorOutputs, operator)) return usage();

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
    );
    if (code === 2) return usage();
    if (code === 1) {
      if (json && report) io.stderr.write(report);
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
    hint(output.next);
    return 0;
  } catch (error) {
    if (error instanceof ClaudeConfigError)
      return fail(
        1,
        error.message,
        "Review the private Claude config.json and run agent-bootstrap doctor.",
      );
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
