import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  configRoot,
  userConfigPath,
  writePrivateConfig,
} from "../src/config/layers.ts";

export function configEnv(
  root: string,
  repositoryRoot?: string,
): NodeJS.ProcessEnv {
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config-home"),
    XDG_STATE_HOME: join(root, "state-home"),
  };
  if (repositoryRoot !== undefined)
    writePrivateConfig(userConfigPath(env), configRoot(env), {
      version: 1,
      repositories: { root: repositoryRoot },
    });
  return env;
}

export function fixtureGit(dir: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", args, {
    cwd: dir,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@localhost",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@localhost",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export function initConfigRepo(path: string) {
  mkdirSync(path, { recursive: true });
  fixtureGit(
    path,
    "init",
    "--template=",
    "--initial-branch=main",
    "--object-format=sha1",
  );
  fixtureGit(path, "commit", "--allow-empty", "-m", "base");
  return path;
}
