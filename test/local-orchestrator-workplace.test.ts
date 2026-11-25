import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkplaceAssets } from "../src/operator-ui/assets.ts";
import {
  runWorkplace,
  workplaceStop,
} from "../src/local-orchestrator/workplace.ts";
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

test("the first stop signal aborts and a second one exits at once", () => {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const stop = workplaceStop(signals, (code) => exits.push(code));
  assert.equal(stop.signal.aborted, false);
  signals.emit("SIGINT");
  assert.equal(stop.signal.aborted, true);
  assert.equal(stop.exitCode, 130);
  assert.deepEqual(exits, []);
  signals.emit("SIGTERM");
  assert.deepEqual(exits, [143]);
  stop.dispose();
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGHUP"), 0);
});

test("a closed lifeline stops the workplace as SIGTERM does", () => {
  const signals = new EventEmitter();
  const emitter = new EventEmitter();
  const lifeline = Object.assign(emitter, {
    destroyed: false,
    destroy() {
      lifeline.destroyed = true;
      emitter.emit("close");
    },
  });
  const stop = workplaceStop(signals, () => assert.fail(), lifeline);
  lifeline.emit("close");
  assert.equal(stop.signal.aborted, true);
  assert.equal(stop.exitCode, 143);
  stop.dispose();
  assert.equal(lifeline.destroyed, true);
});

test("disposing the stop control does not count as a stop", () => {
  const signals = new EventEmitter();
  const emitter = new EventEmitter();
  const lifeline = Object.assign(emitter, {
    destroy() {
      emitter.emit("close");
    },
  });
  const stop = workplaceStop(signals, () => assert.fail(), lifeline);
  stop.dispose();
  assert.equal(stop.signal.aborted, false);
  assert.equal(stop.exitCode, undefined);
});
