export function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

export function action(label: string, key: string, select: () => void) {
  const button = textElement("button", label);
  button.type = "button";
  button.dataset.focusKey = key;
  button.addEventListener("click", select);
  return button;
}
