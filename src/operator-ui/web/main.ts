import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { WorkplaceChannel } from "./channel.ts";
import { createHostPanel, element } from "./panel.ts";
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
  if (fromTerminal) host.focus();
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

let width = 60;
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

type TerminalState = "attaching" | "interactive" | "read-only" | "ended";
let terminalState: TerminalState = "attaching";
let lastSize: ReturnType<typeof clampSize> | undefined;

function setTerminalState(state: TerminalState) {
  terminalState = state;
  term.options.disableStdin = state !== "interactive";
}

function fitTerminal() {
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

function connect() {
  const channel = new WorkplaceChannel(({ method, params }) => {
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
  const panel = createHostPanel(channel);
  channel.socket.addEventListener("open", () => {
    channel.socket.send(JSON.stringify({ token }));
    token = "";
    void channel
      .request("inbox.subscribe", {})
      .then(() => {
        connection.textContent = "Connected";
        return panel.refresh();
      })
      .catch(() => {
        if (channel.socket.readyState === WebSocket.OPEN)
          connection.textContent = "Could not subscribe to the inbox.";
      });
    void channel
      .request("concierge.attach", {})
      .then(({ replay }) => {
        term.write(decodeBase64(replay));
        if (terminalState === "attaching") setTerminalState("interactive");
        fitTerminal();
      })
      .catch(() => {
        if (channel.socket.readyState === WebSocket.OPEN)
          terminalNotice.textContent =
            "Could not attach the Concierge terminal.";
      });
  });
  channel.socket.addEventListener("close", () => {
    token = "";
    setTerminalState("ended");
    panel.disconnect();
    connection.textContent =
      "Disconnected. Reopen the workplace URL to reconnect.";
  });
  return channel;
}

const channel = token ? connect() : undefined;
if (!channel) connection.textContent = "Open the workplace URL from the host.";
