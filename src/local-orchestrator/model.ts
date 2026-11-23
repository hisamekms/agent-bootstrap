import { createHash } from "node:crypto";
import { types } from "node:util";
import { PROFILE_NAMES, type ProfileName } from "../sandbox-profiles.ts";

export const ACTOR_KINDS = Object.freeze([
  "Concierge",
  "Planner",
  "Researcher",
  "Executor",
  "Reviewer",
] as const);
export type ActorKind = (typeof ACTOR_KINDS)[number];
export const GATES = Object.freeze([
  "goal-registration",
  "task-registration",
  "integration",
] as const);
export type Gate = (typeof GATES)[number];
export type Policy = "human" | "agent";
export type PolicySet = Partial<Record<Gate, Policy>>;
export type PolicySource = "default" | "request" | "goal" | "task";

export interface Budgets {
  readonly maxExecutionMs: number;
  readonly maxRetries: number;
  readonly maxTokens: number;
}
export interface GoalScope {
  readonly paths: readonly string[];
  readonly profiles: readonly ProfileName[];
  readonly actors: readonly ActorKind[];
  readonly maxTasks: number;
  readonly budgets: Budgets;
}
export interface GoalContent {
  readonly title: string;
  readonly description: string;
  readonly acceptance: readonly string[];
  readonly scope: GoalScope;
  readonly policies?: PolicySet;
}
export interface TaskContent {
  readonly goalId: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance: readonly string[];
  readonly actor: "Executor" | "Researcher";
  readonly profile: ProfileName;
  readonly paths: readonly string[];
  readonly dependsOn: readonly string[];
  readonly budgets: Budgets;
  readonly policies?: PolicySet;
}

export interface IntegrationContent {
  readonly taskId: string;
  readonly goalId: string;
  readonly branch: string;
  readonly base: string;
  readonly candidate: string;
  readonly digest: string;
  readonly changedPaths: readonly string[];
  readonly symlinks?: readonly string[];
  readonly review: { readonly result: "pass"; readonly notes?: string };
}

export function goalBranch(goalId: string): string {
  const prefix = goalId.split("-")[0];
  if (!prefix || !/^[a-f0-9]{8}$/.test(prefix)) throw new ContractError();
  return `lo/goal-${prefix}`;
}

export function validateIntegrationContent(value: unknown): IntegrationContent {
  const input = fields(value, [
    "taskId",
    "goalId",
    "branch",
    "base",
    "candidate",
    "digest",
    "changedPaths",
    "symlinks",
    "review",
  ]);
  const goalId = identifier(input.goalId);
  const branch = goalBranch(goalId);
  const oid = (value: unknown, length: number) => {
    const hash = string(value, length, length);
    if (!/^[a-f0-9]+$/.test(hash)) throw new ContractError();
    return hash;
  };
  if (input.branch !== branch) throw new ContractError();
  const review = fields(input.review, ["result", "notes"]);
  const changedPaths = unique(input.changedPaths, 1, 10_000, (value) => {
    const name = path(value);
    if (name.endsWith("/")) throw new ContractError();
    return name;
  });
  const symlinks = Object.hasOwn(input, "symlinks")
    ? unique(input.symlinks, 0, changedPaths.length, path)
    : undefined;
  const changed = new Set(changedPaths);
  if (symlinks?.some((name) => !changed.has(name))) throw new ContractError();
  return freeze({
    taskId: identifier(input.taskId),
    goalId,
    branch,
    base: oid(input.base, 40),
    candidate: oid(input.candidate, 40),
    digest: oid(input.digest, 64),
    changedPaths,
    ...(symlinks === undefined ? {} : { symlinks }),
    review: {
      result: oneOf(review.result, ["pass"]),
      ...(Object.hasOwn(review, "notes")
        ? { notes: string(review.notes, 1, 2048) }
        : {}),
    },
  });
}

export class ContractError extends Error {
  constructor() {
    super("Invalid local orchestrator input");
    this.name = "ContractError";
  }
}

export function fields(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new ContractError();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw new ContractError();
    copy[key] = descriptor.value;
  }
  return copy;
}

export function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !choices.some((choice) => choice === value))
    throw new ContractError();
  return value as T;
}

export function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new ContractError();
  return value === 0 ? 0 : value;
}

function string(value: unknown, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0")
  )
    throw new ContractError();
  return value;
}

export function identifier(value: unknown): string {
  const id = string(value, 1, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id)) throw new ContractError();
  return id;
}

function array<T>(
  value: unknown,
  min: number,
  max: number,
  parse: (item: unknown, index: number) => T,
): T[] {
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    value.length < min ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new ContractError();
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, index);
    if (!entry?.enumerable || !("value" in entry)) throw new ContractError();
    return parse(entry.value, index);
  });
}

function unique<T>(
  value: unknown,
  min: number,
  max: number,
  parse: (item: unknown) => T,
): T[] {
  const items = array(value, min, max, parse);
  if (new Set(items).size !== items.length) throw new ContractError();
  return items;
}

