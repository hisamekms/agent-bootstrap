import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { WorkplaceChannel } from "./channel.ts";
import { element } from "./dom.ts";
import { createHostPanel } from "./panel.ts";
import {
  chunkInput,
  clampSize,
  decodeBase64,
  encodeBase64,
} from "./protocol.ts";

let token = location.hash.slice(1);
history.replaceState(history.state, "", location.pathname + location.search);

const workplace = element("workplace");
const conversation = element("conversation");
const terminal = element("terminal");
const host = element("host");
const divider = element("divider");
const connection = element("connection");
const terminalNotice = element("terminal-notice");

const term = new Terminal({
  allowProposedApi: true,
  disableStdin: true,
  linkHandler: { activate() {} },
  // xterm's default (Courier New first) draws block and box characters
  // wider than one cell on macOS, which breaks banners. Menlo keeps them
  // at one cell.
  fontFamily: 'Menlo, "DejaVu Sans Mono", Consolas, monospace',
  theme: { background: "#101419", foreground: "#eef2f8" },
});
for (const osc of [0, 1, 2, 4, 7, 8, 9, 10, 11, 12, 52, 104, 133, 777, 1337]) {
  term.parser.registerOscHandler(osc, () => true);
}
const fit = new FitAddon();
term.loadAddon(fit);
term.open(terminal);

function focusOtherRegion(event: KeyboardEvent, fromTerminal: boolean) {
  event.preventDefault();
  event.stopPropagation();
  if (event.type !== "keydown" || event.repeat) return;
  if (fromTerminal || conversation.hidden) host.focus();
  else term.focus();
}

term.attachCustomKeyEventHandler((event) => {
  if (event.key !== "F6") return true;
  focusOtherRegion(event, true);
  return false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "F6")
    focusOtherRegion(event, conversation.contains(document.activeElement));
});
conversation.addEventListener("click", () => {
  if (!conversation.contains(document.activeElement)) term.focus();
});
host.addEventListener("click", () => {
  if (!host.contains(document.activeElement))
    host.focus({ preventScroll: true });
});

let width = 50;
function moveDivider(value: number) {
  width = Math.min(80, Math.max(20, Math.round(value)));
  workplace.style.setProperty("--conversation-width", `${width}%`);
  divider.setAttribute("aria-valuenow", String(width));
}

divider.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  divider.setPointerCapture(event.pointerId);
});
divider.addEventListener("pointermove", (event) => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const bounds = workplace.getBoundingClientRect();
  if (bounds.width > 0)
    moveDivider(((event.clientX - bounds.left) / bounds.width) * 100);
});
divider.addEventListener("keydown", (event) => {
  const value = {
    ArrowLeft: width - 2,
    ArrowRight: width + 2,
    Home: 20,
    End: 80,
  }[event.key];
  if (value === undefined) return;
  event.preventDefault();
  moveDivider(value);
});

type TerminalState =
  "attaching" | "interactive" | "read-only" | "ended" | "unavailable";
let terminalState: TerminalState = "attaching";
const terminalLabels: Record<TerminalState, string> = {
  attaching: "接続しています",
  interactive: "入力できます",
  "read-only": "読み取り専用",
  ended: "終了",
  unavailable: "未接続",
};
let lastSize: ReturnType<typeof clampSize> | undefined;

function setTerminalState(state: TerminalState) {
  terminalState = state;
  term.options.disableStdin = state !== "interactive";
  element("connection-terminal").textContent = terminalLabels[state];
}

function fitTerminal() {
  if (conversation.hidden) return;
  fit.fit();
  if (!channel || terminalState !== "interactive") return;
  const size = clampSize(term.cols, term.rows);
  if (size.cols === lastSize?.cols && size.rows === lastSize.rows) return;
  lastSize = size;
  void channel.request("concierge.resize", size).catch((error: Error) => {
    lastSize = undefined;
    terminalError(error);
  });
}
new ResizeObserver(fitTerminal).observe(terminal);

function transferInput() {
  if (terminalState === "ended") return;
  setTerminalState("read-only");
  terminalNotice.textContent = "Read-only. Another client has Concierge input.";
}

function terminalError(error: Error) {
  if (error.message === "terminal-read-only") transferInput();
  else if (error.message !== "disconnected" && terminalState === "interactive")
    terminalNotice.textContent = "Could not send data to the Concierge.";
}

function sendInput(bytes: Uint8Array) {
  if (!channel || terminalState !== "interactive") return;
  for (const chunk of chunkInput(bytes)) {
    void channel
      .request("concierge.input", { data: encodeBase64(chunk) })
      .catch(terminalError);
  }
}

