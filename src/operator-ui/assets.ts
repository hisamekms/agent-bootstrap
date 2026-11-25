import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Asset {
  contentType: string;
  body: Uint8Array;
}

declare const Bun: {
  build(options: {
    entrypoints: string[];
    target: "browser";
    minify: boolean;
    plugins: {
      name: string;
      setup(builder: {
        onLoad(
          options: { filter: RegExp },
          load: (args: { path: string }) => Promise<{
            contents: string;
            loader: "js";
          }>,
        ): void;
      }): void;
    }[];
  }): Promise<{ outputs: (Blob & { path: string })[] }>;
};

function replaceOnce(source: string, before: string, after: string): string {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0)
    throw new Error("Unexpected xterm styling code");
  return source.replace(before, after);
}

// xterm 6's DOM renderer inserts inline style elements. Adopt constructed
// stylesheets instead so the same generated rules work under style-src 'self'.
// Apply per-cell colors through CSSOM for the same reason.
function adaptXtermStyles(source: string): string {
  for (const [before, after] of [
    [
      'n.mainDocument.createElement("style"),i.appendChild(this._styleElement)',
      "createWorkplaceStyles(i.ownerDocument)",
    ],
    ...["_dimensionsStyleElement", "_themeStyleElement"].map(
      (field) =>
        [
          `this._document.createElement("style"),this._screenElement.appendChild(this.${field})`,
          "createWorkplaceStyles(this._document)",
        ] as const,
    ),
  ] as const) {
    source = replaceOnce(source, before, after);
  }
  source = replaceOnce(
    source,
    't.setAttribute("style",`${t.getAttribute("style")||""}${e};`)',
    'const colon=e.indexOf(":");t.style.setProperty(e.slice(0,colon),e.slice(colon+1))',
  );
  return `
function createWorkplaceStyles(document) {
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets.push(sheet);
  return {
    set textContent(css) { sheet.replaceSync(css); },
    remove() {
      const sheets = document.adoptedStyleSheets;
      const index = sheets.indexOf(sheet);
      if (index !== -1) sheets.splice(index, 1);
    },
  };
}
${source}`;
}

function escapeXtermLiterals(script: string): string {
  // Keep xterm's protocol checks and DOM namespace identifiers intact.
  return script.replace(
    /"(?:https?:|http:\/\/www\.w3\.org\/(?:1999\/xhtml|2000\/svg))"/g,
    (literal) => literal.replace(":", "\\x3a"),
  );
}

const web = new URL("../../src/operator-ui/web/", import.meta.url);
const licensePaths = [
  "../../node_modules/@xterm/xterm/LICENSE",
  "../../node_modules/@xterm/addon-fit/LICENSE",
];

export async function loadWorkplaceAssets(): Promise<
  ReadonlyMap<string, Asset>
> {
  const [{ outputs }, html, ...licenses] = await Promise.all([
    Bun.build({
      entrypoints: ["main.ts", "app.css"].map((name) =>
        fileURLToPath(new URL(name, web)),
      ),
      target: "browser",
      minify: true,
      plugins: [
        {
          name: "workplace-xterm-styles",
          setup(builder) {
            builder.onLoad(
              { filter: /@xterm\/xterm\/lib\/xterm\.mjs$/ },
              async ({ path }) => ({
                loader: "js",
                contents: adaptXtermStyles(await readFile(path, "utf8")),
              }),
            );
          },
        },
      ],
    }),
    readFile(new URL("index.html", web), "utf8"),
    ...licensePaths.map((path) =>
      readFile(new URL(path, import.meta.url), "utf8"),
    ),
  ]);
  const js = outputs.find(({ path }) => path.endsWith("/main.js"));
  const css = outputs.find(({ path }) => path.endsWith("/app.css"));
  if (!js || !css || outputs.length !== 2)
    throw new Error("Unexpected workplace bundle outputs");

  const [script, styles] = await Promise.all([js.text(), css.text()]);
  const notice = (texts: readonly string[]) =>
    `/*!\n${texts.join("\n").replaceAll("https://", "//")}\n*/\n`;
  const encoder = new TextEncoder();
  function asset(contentType: string, content: string): Asset {
    if (/https?:/.test(content))
      throw new Error("Workplace asset contains an HTTP URL or protocol");
    return { contentType, body: encoder.encode(content) };
  }
  return new Map([
    ["/index.html", asset("text/html; charset=utf-8", html)],
    [
      "/app.js",
      asset(
        "text/javascript; charset=utf-8",
        notice(licenses) + escapeXtermLiterals(script),
      ),
    ],
    [
      "/app.css",
      asset("text/css; charset=utf-8", notice(licenses.slice(0, 1)) + styles),
    ],
  ]);
}
