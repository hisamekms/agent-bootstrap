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
  const js = read("/app.js", "text/javascript; charset=utf-8");
  assert.match(js, /adoptedStyleSheets/);
  assert.doesNotMatch(
    js,
    /(?:createElement|setAttribute)\(["']style["']|\beval\s*\(|\bnew Function\s*\(/,
  );
  const css = read("/app.css", "text/css; charset=utf-8");
  assert.match(css, /\.xterm-helper-textarea\b/);
  assert.doesNotMatch(css, /@import\b/i);
});