function path(value: unknown): string {
  const name = string(value, 1, 4096);
  const segments = name.replace(/\/$/, "").split("/");
  if (
    /[\\\p{Cc}\p{Cs}]/u.test(name) ||
    /^[a-z]:/i.test(name) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new ContractError();
  return name;
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validatePolicies(value: unknown): PolicySet {
  const input = fields(value, GATES);
  const policies: PolicySet = {};
  for (const gate of GATES) {
    if (Object.hasOwn(input, gate))
      policies[gate] = oneOf(input[gate], ["human", "agent"]);
  }
  return freeze(policies);
}

const budgetKeys = ["maxExecutionMs", "maxRetries", "maxTokens"] as const;
const profiles = PROFILE_NAMES.filter((name) => name !== "concierge");

function budgets(value: unknown): Budgets {
  const input = fields(value, budgetKeys);
  return {
    maxExecutionMs: integer(input.maxExecutionMs, 1, 3_600_000),
    maxRetries: integer(input.maxRetries, 0, 10),
    maxTokens: integer(input.maxTokens, 1, 10_000_000),
  };
}

const sharedKeys = ["title", "description", "acceptance", "policies"];

function shared(input: Record<string, unknown>) {
  const title = string(input.title, 1, 200);
  if (/\p{Cc}/u.test(title)) throw new ContractError();
  return {
    title,
    description: string(input.description, 0, 20_000),
    acceptance: unique(input.acceptance, 1, 32, (item) =>
      string(item, 1, 20_000),
    ),
    ...(Object.hasOwn(input, "policies")
      ? { policies: validatePolicies(input.policies) }
      : {}),
  };
}

export function validateGoalContent(value: unknown): GoalContent {
  const input = fields(value, [...sharedKeys, "scope"]);
  const scope = fields(input.scope, [
    "paths",
    "profiles",
    "actors",
    "maxTasks",
    "budgets",
  ]);
  return freeze({
    ...shared(input),
    scope: {
      paths: unique(scope.paths, 1, 64, path),
      profiles: unique(scope.profiles, 0, profiles.length, (item) =>
        oneOf(item, profiles),
      ),
      actors: unique(scope.actors, 0, 4, (item) =>
        oneOf(item, ACTOR_KINDS.slice(1)),
      ),
      maxTasks: integer(scope.maxTasks, 1, 1000),
      budgets: budgets(scope.budgets),
    },
  });
}

export function validateTaskContent(value: unknown): TaskContent {
  const input = fields(value, [
    ...sharedKeys,
    "goalId",
    "actor",
    "profile",
    "paths",
    "dependsOn",
    "budgets",
  ]);
  const actor = oneOf(input.actor, ["Executor", "Researcher"]);
  return freeze({
    ...shared(input),
    goalId: identifier(input.goalId),
    actor,
    profile: oneOf(input.profile, profiles),
    paths:
      actor === "Executor"
        ? unique(input.paths, 1, 64, path)
        : unique(input.paths, 0, 0, path),
    dependsOn: unique(input.dependsOn, 0, 1000, identifier),
    budgets: budgets(input.budgets),
  });
}

export function canonicalJson(value: unknown, maxBytes = Infinity): string {
  const chunks: string[] = [];
  let bytes = 0;
  function append(chunk: string): void {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new ContractError();
    chunks.push(chunk);
  }
  function write(item: unknown, depth: number): void {
    if (depth > 64 || types.isProxy(item)) throw new ContractError();
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "string" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      append(JSON.stringify(item));
      return;
    }
    if (Array.isArray(item)) {
      append("[");
      array(item, 0, maxBytes, (child, index) => {
        if (index > 0) append(",");
        write(child, depth + 1);
      });
      append("]");
      return;
    }
    if (typeof item !== "object") throw new ContractError();
    const keys = Object.keys(item).sort();
    const input = fields(item, keys);
    append("{");
    for (const [index, key] of keys.entries()) {
      if (index > 0) append(",");
      append(JSON.stringify(key));
      append(":");
      write(input[key], depth + 1);
    }
    append("}");
  }
  write(value, 0);
  return chunks.join("");
}

export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function taskLimitReasons(
  goal: GoalContent,
  task: TaskContent,
  registeredTaskCount: number,
): string[] {
  const reasons: string[] = [];
  for (const key of budgetKeys) {
    if (task.budgets[key] > goal.scope.budgets[key]) reasons.push(key);
  }
  if (registeredTaskCount >= goal.scope.maxTasks) reasons.push("maxTasks");
  return reasons;
}

export function allowsPath(paths: readonly string[], path: string): boolean {
  return paths.some(
    (scope) =>
      path === scope || (scope.endsWith("/") && path.startsWith(scope)),
  );
}

export function fitsScope(
  goal: GoalContent,
  task: TaskContent,
  registeredTaskCount: number,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (task.paths.some((path) => !allowsPath(goal.scope.paths, path)))
    reasons.push("paths");
  if (!goal.scope.profiles.includes(task.profile)) reasons.push("profile");
  if (!goal.scope.actors.includes(task.actor)) reasons.push("actor");
  reasons.push(...taskLimitReasons(goal, task, registeredTaskCount));
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface PolicyLayers {
  readonly defaults: PolicySet;
  readonly request?: PolicySet;
  readonly goal?: PolicySet;
  readonly task?: PolicySet;
}

export function resolvePolicy(
  gate: Gate,
  layers: PolicyLayers,
): { policy: Policy; source: PolicySource } {
  for (const source of ["task", "goal", "request"] as const) {
    const policy = layers[source]?.[gate];
    if (policy !== undefined) return { policy, source };
  }
  return { policy: layers.defaults[gate] ?? "human", source: "default" };
}

export function loosens(prior: Policy, next: Policy): boolean {
  return prior === "human" && next === "agent";
}

export function requestedLoosening(
  layersBefore: PolicyLayers,
  requested: PolicySet,
): Gate[] {
  return GATES.filter((gate) => {
    const policy = requested[gate];
    return (
      policy !== undefined &&
      loosens(resolvePolicy(gate, layersBefore).policy, policy)
    );
  });
}
