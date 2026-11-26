import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkplaceAssets } from "../src/operator-ui/assets.ts";

test("the workplace serves three self-contained assets under its strict CSP", async () => {
  const assets = await loadWorkplaceAssets();
  assert.deepEqual([...assets.keys()].sort(), [
    "/app.css",
    "/app.js",
    "/index.html",
  ]);
  const decoder = new TextDecoder();
  function read(path: string, contentType: string) {
    const asset = assets.get(path);
    assert.ok(asset);
    assert.equal(asset.contentType, contentType);
    assert.ok(asset.body instanceof Uint8Array);
    const text = decoder.decode(asset.body);
    assert.doesNotMatch(text, /https?:/, path);
    return text;
  }

  const html = read("/index.html", "text/html; charset=utf-8");
  assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi), [
    '<script type="module" src="/app.js"></script>',
  ]);
  assert.deepEqual(html.match(/<link\b[^>]*>/gi), [
    '<link rel="stylesheet" href="/app.css" />',
  ]);
  assert.doesNotMatch(html, /<style\b|\s(?:style|on[a-z]+)\s*=/i);
  assert.match(html, /id="host-tabs" role="tablist"/);
  assert.deepEqual(
    [
      ...html.matchAll(
        /<button[^>]*id="tab-([^"]+)"[^>]*role="tab"[^>]*aria-controls="([^"]+)"/g,
      ),
    ].map(([, tab, panel]) => [tab, panel]),
    [
      ["decisions", "decisions"],
      ["problems", "problems"],
      ["goals", "goals"],
    ],
  );
  for (const id of ["terminal-notice", "inbox-notice", "answer-results"])
    assert.match(html, new RegExp(`id="${id}" role="status"`));
  assert.match(
    html,
    /id="settings-toggle"[^>]*aria-pressed="false"[^>]*aria-controls="settings"/,
  );
  assert.match(
    html,
    /id="now-toggle"[^>]*aria-controls="now-popover"[^>]*aria-expanded="false"[^>]*aria-haspopup="dialog"/,
  );
  assert.match(
    html,
    /id="now-popover"[^>]*role="dialog"[^>]*tabindex="-1"[^>]*hidden/,
  );
  assert.ok(html.indexOf('id="now-toggle"') < html.indexOf('id="fullscreen"'));
  assert.match(html, /id="theme-system" aria-pressed="true"/);
  for (const id of [
    "connection-project",
    "connection-repository",
    "connection-reconnect",
  ])
    assert.match(html, new RegExp(`id="${id}"`));
  const js = read("/app.js", "text/javascript; charset=utf-8");
  assert.match(js, /adoptedStyleSheets/);
  assert.match(js, /AI の記述/);
  assert.match(js, /読んだ内容で確定します/);
  assert.match(js, /activity\.subscribe/);
  assert.match(js, /activity\.changed/);
  assert.match(js, /内容が変わりました。もう一度確認してください/);
  assert.match(js, /資格情報のような文字列を含むため隠しました/);
  assert.doesNotMatch(
    js,
    /(?:createElement|setAttribute)\(["']style["']|\beval\s*\(|\bnew Function\s*\(/,
  );
  const css = read("/app.css", "text/css; charset=utf-8");
  assert.match(css, /\.proposal-text\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(css, /\.xterm-helper-textarea\b/);
  assert.doesNotMatch(css, /@import\b/i);
});
