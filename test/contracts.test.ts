import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ROLE_CONTRACTS,
  type ArtifactRef,
  type CoordinatorHostPort,
  type DelegateRequest,
  type HumanRequestStatus,
  type IntegrationReceipt,
  type IntegrationRequest,
  type InvocationRecord,
  type ReadOnlySandboxPort,
  type SandboxAgent,
  type WorkerSandboxPort,
} from "../src/contracts.ts";

// Credential-free in-memory fixtures. They illustrate contract consumption;
// they are not a production host, audit log, policy engine or secure sandbox.
function artifactStoreFixture() {
  const artifacts = new Map<string, { ref: ArtifactRef; bytes: Uint8Array }>();
  return {
    publish(content: string, mediaType: string): ArtifactRef {
      const bytes = new TextEncoder().encode(content);
      const ref = {
        id: `fixture-artifact-${artifacts.size + 1}`,
        mediaType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      artifacts.set(ref.id, { ref, bytes });
      return ref;
    },
    read(
      ref: ArtifactRef,
      grants: ReadonlyMap<string, ArtifactRef>,
    ): Uint8Array {
      assert.deepEqual(
        grants.get(ref.id),
        ref,
        "Fixture artifact grant denied",
      );
      const stored = artifacts.get(ref.id);
      assert.ok(stored, "Missing fixture artifact");
      assert.deepEqual(stored.ref, ref, "Fixture artifact identity mismatch");
      assert.equal(
        createHash("sha256").update(stored.bytes).digest("hex"),
        ref.sha256,
      );
      return stored.bytes.slice();
    },
  };
}

function sandboxFixture(
  seed: ReadonlyMap<string, string>,
  writable: boolean,
  store = artifactStoreFixture(),
  inputs: readonly ArtifactRef[] = [],
) {
  const repository = new Map(seed);
  const scratch = new Map<string, string>();
  const grants = new Map(inputs.map((ref) => [ref.id, ref]));
  const read = (files: Map<string, string>, path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`Missing fixture file: ${path}`);
    return Promise.resolve(content);
  };
  const port: ReadOnlySandboxPort = {
    readArtifact: (ref) =>
      Promise.resolve().then(() => store.read(ref, grants)),
    readRepository: (path) => read(repository, path),
    readScratch: (path) => read(scratch, path),
    writeScratch(path, content) {
      scratch.set(path, content);
      return Promise.resolve();
    },
    publishArtifact(path, mediaType) {
      const content = scratch.get(path) ?? repository.get(path);
      if (content === undefined) throw new Error("Missing fixture artifact");
      const ref = store.publish(content, mediaType);
      grants.set(ref.id, ref);
      return Promise.resolve(ref);
    },
  };
  const worker: WorkerSandboxPort = {
    ...port,
    writeWorkspace(path, content) {
      if (!writable) throw new Error("Fixture write denied");
      repository.set(path, content);
      return Promise.resolve();
    },
  };
  return { port, worker };
}

function hostFixture() {
  const invocations = new Map<string, InvocationRecord>();
  const humanRequests = new Map<string, HumanRequestStatus>();
  const delegations = new Map<
    string,
    { request: string; value: { id: string } }
  >();
  const integrations = new Map<
    string,
    { request: string; value: IntegrationReceipt }
  >();
  // Illustrative task-scoped replay behavior, not a durable idempotency implementation.
  function replay<T>(
    cache: Map<string, { request: string; value: T }>,
    key: string,
    request: unknown,
    create: () => T,
  ): T {
    const serialized = JSON.stringify(request);
    const previous = cache.get(key);
    if (previous) {
      assert.equal(
        previous.request,
        serialized,
        "Fixture idempotency key conflict",
      );
      return previous.value;
    }
    const value = create();
    cache.set(key, { request: serialized, value });
    return value;
  }
  const port: CoordinatorHostPort = {
    delegate(request) {
      return Promise.resolve().then(() =>
        replay(delegations, request.idempotencyKey, request, () => {
          const invocation = {
            id: `fixture-invocation-${invocations.size + 1}`,
          };
          invocations.set(invocation.id, {
            invocation,
            request: structuredClone(request),
            status: "queued",
          });
          return invocation;
        }),
      );
    },
    getInvocation(invocation) {
      const record = invocations.get(invocation.id);
      if (!record) throw new Error("Unknown fixture invocation");
      return Promise.resolve(structuredClone(record));
    },
    getStatus() {
      return Promise.resolve({
        invocations: [...invocations.values()].map(
          ({ invocation, request, status }) => ({
            invocation,
            role: request.role,
            status,
          }),
        ),
        humanRequests: structuredClone([...humanRequests.values()]),
        integrations: [...integrations.values()].map(({ value }) => value),
      });
    },
    askHuman() {
      const requestId = `fixture-human-${humanRequests.size + 1}`;
      humanRequests.set(requestId, { requestId, status: "pending" });
      return Promise.resolve({ requestId });
    },
    requestIntegration(request) {
      return Promise.resolve().then(() =>
        replay(integrations, request.idempotencyKey, request, () => ({
          status: "pending-human-approval",
          requestId: `fixture-integration-${integrations.size + 1}`,
        })),
      );
    },
  };
  return {
    port,
    // Test driver stands in for a human response arriving through a separate host channel.
    answerHuman(requestId: string, answer: string) {
      assert.ok(humanRequests.has(requestId));
      humanRequests.set(requestId, {
        requestId,
        status: "answered",
        answer,
        evidence: [],
      });
    },
  };
}

