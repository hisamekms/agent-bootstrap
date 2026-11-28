export const mergeMethods = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof mergeMethods)[number];
export const autoMergeMethods = ["off", ...mergeMethods] as const;
export type AutoMerge = (typeof autoMergeMethods)[number];

export interface PublishConfig {
  enabled: boolean;
  remote: string;
  base: string;
  autoMerge: AutoMerge;
  mergeMethod: MergeMethod;
}

export function validPublishRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 255 &&
    !value.startsWith("-") &&
    !value.endsWith(".") &&
    value !== "@" &&
    value !== "HEAD" &&
    !/[~^:?*[\\]|\.\.|@\{/.test(value) &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    ) &&
    value
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

export function validPublishRemote(value: unknown): value is string {
  return validPublishRef(value) && !value.includes("=");
}

export const publishDefaults: PublishConfig = {
  enabled: false,
  remote: "origin",
  base: "main",
  autoMerge: "off",
  mergeMethod: "squash",
};

export interface PublishDestination {
  remote: string;
  repository: string;
  base: string;
  branch: string;
}

export type PublishChecks =
  "none" | "pending" | "failed" | "passed" | "unknown";
export type PublishCheckState = "pass" | "pending" | "fail";

export interface PublishPrFacts {
  checkRuns?: { name: string; state: PublishCheckState }[];
  checkCounts?: Record<PublishCheckState, number>;
  mergeable?: "clean" | "conflict" | "blocked" | "unknown";
  review?: "approved" | "changes-requested" | "review-required" | "none";
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface PublishPullRequest extends PublishPrFacts {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  head: string;
  checks?: PublishChecks;
  autoMerge: AutoMerge;
}

export type PublishFailure =
  | "publish-disabled"
  | "publish-not-ready"
  | "publish-busy"
  | "publish-stale-head"
  | "publish-destination-invalid"
  | "publish-destination-changed"
  | "publish-remote-head-changed"
  | "publish-export-failed"
  | "branch-checked-out"
  | "non-fast-forward"
  | "invalid-object"
  | "unsafe-repository"
  | "publish-non-fast-forward"
  | "publish-screen-blocked"
  | "publish-push-failed"
  | "publish-pr-failed"
  | "publish-merge-failed"
  | "publish-close-failed"
  | "publish-checks-failed"
  | "publish-checks-pending"
  | "publish-checks-unknown"
  | "publish-not-mergeable"
  | "publish-no-checks"
  | "publish-auto-merge-failed"
  | "auto-merge-disarm-failed"
  | "auto-merge-unavailable"
  | "publish-poll-failed"
  | "publish-audit-failed";

export class PublishError extends Error {
  readonly code: PublishFailure;

  constructor(code: PublishFailure) {
    super(code);
    this.code = code;
  }
}

export interface PublishProvider {
  repository(remote: string): Promise<string>;
  remoteHead(destination: PublishDestination): Promise<string | null>;
  push(
    destination: PublishDestination,
    head: string,
    expectedRemoteHead: string | null,
  ): Promise<void>;
  findPullRequest(
    destination: PublishDestination,
    recoveringHead?: string,
    afterPrNumber?: number,
  ): Promise<PublishPullRequest | null>;
  readPullRequest(
    destination: PublishDestination,
    number: number,
  ): Promise<PublishPullRequest>;
  openPullRequest(
    destination: PublishDestination,
    title: string,
    body: string,
  ): Promise<void>;
  mergePullRequest(
    destination: PublishDestination,
    number: number,
    method: MergeMethod,
    expectedHead: string,
  ): Promise<void>;
  closePullRequest(
    destination: PublishDestination,
    number: number,
  ): Promise<void>;
  setAutoMerge(
    destination: PublishDestination,
    number: number,
    method: AutoMerge,
    expectedHead: string,
  ): Promise<void>;
}
