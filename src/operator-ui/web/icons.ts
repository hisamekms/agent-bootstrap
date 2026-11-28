import { group } from "./dom.ts";

const paths = {
  flag: "M5 21V3h14l-3 5 3 5H5",
  checklist: "M9 6h11M9 12h11M9 18h11M3 5l1 1 2-2M3 11l1 1 2-2M3 17l1 1 2-2",
  merge:
    "M6 5a2 2 0 1 0 0 .01M6 21a2 2 0 1 0 0 .01M20 5a2 2 0 1 0 0 .01M4 7v12m14-12c0 7-14 3-14 12",
  pullRequest:
    "M6 4a2 2 0 1 0 0 .01M6 20a2 2 0 1 0 0 .01M20 20a2 2 0 1 0 0 .01M4 6v12m14 0v-7a5 5 0 0 0-5-5h-2m3-3-3 3 3 3",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  chevron: "m6 9 6 6 6-6",
  external: "M7 17 17 7M9 7h8v8",
  check: "m5 12 4 4L19 6",
  cross: "m6 6 12 12M18 6 6 18",
  file: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6",
  tasks: "M6 3h14v14M3 7h14v14H3zM6 12l2 2 4-4",
  folder: "M3 6h7l2 3h9v11H3z",
  warning: "M12 3 2 21h20zM12 9v5m0 3h.01",
  robot: "M4 8h16v12H4zM12 4v4m-2-4h4M1 13h3m16 0h3M8 12v2m8-2v2m-6 3h4",
  hourglass: "M5 3h14M5 21h14M7 3v5l10 8v5m0-18v5L7 16v5",
  person: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21v-2a8 6 0 0 1 16 0v2",
  stop: "M8 3h8l5 5v8l-5 5H8l-5-5V8zM8 8l8 8m0-8-8 8",
  idle: "M9 6v12m6-12v12",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2",
  start: "m7 4 13 8-13 8z",
  approved: "M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6zM8 12l3 3 5-6",
  rejected: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM6 6l12 12",
  export: "M13 4h7v7m0-7-9 9m-1-8H4v15h15v-6",
  circle: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z",
  plus: "M6 12h12m-6-6v12",
  minus: "M6 12h12",
} as const;

export type Icon = keyof typeof paths;

export function icon(name: Icon) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    class: "visual-icon",
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}

export function visual(
  name: Icon,
  label: string,
  classes = "",
  ...content: (Node | string)[]
) {
  const node = group("span", `visual ${classes}`, icon(name));
  node.append(...content);
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", label);
  node.title = label;
  return node;
}
