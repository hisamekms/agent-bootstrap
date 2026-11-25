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
  run: (terminal: ConciergeTerminalHub) => Promise<T>,
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
    return await run(terminal);
  } finally {
    try {
      await bridge?.close();
    } finally {
      await api.close();
    }
  }
}
