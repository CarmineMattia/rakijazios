// The desktop shell must not turn host tools on behind the user's back (H1) and must only hand
// http(s) links to the OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../packages/desktop/src/main.cjs", import.meta.url), "utf8");

test("desktop does not force RAKAZO_HOST_TOOLS on", () => {
  assert.doesNotMatch(src, /RAKAZO_HOST_TOOLS\s*:\s*["']1["']/);
});

test("desktop opens only http(s) links externally", () => {
  const isWebUrl = new Function(`${src.match(/function isWebUrl\(url\) \{[\s\S]*?\n\}/)[0]}; return isWebUrl;`)();
  assert.equal(isWebUrl("https://example.com/x"), true);
  assert.equal(isWebUrl("http://127.0.0.1:5173/"), true);
  for (const bad of ["file:///etc/passwd", "smb://host/share", "javascript:alert(1)", "vscode://x", "not a url"]) {
    assert.equal(isWebUrl(bad), false, bad);
  }
  assert.match(src, /if \(isWebUrl\(url\)\) shell\.openExternal\(url\)/);
});