test("role declarations isolate every role and restrict host tools to Coordinator", () => {
  assert.deepEqual(Object.keys(ROLE_CONTRACTS), [
    "Coordinator",
    "Planner",
    "Worker",
    "Reviewer",
  ]);
  for (const [role, contract] of Object.entries(ROLE_CONTRACTS)) {
    assert.equal(contract.isolation, "per-invocation");
    assert.equal(contract.push, "denied");
    if (role !== "Coordinator") assert.deepEqual(contract.hostTools, []);
  }
  assert.deepEqual(ROLE_CONTRACTS.Coordinator.hostTools, [
    "delegate",
    "getInvocation",
    "getStatus",
    "askHuman",
    "requestIntegration",
  ]);
  assert.deepEqual(ROLE_CONTRACTS.Coordinator.delegateTargets, [
    "Planner",
    "Worker",
    "Reviewer",
  ]);
});

test("fake Coordinator has only host tools and can delegate without a prescribed sequence", async () => {
  const { port } = hostFixture();
  const coordinator: SandboxAgent<"Coordinator"> = {
    role: "Coordinator",
    async run(_input, host) {
      assert.deepEqual(Object.keys(host), ROLE_CONTRACTS.Coordinator.hostTools);
      const roles = ["Reviewer", "Worker", "Planner", "Worker"] as const;
      for (const [index, role] of roles.entries()) {
        const request: DelegateRequest = {
          idempotencyKey: `step-${index}`,
          role,
          task: "Explore",
          inputs: [],
        };
        const invocation = await host.delegate(request);
        assert.deepEqual(
          (await host.getInvocation(invocation)).request,
          request,
        );
      }
      assert.deepEqual(
        (await host.getStatus()).invocations.map(({ role }) => role),
        roles,
      );
      return {
        summary: "Delegated independently",
        artifacts: [],
        evidence: [],
      };
    },
  };
  await coordinator.run(
    {
      invocation: { id: "fixture-coordinator" },
      task: "Coordinate",
      inputs: [],
    },
    port,
  );
});

test("delegation fixture replays a key, distinguishes a new key and rejects conflicting reuse", async () => {
  const { port } = hostFixture();
  const request: DelegateRequest = {
    idempotencyKey: "attempt-1",
    role: "Worker",
    task: "Prepare",
    inputs: [],
  };
  const first = await port.delegate(request);
  assert.deepEqual(await port.delegate({ ...request }), first);
  assert.notDeepEqual(
    await port.delegate({ ...request, idempotencyKey: "attempt-2" }),
    first,
  );
  await assert.rejects(
    port.delegate({ ...request, task: "Different task" }),
    /idempotency key conflict/,
  );
  assert.equal((await port.getStatus()).invocations.length, 2);
});

