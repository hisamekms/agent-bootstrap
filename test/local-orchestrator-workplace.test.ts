import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkplaceAssets } from "../src/local-orchestrator/workplace-assets.ts";
import { runWorkplace } from "../src/local-orchestrator/workplace.ts";
import { orchestratorFixture } from "./local-orchestrator-fixture.ts";

test(
  "workplace keeps the API and optional bridge open until Concierge exits",
  { timeout: 5000 },
  async () => {
    using fixture = orchestratorFixture("lo-work-", realpathSync("/tmp"));
    const { root, store } = fixture;
    const options = { stateDirectory: root, store, target: "/fixture" };
    const socket = join(root, "operator", "api.sock");
    const urls: string[] = [];
    const ready = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<{ exitCode: number }>();
    const started = runWorkplace(
      options,
      async (hub) => {
        hub.start({
          terminal: { write() {}, resize() {} },
          finished: finished.promise,
        });
        ready.resolve();
        return finished.promise;
      },
      {
        loadAssets: loadWorkplaceAssets,
        printUrl(url) {
          urls.push(url);
        },
      },
    );
    try {
      await Promise.race([ready.promise, started]);
      assert.ok(existsSync(socket));
      assert.equal(urls.length, 1);
      assert.equal((await fetch(new URL(urls[0]!))).status, 200);
      await assert.rejects(
        runWorkplace(options, async () =>
          assert.fail("started a second session"),
        ),
        /already running/,
      );
    } finally {
      finished.resolve({ exitCode: 7 });
      assert.deepEqual(await started, { exitCode: 7 });
    }
    assert.equal(existsSync(socket), false);
    await assert.rejects(fetch(new URL(urls[0]!)));
  },
);

test(
  "workplace closes the API when bridge asset loading fails",
  { timeout: 5000 },
  async () => {
    using fixture = orchestratorFixture("lo-work-", realpathSync("/tmp"));
    const { root, store } = fixture;
    await assert.rejects(
      runWorkplace(
        { stateDirectory: root, store, target: "/fixture" },
        async () => assert.fail("unexpected Concierge launch"),
        {
          async loadAssets() {
            throw new Error("assets unavailable");
          },
          printUrl: () => assert.fail("unexpected URL"),
        },
      ),
      /assets unavailable/,
    );
    assert.equal(existsSync(join(root, "operator", "api.sock")), false);
  },
);
