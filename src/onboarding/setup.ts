import { join } from "node:path";
import { loadConfig } from "../config/layers.ts";
import { buildSandboxPlan } from "../image-build-sandbox.ts";
import { ALPINE_3_23, recipeFor } from "../image-recipes.ts";
import { resolveConfigTarget } from "../local-orchestrator/target.ts";
import { offlineMiseEnv } from "../mise-tools.ts";
import {
  allProfiles,
  artifacts,
  artifactStatus,
  defaultProfiles,
  fetchArtifact,
} from "./artifacts.ts";
import {
  hostChecks,
  imageStatus,
  msb,
  configureClaude,
  provisionKeychain,
  readLock,
  type Host,
} from "./prerequisites.ts";

export async function setupPlan(
  root: string,
  extended: boolean,
  env = process.env,
  targetPath?: string,
) {
  const selected = extended ? allProfiles : defaultProfiles;
  const lock = await readLock(root);
  const target = await resolveConfigTarget(targetPath, root, env);
  const { config } = loadConfig(env, target?.configDirectory);
  const includeSecrets = Object.keys(config.secretEnv ?? {}).length > 0;
  const inputs = artifacts(selected, undefined, includeSecrets);
  const profiles = selected.map((name) => {
    const entry = lock.profiles[name];
    if (!entry)
      throw new Error("Required profile is absent from the checked-in lock");
    const recipe = recipeFor(name);
    return {
      name,
      image: entry.image,
      base: recipe.base.reference,
      build: buildSandboxPlan(name, env),
      ...(recipe.base.kind === "debian-snapshot" && {
        packageSource: `http://snapshot.debian.org/archive/debian/${recipe.base.snapshot}/`,
        releasePins: recipe.base.inRelease,
      }),
    };
  });
  return {
    artifacts: await Promise.all(
      inputs.map(async (item) => ({
        ...item,
        status: await artifactStatus(join(root, item.path), item.sha256),
      })),
    ),
    images: { base: lock.base ?? ALPINE_3_23.reference, profiles },
    keychain: {
      commands: [...configureClaude, provisionKeychain],
      promptValue: "<ANTHROPIC_API_KEY>",
    },
  };
}

type Plan = Awaited<ReturnType<typeof setupPlan>>;

export class SetupError extends Error {
  readonly next: string;
  readonly code: 1 | 3;

  constructor(message: string, next: string, code: 1 | 3 = 1) {
    super(message);
    this.next = next;
    this.code = code;
  }
}

export const authorizedAgentWarning =
  "Warning: use --yes only when the operator explicitly authorized network access and image builds.";

export async function applySetup(
  root: string,
  host: Host,
  plan: Plan,
  allowNetwork: boolean,
) {
  if (!allowNetwork)
    throw new SetupError(
      "Setup changes require --allow-network.",
      "Review agent-bootstrap setup before explicitly authorizing network access.",
    );
  const { checks, home } = await hostChecks(root, host);
  const blocked = checks.find(({ status }) => status !== "ok");
  if (blocked || !home)
    throw new SetupError(
      "Setup prerequisites are missing.",
      blocked?.fix.join(" && ") || "Run agent-bootstrap doctor.",
      3,
    );

  const candidates = new Set<string>();
  for (const item of plan.artifacts) {
    const status = await artifactStatus(join(root, item.path), item.sha256);
    if (status === "wrong")
      throw new SetupError(
        "A local artifact does not match its pin.",
        `Inspect ${item.path} against agent-bootstrap setup --json before removing or replacing it.`,
      );
    if (status === "missing") candidates.add(item.path);
  }
  async function needsImage(reference: string, home: string) {
    const status = await imageStatus(host, home, reference);
    if (status === "wrong" || status === "skipped")
      throw new SetupError(
        "Local image inspection could not confirm a pinned digest.",
        "Run agent-bootstrap doctor and inspect MSB_HOME before retrying.",
      );
    return status === "missing";
  }

  const builds: Plan["images"]["profiles"] = [];
  for (const profile of plan.images.profiles)
    if (await needsImage(profile.image, home)) builds.push(profile);
  const bases = new Set([plan.images.base, ...builds.map(({ base }) => base)]);
  const pulls: string[] = [];
  for (const reference of bases)
    if (await needsImage(reference, home)) pulls.push(reference);

  const downloaded: string[] = [];
  for (const item of plan.artifacts) {
    if (!candidates.has(item.path)) continue;
    try {
      await fetchArtifact(root, item, host.fetch);
    } catch {
      throw new SetupError(
        "A pinned download failed verification or could not be saved.",
        `Check ${item.path} and its official URL in agent-bootstrap setup --json.`,
      );
    }
    downloaded.push(item.path);
  }

  const pulled: string[] = [];
  for (const reference of pulls) {
    const result = await msb(host, home, ["image", "pull", reference], 600_000);
    if (
      result.code !== 0 ||
      (await imageStatus(host, home, reference)) !== "ok"
    )
      throw new SetupError(
        "A pinned base image could not be pulled and verified.",
        "Check the image reference and MSB_HOME with agent-bootstrap doctor.",
      );
    pulled.push(reference);
  }

  const built: string[] = [];
  for (const { name, image, build } of builds) {
    const result = await host.command(
      process.execPath,
      [
        "--no-env-file",
        join(root, "spike/images/build-profile.ts"),
        "--locked",
        name,
      ],
      {
        ...offlineMiseEnv(host.env),
        MSB_HOME: home,
        XDG_STATE_HOME: host.env.XDG_STATE_HOME,
      },
      2_700_000,
    );
    if (result.code !== 0 || (await imageStatus(host, home, image)) !== "ok")
      throw new SetupError(
        "A profile build failed or differs from the checked-in digest.",
        `Inspect the ${name} build audit at ${build.auditPath} and its pinned inputs before retrying. See agent-bootstrap help setup.`,
      );
    built.push(name);
  }
  return { downloaded, pulled, built };
}
