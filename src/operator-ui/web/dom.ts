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
  if (key && active !== document.activeElement) {
    const replacement = Array.from(
      container.querySelectorAll<HTMLElement>("[data-focus-key]"),
    ).find(
      (node) => node.dataset.focusKey === key && !node.closest("[hidden]"),
    );
    (replacement ?? fallback)?.focus({ preventScroll: true });
  }
}

export function disclosure(
  button: HTMLElement,
  panel: HTMLElement,
  onClose = () => {},
) {
  function close(restore = true) {
    if (panel.hidden) return false;
    const restoreFocus = restore && panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    onClose();
    if (restoreFocus) button.focus({ preventScroll: true });
    return true;
  }
  // WebKit does not focus a clicked button, so a click inside the panel can
  // report focus leaving it. Ignore focusout while a pointer is down inside.
  let pointerInside = false;
  panel.addEventListener("pointerdown", () => {
    pointerInside = true;
  });
  document.addEventListener("pointerup", () => {
    queueMicrotask(() => {
      pointerInside = false;
    });
  });
  document.addEventListener("pointercancel", () => {
    pointerInside = false;
  });
  panel.addEventListener("focusout", ({ relatedTarget }) => {
    if (pointerInside) return;
    if (relatedTarget instanceof Node) {
      if (!panel.contains(relatedTarget)) close(false);
      return;
    }
    // Rendering may temporarily detach and then restore the focused control.
    queueMicrotask(() => {
      if (panel.contains(document.activeElement)) return;
      close(false);
    });
  });
  button.addEventListener("pointerdown", (event) => {
    // Let the click close an open panel without a focusout first toggling it.
    if (!panel.hidden && event.button === 0) event.preventDefault();
  });
  document.addEventListener("pointerdown", ({ target }) => {
    if (
      target instanceof Node &&
      !button.contains(target) &&
      !panel.contains(target)
    )
      close();
  });
  return {
    close,
    toggle() {
      if (close()) return;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      panel.focus({ preventScroll: true });
    },
  };
}
