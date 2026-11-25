import { mkdtempDisposableSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorStore } from "../src/local-orchestrator/store.ts";

export function openTestStore(filename: string) {
  const store = OrchestratorStore.open(filename);
  return { store, [Symbol.dispose]: () => store.close() };
}

export function orchestratorFixture(
  prefix: string,
  parent = realpathSync(tmpdir()),
) {
  const temp = mkdtempDisposableSync(join(parent, prefix));
  const root = temp.path;
  const filename = join(root, "state.db");
  try {
    const database = openTestStore(filename);
    return {
      root,
      filename,
      store: database.store,
      [Symbol.dispose]() {
        try {
          database[Symbol.dispose]();
        } finally {
          temp.remove();
        }
      },
    };
  } catch (error) {
    temp.remove();
    throw error;
  }
}