const encoder = new TextEncoder();
term.onData((text) => sendInput(encoder.encode(text)));
term.onBinary((bytes) =>
  sendInput(Uint8Array.from(bytes, (byte) => byte.charCodeAt(0))),
);

function openChannel() {
  return new WorkplaceChannel(({ method, params }) => {
    switch (method) {
      case "inbox.changed":
        void panel.refresh();
        break;
      case "concierge.output":
        term.write(decodeBase64(params.data));
        break;
      case "concierge.exit":
        setTerminalState("ended");
        terminalNotice.textContent =
          params.exitCode === null
            ? "Concierge exited without an exit code."
            : `Concierge exited (code ${params.exitCode}).`;
        break;
      case "concierge.notice":
        if (params.code === "input-transferred") transferInput();
        break;
    }
  });
}
const channel = token ? openChannel() : undefined;
const panel = createHostPanel(channel);

function connectionState(
  state: "connecting" | "connected" | "disconnected",
  label: string,
) {
  element("connection-dot").dataset.state = state;
  connection.title = label;
  connection.setAttribute("aria-label", `${label}。接続の詳細を開く`);
  element("connection-state").textContent = label;
}

element("connection-host").textContent = location.host;
setTerminalState(terminalState);
if (channel) {
  connectionState("connecting", "接続しています");
  channel.socket.addEventListener("open", () => {
    channel.socket.send(JSON.stringify({ token }));
    token = "";
    void channel
      .request("inbox.subscribe", {})
      .then(() => {
        connectionState("connected", "接続中");
        return panel.refresh();
      })
      .catch(() => {
        if (channel.socket.readyState === WebSocket.OPEN)
          connectionState("disconnected", "受信項目を購読できませんでした");
      });
    void channel
      .request("concierge.attach", {})
      .then(({ replay }) => {
        term.write(decodeBase64(replay));
        if (terminalState === "attaching") setTerminalState("interactive");
        fitTerminal();
      })
      .catch(() => {
        if (channel.socket.readyState === WebSocket.OPEN) {
          setTerminalState("unavailable");
          terminalNotice.textContent = "Concierge に接続できませんでした。";
        }
      });
  });
  channel.socket.addEventListener("close", () => {
    token = "";
    setTerminalState("ended");
    panel.disconnect();
    connectionState(
      "disconnected",
      "切断されました。再接続するにはホストから Workplace を開き直してください",
    );
  });
} else {
  connectionState("disconnected", "ホストから Workplace を開いてください");
  setTerminalState("unavailable");
}

const fullscreen = element("fullscreen");
function toggleFullscreen() {
  const full = workplace.classList.toggle("full");
  const moveFocus =
    full &&
    (conversation.contains(document.activeElement) ||
      document.activeElement === divider);
  conversation.hidden = divider.hidden = full;
  const label = full ? "全画面を終了" : "全画面にする";
  fullscreen.setAttribute("aria-pressed", String(full));
  fullscreen.setAttribute("aria-label", label);
  fullscreen.title = `${label}（F）`;
  if (moveFocus) fullscreen.focus();
  if (!full) requestAnimationFrame(fitTerminal);
}
fullscreen.addEventListener("click", toggleFullscreen);
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (
    event.key === "Escape" &&
    !conversation.contains(document.activeElement) &&
    !document.activeElement?.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false])",
    )
  ) {
    if (panel.closeSettings()) event.preventDefault();
    else if (conversation.hidden) {
      event.preventDefault();
      toggleFullscreen();
    }
  }
  if (
    event.key.toLowerCase() !== "f" ||
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  const focus = document.activeElement;
  if (
    conversation.contains(focus) ||
    focus?.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false])",
    )
  )
    return;
  event.preventDefault();
  toggleFullscreen();
});

const themeKey = "workplace-theme";
const themes = ["system", "light", "dark"] as const;
type Theme = (typeof themes)[number];
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
let preference: Theme = "system";
try {
  const saved = localStorage.getItem(themeKey);
  if (saved === "dark" || saved === "light") preference = saved;
} catch {
  // The theme still works when storage is unavailable.
}
function applyTheme() {
  const dark =
    preference === "dark" || (preference === "system" && systemTheme.matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
  for (const theme of themes)
    element(`theme-${theme}`).setAttribute(
      "aria-pressed",
      String(theme === preference),
    );
}
for (const theme of themes) {
  element(`theme-${theme}`).addEventListener("click", () => {
    preference = theme;
    applyTheme();
    try {
      localStorage.setItem(themeKey, theme);
    } catch {
      // Keep the current preference for this session.
    }
  });
}
systemTheme.addEventListener("change", applyTheme);
applyTheme();
