export function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing workplace element ${id}`);
  return node;
}

export function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  classes = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = classes;
  return node;
}

export function action(
  label: string,
  key: string,
  select: () => void,
  classes = "btn secondary",
) {
  const button = textElement("button", label, classes);
  button.type = "button";
  button.dataset.focusKey = key;
  button.addEventListener("click", select);
  return button;
}

export function group<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  classes: string,
  ...children: Node[]
) {
  const node = textElement(tag, "", classes);
  node.append(...children);
  return node;
}

export function sectionTitle(label: string) {
  return textElement("h3", label, "section-title");
}

export function restoreFocus(
  container: HTMLElement,
  render: () => void,
  fallback?: HTMLElement,
) {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && container.contains(active)
      ? active.dataset.focusKey
      : undefined;
  render();
  if (key && !active?.isConnected) {
    const replacement = Array.from(
      container.querySelectorAll<HTMLElement>("[data-focus-key]"),
    ).find(
      (node) => node.dataset.focusKey === key && !node.closest("[hidden]"),
    );
    (replacement ?? fallback)?.focus({ preventScroll: true });
  }
}
