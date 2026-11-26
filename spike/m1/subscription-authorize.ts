import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { siwcProvider, SiwcError } from "../../src/siwc.ts";

export {
  acceptCallback,
  forgetRefreshToken,
  loadRegistration,
  makeKeychain,
  runSubscription,
  verifyIdentity,
} from "../../src/siwc.ts";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const dogfoodRunner = fileURLToPath(
  new URL("../m5/dogfood.ts", import.meta.url),
);
const usage =
  "Usage: bun spike/m1/subscription-authorize.ts --authorize-and-run-m5 [--keychain] /absolute/path/to/msb /absolute/path/to/codex\n" +
  "       bun spike/m1/subscription-authorize.ts --forget";
class UsageError extends Error {}
async function runDogfood(
  msb: string,
  codex: string,
  home: string,
  token: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [dogfoodRunner, "--live", msb, codex], {
    // Only the non-secret M5 settings (and USER, for the keychain
    // lookup) pass through; the token goes on stdin.
    env: {
      PATH: "/usr/bin:/bin",
      MSB_HOME: home,
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) =>
            value !== undefined &&
            (name === "USER" ||
              /^M5_(ACTORS|DEBUG_WORKER|CLAUDE_(BINARY|MODEL|AUTH|KEYCHAIN))$/.test(
                name,
              )),
        ),
      ),
    },
    stdio: ["pipe", "inherit", "inherit"],
  });
  const cancel = () => child.kill("SIGTERM");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    child.stdin.on("error", () => {});
    child.stdin.end(token);
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal.throwIfAborted();
    assert.equal(status, 0);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function parseArgs(argv: readonly string[]) {
  const [optIn, ...args] = argv;
  if (optIn === "--forget" && args.length === 0) {
    return { forget: true } as const;
  }
  if (optIn === "--authorize-and-run") {
    throw new UsageError(
      "--authorize-and-run has been retired. Use --authorize-and-run-m5 for the audited gateway.",
    );
  }
  const useKeychain = args[0] === "--keychain";
  const positional = useKeychain ? args.slice(1) : args;
  const [msb, codex] = positional;
  if (
    optIn !== "--authorize-and-run-m5" ||
    positional.length !== 2 ||
    !msb?.startsWith("/") ||
    /[\0:\r\n]/.test(msb) ||
    !codex?.startsWith("/")
  ) {
    throw new UsageError(usage);
  }
  return { forget: false, useKeychain, msb, codex } as const;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.MSB_HOME;
  assert.ok(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.forget) assert.ok(home && home.startsWith("/"));
  if (options.forget || options.useKeychain)
    assert.ok(process.platform === "darwin");
  const provider = siwcProvider({
    checkout,
    report: console.log,
    warn: console.error,
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (options.forget) {
      process.exitCode = await provider.forget({ legacy: true });
      return;
    }
    await provider.runSmoke({
      useKeychain: options.useKeychain,
      signal: controller.signal,
      run: (token) =>
        runDogfood(options.msb, options.codex, home!, token, controller.signal),
      onUnconfirmedRevocation() {
        process.exitCode = 1;
      },
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof UsageError
        ? error.message
        : error instanceof SiwcError
          ? `${error.code}\nnext: ${error.next}`
          : "Sign in with ChatGPT stopped.",
    );
    process.exitCode = 1;
  }
}
