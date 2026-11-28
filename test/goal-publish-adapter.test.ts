import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig, parseConfig } from "../src/config/layers.ts";
import { githubGh } from "../src/publish/github-gh.ts";
import { publishDefaults } from "../src/publish/port.ts";

test("publishing config validates Git names and merges private layers only", () => {
  const user = parseConfig(
    {
      version: 1,
      publish: {
        remote: "origin",
        base: "release/stable",
        autoMerge: "merge",
        mergeMethod: "rebase",
      },
    },
    "user",
  );
  const local = parseConfig(
    {
      version: 1,
      publish: { enabled: true, remote: "upstream", autoMerge: "off" },
    },
    "local",
  );
  assert.deepEqual(mergeConfig(user, undefined, local).config.publish, {
    enabled: true,
    remote: "upstream",
    base: "release/stable",
    autoMerge: "off",
    mergeMethod: "rebase",
  });
  assert.equal(
    mergeConfig(user, undefined, local).sources["publish.base"],
    "user",
  );
  assert.equal(publishDefaults.enabled, false);
  assert.equal(publishDefaults.mergeMethod, "squash");
  assert.throws(
    () =>
      parseConfig(
        { version: 1, publish: { mergeMethod: "merge" } },
        "approved",
      ),
    /disallowed/,
  );
  assert.throws(
    () => parseConfig(local, "approved"),
    /publish\. This key is disallowed in this layer\./,
  );
  assert.throws(
    () => mergeConfig(user, local, { version: 1 }),
    /publish\. This key is disallowed in this layer\./,
  );
  for (const enabled of [true, false]) {
    const input = { version: 1 as const, publish: { enabled } };
    assert.throws(() => parseConfig(input, "user"), /publish\.enabled/);
    assert.throws(
      () => mergeConfig(input, undefined, local),
      /publish\.enabled/,
    );
  }
  assert.throws(
    () =>
      parseConfig(
        {
          version: 1,
          publish: { remote: "origin=unexpected" },
        },
        "local",
      ),
    /publish\.remote/,
  );
  for (const field of ["remote", "base"]) {
    for (const value of [
      "--force",
      "@",
      "HEAD",
      "some/../ref",
      "a//b",
      ".hidden",
      "head.lock",
      "a b",
      "a:b",
      "a[b",
      "a\\b",
    ]) {
      assert.throws(
        () => parseConfig({ version: 1, publish: { [field]: value } }, "local"),
        {
          message: new RegExp("publish[.]" + field + "[.]"),
        },
      );
    }
  }
  for (const [key, value] of Object.entries({
    enabled: "true",
    autoMerge: "fast-forward",
    mergeMethod: "off",
  }))
    assert.throws(
      () => parseConfig({ version: 1, publish: { [key]: value } }, "local"),
      { message: new RegExp("publish[.]" + key + "[.]") },
    );
});

const destination = {
  remote: "origin",
  repository: "fixture/project",
  base: "main",
  branch: "ab/g2-aabbccdd",
};
const head = "b".repeat(40);
const prJson = {
  number: 5,
  url: "https://github.com/fixture/project/pull/5",
  state: "OPEN",
  headRefOid: head,
  headRefName: destination.branch,
  baseRefName: "main",
  isCrossRepository: false,
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
  autoMergeRequest: { mergeMethod: "SQUASH" },
};
const ok = (stdout = "") => ({ ok: true, stdout, diagnostic: "" });
const failed = (stdout: string, diagnostic: string) => ({
  ok: false,
  stdout,
  diagnostic,
});

