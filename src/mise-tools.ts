export const MISE_FLAGS = ["--no-config", "--no-env", "--no-hooks"] as const;
export const MSB_TOOL = "microsandbox@0.7.16";
export const MISE_MSB = [...MISE_FLAGS, "exec", MSB_TOOL, "--", "msb"] as const;
export const MISE_DUCKDB = [
  ...MISE_FLAGS,
  "exec",
  "duckdb@1.5.6",
  "--",
  "duckdb",
  "-init",
  "/dev/null",
] as const;

export function offlineMiseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    MISE_DATA_DIR: env.MISE_DATA_DIR,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    MISE_OFFLINE: "1",
    MISE_NOT_FOUND_AUTO_INSTALL: "false",
    MISE_EXEC_AUTO_INSTALL: "false",
  };
}
