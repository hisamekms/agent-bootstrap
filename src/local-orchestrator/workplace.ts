import { parseConciergeArgs } from "./concierge.ts";
import {
  createConciergeTerminalHub,
  type ConciergeTerminalHub,
} from "./concierge-terminal.ts";
import { startDevBridge } from "./dev-bridge.ts";
import { listenOperatorApi } from "./operator-api.ts";

export function parseWorkplaceArgs(args: readonly string[]) {
  const flags = parseConciergeArgs(args, true);
  if (!flags.target || flags.run || "volumeShell" in flags)
    throw new Error("Invalid workplace arguments");
  return {
    ...flags,
    target: flags.target,
    devBridge: flags.devBridge === true,
  };
}

export async function runWorkplace<T>(
  options: Omit<Parameters<typeof listenOperatorApi>[0], "terminal">,
  run: (
    terminal: ConciergeTerminalHub,
    stopOperatorWrites: () => Promise<void>,
  ) => Promise<T>,
  dev?: {
    loadAssets(): Promise<Parameters<typeof startDevBridge>[0]["assets"]>;
    printUrl(url: string): void;
  },
) {
  const terminal = createConciergeTerminalHub();
  const api = await listenOperatorApi({ ...options, terminal });
  let bridge: ReturnType<typeof startDevBridge> | undefined;
  try {
    if (dev) {
      bridge = startDevBridge({
        api: api.path,
        assets: await dev.loadAssets(),
      });
      dev.printUrl(bridge.url);
    }
    return await run(terminal, api.stopWrites);
  } finally {
    try {
      await api.stopWrites();
      await options.environment?.close();
    } finally {
      try {
        await bridge?.close(true);
      } finally {
        await api.close();
      }
    }
  }
}

type Listener = () => void;

/** Stop control for a workplace launcher. The first SIGINT, SIGTERM or
 * SIGHUP aborts for an audited shutdown. A second one exits at once, for a
 * cleanup that hangs. When the parent's lifeline closes, the parent is gone
 * (even after SIGKILL), so the launcher stops as for SIGTERM. */
export function workplaceStop(
  signals: {
    on(event: NodeJS.Signals, listener: Listener): unknown;
    off(event: NodeJS.Signals, listener: Listener): unknown;
  },
  forceExit: (code: number) => void,
  lifeline?: {
    once(event: "close", listener: Listener): unknown;
    destroy(): void;
  },
) {
  const controller = new AbortController();
  let exitCode: number | undefined;
  let disposed = false;
  const stop = (code: number) => {
    if (disposed) return;
    if (exitCode !== undefined) {
      forceExit(code);
      return;
    }
    exitCode = code;
    controller.abort();
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", terminate);
  signals.on("SIGHUP", terminate);
  lifeline?.once("close", terminate);
  return {
    signal: controller.signal,
    stop() {
      if (exitCode === undefined) stop(0);
    },
    get exitCode() {
      return exitCode;
    },
    dispose() {
      disposed = true;
      signals.off("SIGINT", interrupt);
      signals.off("SIGTERM", terminate);
      signals.off("SIGHUP", terminate);
      lifeline?.destroy();
    },
  };
}