test("GitHub adapter uses explicit repo and refs, strips token variables and feeds PR body through stdin", async () => {
  const commands: Parameters<NonNullable<Parameters<typeof githubGh>[2]>>[] =
    [];
  const provider = githubGh(
    "/checkout",
    {
      HOME: "/homedir",
      PATH: ".:/fake-bin::relative:/checkout/node_modules/.bin",
      GH_CONFIG_DIR: "/private-gh-config",
      GH_TOKEN: "fixture",
      GITHUB_TOKEN: "fixture",
      GIT_CONFIG_COUNT: "2",
      SSH_AUTH_SOCK: "/ssh",
    },
    async (...command) => {
      commands.push(command);
      const [binary, args] = command;
      if (binary === "git" && args.includes("get-url"))
        return ok(
          args.includes("--push")
            ? "git@github.com:fixture/project.git\n"
            : "https://github.com/Fixture/Project.git\n",
        );
      if (binary === "git" && args.includes("-v"))
        return ok(pushRemoteListing("git@github.com:fixture/project.git"));
      if (binary === "git" && args.includes("--get-url"))
        return ok(args.at(-1) + "\n");
      if (binary === "git" && args.includes("ls-remote"))
        return ok(`${head}\trefs/heads/${destination.branch}\n`);
      if (args.includes("view")) return ok(JSON.stringify(prJson));
      return ok();
    },
  );
  await assert.rejects(provider.repository("origin=unexpected"), {
    code: "publish-destination-invalid",
  });
  assert.equal(commands.length, 0);
  assert.equal(await provider.repository("origin"), destination.repository);
  assert.equal(await provider.remoteHead(destination), head);
  const priorHead = "a".repeat(40);
  await provider.push(destination, head, priorHead);
  await provider.openPullRequest(
    destination,
    "--literal title",
    "fixture body",
  );
  await provider.setAutoMerge(destination, 5, "rebase", head);
  assert.deepEqual(await provider.readPullRequest(destination, 5), {
    number: 5,
    url: prJson.url,
    state: "open",
    head,
    checks: "failed",
    checkRuns: [{ name: "チェック", state: "fail" }],
    checkCounts: { pass: 0, pending: 0, fail: 1 },
    mergeable: "unknown",
    review: "none",
    autoMerge: "squash",
  });

  await provider.mergePullRequest(destination, 5, "squash", head);
  await provider.closePullRequest(destination, 5);
  assert.deepEqual(commands.at(-2)?.[1], [
    "pr",
    "merge",
    "5",
    "--repo",
    "github.com/fixture/project",
    "--squash",
    "--match-head-commit",
    head,
  ]);
  assert.deepEqual(commands.at(-1)?.[1], [
    "pr",
    "close",
    "5",
    "--repo",
    "github.com/fixture/project",
  ]);

  for (const [binary, , cwd, env] of commands) {
    assert.equal(cwd, "/checkout");
    assert.equal(env.PATH, "/fake-bin");
    assert.equal(env.GH_CONFIG_DIR, "/private-gh-config");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.SSH_AUTH_SOCK, binary === "git" ? "/ssh" : undefined);
  }
  const push = commands.find(([, args]) => args.includes("push"))!;
  assert.deepEqual(push[1].slice(-3), [
    "--",
    "git@github.com:fixture/project.git",
    `${head}:refs/heads/${destination.branch}`,
  ]);
  assert.ok(push[1].every((arg) => arg !== "-f" && !arg.startsWith("--force")));
  assert.deepEqual(
    commands.find(([, args]) => args.includes("merge-base"))?.[1].slice(-4),
    ["merge-base", "--is-ancestor", priorHead, head],
  );
  const create = commands.find(([, args]) => args.includes("create"))!;
  assert.equal(create[4], "fixture body");
  assert.deepEqual(create[1].slice(-3), [
    "--title=--literal title",
    "--body-file",
    "-",
  ]);
  const merge = commands.find(([, args]) => args.includes("merge"))!;
  assert.deepEqual(merge[1].slice(-4), [
    "--auto",
    "--rebase",
    "--match-head-commit",
    head,
  ]);
});

test("GitHub PR facts bound and screen names and aggregate checks beyond the display limit", async () => {
  const raw = {
    ...prJson,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    additions: 57,
    deletions: 4,
    changedFiles: 3,
    statusCheckRollup: [
      { name: "build", conclusion: "SUCCESS" },
      { context: "integration\nchecks", state: "PENDING" },
      { name: "sk-ant-" + "a".repeat(32), conclusion: "SUCCESS" },
      { name: "long " + "画".repeat(140), conclusion: "SKIPPED" },
      ...Array.from({ length: 46 }, () => ({
        name: "test",
        conclusion: "SUCCESS",
      })),
      { name: "hidden failure", conclusion: "TIMED_OUT" },
    ],
  };
  const provider = githubGh("/checkout", {}, async (_binary, args) => {
    const fields = args.at(-1)?.split(",");
    for (const field of [
      "statusCheckRollup",
      "mergeable",
      "mergeStateStatus",
      "reviewDecision",
      "additions",
      "deletions",
      "changedFiles",
    ])
      assert.ok(fields?.includes(field));
    return ok(JSON.stringify(raw));
  });
  const result = await provider.readPullRequest(destination, 5);
  assert.partialDeepStrictEqual(result, {
    checks: "failed",
    checkCounts: { pass: 49, pending: 1, fail: 1 },
    mergeable: "clean",
    review: "approved",
    additions: 57,
    deletions: 4,
    changedFiles: 3,
  });
  assert.equal(result.checkRuns?.length, 50);
  assert.deepEqual(result.checkRuns?.slice(0, 3), [
    { name: "build", state: "pass" },
    { name: "integration checks", state: "pending" },
    { name: "名前非表示", state: "pass" },
  ]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result.checkRuns?.[3]?.name)) <= 32,
  );
  assert.doesNotMatch(JSON.stringify(result), /sk-ant-|hidden failure/);
  raw.mergeable = "CONFLICTING";
  raw.reviewDecision = "CHANGES_REQUESTED";
  assert.partialDeepStrictEqual(
    await provider.readPullRequest(destination, 5),
    {
      mergeable: "conflict",
      review: "changes-requested",
    },
  );
  raw.mergeable = "MERGEABLE";
  raw.mergeStateStatus = "BLOCKED";
  raw.reviewDecision = "REVIEW_REQUIRED";
  raw.statusCheckRollup = [{ name: "test", conclusion: "PENDING" }];
  assert.partialDeepStrictEqual(
    await provider.readPullRequest(destination, 5),
    {
      checks: "pending",
      mergeable: "blocked",
      review: "review-required",
    },
  );
  raw.reviewDecision = "APPROVED";
  assert.partialDeepStrictEqual(
    await provider.readPullRequest(destination, 5),
    {
      checks: "pending",
      mergeable: "unknown",
      review: "approved",
    },
  );
  raw.reviewDecision = "REVIEW_REQUIRED";
  raw.statusCheckRollup = [];
  assert.partialDeepStrictEqual(
    await provider.readPullRequest(destination, 5),
    {
      checks: "none",
      checkRuns: [],
      checkCounts: { pass: 0, pending: 0, fail: 0 },
      mergeable: "blocked",
      review: "review-required",
    },
  );
});