test("fake Worker has isolated writes and Reviewer consumes explicitly granted digest-bound evidence", async () => {
  const seed = new Map([["example.txt", "original"]]);
  const store = artifactStoreFixture();
  const first = sandboxFixture(seed, true, store);
  const second = sandboxFixture(seed, true, store);
  const worker: SandboxAgent<"Worker"> = {
    role: "Worker",
    async run(_input, sandbox) {
      await sandbox.writeWorkspace("example.txt", "changed");
      const artifact = await sandbox.publishArtifact(
        "example.txt",
        "text/plain",
      );
      return {
        summary: "Changed example",
        artifacts: [artifact],
        evidence: [artifact],
      };
    },
  };
  const result = await worker.run(
    {
      invocation: { id: "fixture-worker" },
      task: "Change example",
      inputs: [],
    },
    first.worker,
  );
  const [evidence] = result.evidence;
  assert.ok(evidence);
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal(await first.worker.readRepository("example.txt"), "changed");
  assert.equal(await second.worker.readRepository("example.txt"), "original");
  assert.equal(seed.get("example.txt"), "original");
  assert.equal("push" in first.worker, false);
  await assert.rejects(second.worker.readArtifact(evidence), /grant denied/);

  const review = sandboxFixture(seed, false, store, [evidence]);
  const reviewer: SandboxAgent<"Reviewer"> = {
    role: "Reviewer",
    async run(input, sandbox) {
      const [ref] = input.inputs;
      assert.ok(ref);
      assert.equal(
        new TextDecoder().decode(await sandbox.readArtifact(ref)),
        "changed",
      );
      await sandbox.writeScratch("review.txt", "Evidence inspected");
      const report = await sandbox.publishArtifact("review.txt", "text/plain");
      return {
        summary: "Reviewed changed bytes",
        artifacts: [report],
        evidence: [ref],
      };
    },
  };
  await reviewer.run(
    {
      invocation: { id: "fixture-reviewer" },
      task: "Review",
      inputs: [evidence],
    },
    review.port,
  );
  await assert.rejects(
    review.port.readArtifact({ ...evidence, sha256: "0".repeat(64) }),
    /grant denied/,
  );
});

test("Planner and Reviewer have scratch but cannot write repository or submit integration", async () => {
  for (const role of ["Planner", "Reviewer"] as const) {
    const fixture = sandboxFixture(
      new Map([["example.txt", "original"]]),
      false,
    );
    const agent: SandboxAgent<typeof role> = {
      role,
      async run(_input, sandbox) {
        assert.equal("writeWorkspace" in sandbox, false);
        assert.equal("requestIntegration" in sandbox, false);
        await sandbox.writeScratch(
          "notes.txt",
          await sandbox.readRepository("example.txt"),
        );
        const evidence = await sandbox.publishArtifact(
          "notes.txt",
          "text/plain",
        );
        return {
          summary: `${role} notes`,
          artifacts: [evidence],
          evidence: [evidence],
        };
      },
    };
    await agent.run(
      { invocation: { id: `fixture-${role}` }, task: "Inspect", inputs: [] },
      fixture.port,
    );
    assert.equal(await fixture.port.readScratch("notes.txt"), "original");
    assert.throws(
      () => fixture.worker.writeWorkspace("example.txt", "forbidden"),
      /write denied/,
    );
    assert.equal(await fixture.port.readRepository("example.txt"), "original");
  }
});

test("human submission returns before an answer and task-wide status exposes the stable request ID", async () => {
  const fixture = hostFixture();
  const receipt = await fixture.port.askHuman({
    question: "Which approach?",
    evidence: [],
  });
  assert.deepEqual((await fixture.port.getStatus()).humanRequests, [
    { ...receipt, status: "pending" },
  ]);
  fixture.answerHuman(receipt.requestId, "Use approach A");
  assert.deepEqual((await fixture.port.getStatus()).humanRequests, [
    { ...receipt, status: "answered", answer: "Use approach A", evidence: [] },
  ]);
});

test("integration fixture submits immutable candidate/base for host approval and supports replay only", async () => {
  const { port } = hostFixture();
  const source = await port.delegate({
    idempotencyKey: "prepare",
    role: "Worker",
    task: "Prepare patch",
    inputs: [],
  });
  const store = artifactStoreFixture();
  const request: IntegrationRequest = {
    idempotencyKey: "integrate-1",
    source,
    candidate: store.publish("candidate snapshot", "application/octet-stream"),
    expectedBase: store.publish("base snapshot", "application/octet-stream"),
    evidence: [store.publish("Tests passed", "text/plain")],
    reason: "Request review of candidate integration",
  };
  assert.equal(
    ROLE_CONTRACTS.Coordinator.integration,
    "submit-for-human-approval",
  );
  const receipt = await port.requestIntegration(request);
  assert.deepEqual(receipt, {
    status: "pending-human-approval",
    requestId: "fixture-integration-1",
  });
  assert.deepEqual(await port.requestIntegration({ ...request }), receipt);
  assert.notDeepEqual(
    await port.requestIntegration({
      ...request,
      idempotencyKey: "integrate-2",
    }),
    receipt,
  );
  await assert.rejects(
    port.requestIntegration({ ...request, expectedBase: request.candidate }),
    /idempotency key conflict/,
  );
  assert.equal((await port.getStatus()).integrations.length, 2);
  assert.equal((await port.getInvocation(source)).status, "queued");
  // No agent method can approve or execute. These remain separate trusted host duties.
  assert.equal("approve" in port, false);
  assert.equal("integrate" in port, false);
});
