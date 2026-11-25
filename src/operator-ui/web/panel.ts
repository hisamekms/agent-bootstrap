import type { InboxItem } from "../../local-orchestrator/inbox.ts";
import type { WorkplaceChannel } from "./channel.ts";
import { orderInbox } from "./protocol.ts";

export function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing workplace element ${id}`);
  return node;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

const subjectLabels = {
  goalId: "Goal ID",
  taskId: "Task ID",
  proposalId: "Proposal ID",
  executionId: "Execution ID",
} as const;

export function createHostPanel(channel: WorkplaceChannel) {
  const inbox = element("inbox-items");
  const details = element("details");
  const notice = element("inbox-notice");
  let buttons = new Map<string, HTMLButtonElement>();
  let selected: InboxItem | undefined;
  let previousItems = "";
  let loading = false;
  let refreshNeeded = false;
  const marking = new Set<string>();
  const observed = new Map<Element, string>();
  const visible = new IntersectionObserver(
    (entries) => {
      const ids: string[] = [];
      for (const { target, intersectionRatio } of entries) {
        const id = observed.get(target);
        if (intersectionRatio < 0.1 || !id || marking.has(id)) continue;
        marking.add(id);
        ids.push(id);
        visible.unobserve(target);
      }
      if (!ids.length) return;
      void channel
        .request("inbox.markSeen", { ids })
        .catch(() => {
          notice.textContent = "Could not mark inbox items seen.";
        })
        .finally(() => ids.forEach((id) => marking.delete(id)));
    },
    { root: element("inbox"), threshold: 0.1 },
  );

  async function select(item: InboxItem) {
    if (selected)
      buttons.get(selected.id)?.setAttribute("aria-pressed", "false");
    selected = item;
    buttons.get(item.id)?.setAttribute("aria-pressed", "true");

    const fields = document.createElement("dl");
    function field(label: string, value: string) {
      const content = textElement("dd", value);
      fields.append(textElement("dt", label), content);
      return content;
    }
    const proposalInfo = textElement("p", "");
    details.replaceChildren(
      textElement("h3", item.title),
      fields,
      proposalInfo,
    );
    const kind = field("Kind", item.kind);
    for (const [key, label] of Object.entries(subjectLabels)) {
      const id = item.subject[key as keyof InboxItem["subject"]];
      if (id) field(label, id);
    }

    const command = textElement("pre", item.next);
    const copy = textElement("button", "Copy CLI command");
    copy.type = "button";
    const copyStatus = textElement("p", "");
    copyStatus.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.next);
        copyStatus.textContent = "Command copied.";
      } catch {
        copyStatus.textContent = "Could not copy the command.";
      }
    });
    details.append(command, copy, copyStatus);
    if (item.modelText !== undefined) {
      const model = document.createElement("div");
      model.className = "model-text";
      model.append(
        textElement("h3", "untrusted model text"),
        textElement("pre", item.modelText),
      );
      details.append(model);
    }

    if (!item.subject.proposalId) return;
    proposalInfo.textContent = "Loading proposal…";
    proposalInfo.setAttribute("role", "status");
    try {
      const proposal = await channel.request("proposal.get", {
        id: item.subject.proposalId,
      });
      kind.textContent = proposal.kind;
      field("Pinned digest", proposal.digest);
      proposalInfo.remove();
    } catch {
      proposalInfo.textContent = "Could not load the proposal.";
    }
  }

  function render(items: InboxItem[]) {
    const snapshot = JSON.stringify(items);
    if (snapshot === previousItems) return;
    previousItems = snapshot;
    const ordered = orderInbox(items);
    const focused = [...buttons].find(
      ([, button]) => button === document.activeElement,
    );
    const current = ordered.find(({ id }) => id === selected?.id);
    if (!current) {
      selected = undefined;
      details.replaceChildren();
    }
    visible.disconnect();
    observed.clear();
    buttons = new Map();
    const rows = ordered.map((item) => {
      const row = document.createElement("li");
      const button = textElement("button", item.title);
      button.type = "button";
      button.setAttribute("aria-pressed", String(item.id === selected?.id));
      button.addEventListener("click", () => void select(item));
      row.append(
        textElement("small", item.weight === "action" ? "Action" : "Info"),
        button,
      );
      buttons.set(item.id, button);
      if (item.state === "open") observed.set(button, item.id);
      return row;
    });
    inbox.replaceChildren(...rows);
    element("empty-inbox").hidden = rows.length !== 0;
    for (const button of observed.keys()) visible.observe(button);
    if (focused)
      (buttons.get(focused[0]) ?? element("host")).focus({
        preventScroll: true,
      });
    if (current && selected) {
      const { state: _previousState, ...before } = selected;
      const { state: _currentState, ...after } = current;
      if (JSON.stringify(before) !== JSON.stringify(after))
        void select(current);
    }
  }

  return {
    async refresh() {
      refreshNeeded = true;
      if (loading) return;
      loading = true;
      do {
        refreshNeeded = false;
        const [status, items] = await Promise.allSettled([
          channel.request("status", {}),
          channel.request("inbox.list", {}),
        ]);
        if (status.status === "fulfilled") {
          const { goals, tasks } = status.value.counts;
          element("counts").textContent = `Goals ${goals} · Tasks ${tasks}`;
        }
        if (items.status === "fulfilled") render(items.value);
        notice.textContent =
          status.status === "rejected" || items.status === "rejected"
            ? "Could not refresh host status or inbox."
            : "";
      } while (refreshNeeded);
      loading = false;
    },
    disconnect() {
      visible.disconnect();
    },
  };
}
