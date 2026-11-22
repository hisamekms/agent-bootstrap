import { resolve } from "node:path";
import { SqliteAudit } from "./audit.ts";
import { CoordinatorTask, type CoordinatorDriver } from "./coordinator.ts";
import { taskTrace } from "./task-trace.ts";

const usage = `Usage:
  bun src/trace.ts <audit.sqlite> <invocation-id>
  bun src/trace.ts task <audit.sqlite> <task-journal-root> <task-id>`;

// Reading a journal never runs the task, so no driver operation is reachable.
const unreachable = () => {
  throw new Error("Trace reader cannot run tasks");
};
const readOnlyDriver: CoordinatorDriver = {
  step: unreachable,
  delegate: unreachable,
  reviewedCandidate: unreachable,
  decide: unreachable,
};

async function invocation(filename: string, invocationId: string) {
  const audit = new SqliteAudit(filename, { readonly: true });
  try {
    const events = audit.read(invocationId);
    if (!events.length) {
      console.error("Invocation was not found");
      process.exitCode = 1;
      return;
    }
    const result = events.at(-1);
    const outcome =
      result?.kind === "invocation.finished" ? result.outcome : "incomplete";
    const pendingOperation =
      result?.kind === "operation.requested"
        ? { operation: result.operation, effect: "not-authorized" }
        : result?.kind === "operation.allowed"
          ? { operation: result.operation, effect: "unknown" }
          : undefined;
    console.log(
      JSON.stringify(
        { invocationId, outcome, pendingOperation, events },
        null,
        2,
      ),
    );
  } finally {
    audit.close();
  }
}

async function task(filename: string, root: string, taskId: string) {
  const audit = new SqliteAudit(filename, { readonly: true });
  try {
    const trace = await taskTrace(
      new CoordinatorTask(root, taskId, readOnlyDriver),
      audit,
    );
    if (!trace.coordinator.length) {
      console.error("Task was not found");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ taskId, ...trace }, null, 2));
  } finally {
    audit.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    // Paths may be relative to the current directory.
    if (args[0] === "task" && args.length === 4)
      await task(resolve(args[1]!), resolve(args[2]!), args[3]!);
    else if (args.length === 2 && args[0] !== "task")
      await invocation(resolve(args[0]!), args[1]!);
    else {
      console.error(usage);
      process.exitCode = 2;
    }
  } catch {
    console.error("Audit trace could not be read");
    process.exitCode = 1;
  }
}