function pushRemoteListing(url: string) {
  return `agent-bootstrap-publish-url-check\t${url} (push)\n`;
}

test("GitHub adapter reports missing and non-array PR checks as unknown", async () => {
  for (const statusCheckRollup of [undefined, null, {}]) {
    const provider = githubGh("/checkout", {}, async () =>
      ok(JSON.stringify({ ...prJson, statusCheckRollup })),
    );
    const pr = await provider.readPullRequest(destination, 5);
    assert.equal(pr.checks, "unknown");
    assert.equal(pr.checkCounts, undefined);
    assert.equal(pr.checkRuns, undefined);
  }
});

test("GitHub adapter refuses ambiguous remotes and untrusted PR responses and maps command errors", async () => {
  let remote =
    "https://github.com/fixture/project.git\nhttps://other.example/project\n";
  let response = {
    ...prJson,
    url: "https://evil.example/fixture/project/pull/5",
  };
  let rewrittenPushUrl: string | undefined;
  let pushes = 0;
  const provider = githubGh("/checkout", {}, async (_, args) => {
    const alias = args.find((arg) =>
      arg.startsWith("remote.agent-bootstrap-publish-url-check.url="),
    );
    if (alias)
      return ok(pushRemoteListing(rewrittenPushUrl ?? alias.split("=")[1]!));
    if (args.includes("get-url")) return ok(remote);
    if (args.includes("push")) {
      pushes++;
      return failed(
        "!\tsource:destination\t[rejected] (fetch first)\n",
        "private diagnostic",
      );
    }
    if (args.includes("merge"))
      return failed(
        "",
        "GraphQL: Protected branch rules not configured for this branch",
      );
    return ok(JSON.stringify(response));
  });
  await assert.rejects(provider.repository("origin"), {
    code: "publish-destination-invalid",
  });
  remote = "https://github.com/fixture/project.git\n";
  rewrittenPushUrl = "https://github.com/fixture/other.git";
  await assert.rejects(provider.push(destination, head, null), {
    code: "publish-destination-changed",
  });
  assert.equal(pushes, 0);
  rewrittenPushUrl = undefined;
  await assert.rejects(provider.push(destination, head, null), {
    code: "publish-non-fast-forward",
  });
  await assert.rejects(provider.readPullRequest(destination, 5), {
    code: "publish-pr-failed",
  });
  await assert.rejects(provider.setAutoMerge(destination, 5, "squash", head), {
    code: "auto-merge-unavailable",
  });
  response = { ...prJson, state: "MERGED" };
  assert.equal(
    (await provider.readPullRequest(destination, 5)).state,
    "merged",
  );
});

test("the adapter detects a chained URL rewrite using real local Git", async () => {
  using checkout = mkdtempDisposableSync(join(tmpdir(), "publish-remote-"));
  const git = (args: readonly string[]) => {
    const { stdout, stderr, status } = spawnSync("/usr/bin/git", args, {
      cwd: checkout.path,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      encoding: "utf8",
    });
    return { stdout, diagnostic: stderr, ok: status === 0 };
  };
  const configured = "https://github.com/fixture/configured.git";
  const pinned = "https://github.com/fixture/project.git";
  const other = "https://github.com/fixture/other.git";
  for (const args of [
    ["init", "--quiet", "--template="],
    ["remote", "add", "origin", configured],
    ["config", `url.${pinned}.insteadOf`, configured],
  ])
    assert.ok(git(args).ok);
  let pushes = 0;
  const provider = githubGh(checkout.path, {}, async (binary, args) => {
    assert.equal(binary, "git");
    if (args.includes("push")) {
      assert.ok(args.includes(`http.${pinned}.followRedirects=false`));
      pushes++;
      return ok();
    }
    return git(args);
  });
  await provider.push(destination, head, null);
  assert.ok(git(["config", `url.${other}.insteadOf`, pinned]).ok);
  assert.equal(await provider.repository("origin"), destination.repository);
  await assert.rejects(provider.push(destination, head, null), {
    code: "publish-destination-changed",
  });
  await assert.rejects(provider.remoteHead(destination), {
    code: "publish-destination-changed",
  });
  assert.equal(pushes, 1);
});
