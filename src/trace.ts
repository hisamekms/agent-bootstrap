import { SqliteAudit } from "./audit.ts";

if (import.meta.main) {
  const [filename, invocationId, extra] = process.argv.slice(2);
  if (!filename || !invocationId || extra !== undefined) {
    console.error("Usage: bun src/trace.ts <audit.sqlite> <invocation-id>");
    process.exitCode = 2;
  } else {
    try {
      const audit = new SqliteAudit(filename, { readonly: true });
      try {
        const events = audit.read(invocationId);
        if (!events.length) {
          console.error("Invocation was not found");
          process.exitCode = 1;
        } else {
          const result = events.at(-1);
          const outcome =
            result?.kind === "invocation.finished"
              ? result.outcome
              : "incomplete";
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
        }
      } finally {
        audit.close();
      }
    } catch {
      console.error("Audit trace could not be read");
      process.exitCode = 1;
    }
  }
}
