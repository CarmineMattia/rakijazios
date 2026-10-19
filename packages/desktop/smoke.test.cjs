/**
 * Desktop shell smoke (P6) — no Electron required.
 * node --test packages/desktop/smoke.test.cjs
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

describe("desktop package smoke", () => {
  it("package.json declares electron entry", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.main, "src/main.cjs");
    assert.ok(pkg.devDependencies?.electron || pkg.dependencies?.electron);
    assert.ok(pkg.build?.appId);
  });

  it("main process loads without Electron (syntax check)", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/main.cjs"), "utf8");
    assert.match(src, /BrowserWindow/);
    assert.match(src, /Tray/);
    assert.match(src, /startRunner|runner/);
    // Stub electron so require() of main would fail if we loaded it — we only parse.
    new Function(src); // syntax
  });

  it("preload exposes limited bridge", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/preload.cjs"), "utf8");
    assert.match(src, /contextBridge|exports/);
  });

  it("auto-update stub mentioned in README or main", () => {
    const readme = fs.existsSync(path.join(ROOT, "README.md"))
      ? fs.readFileSync(path.join(ROOT, "README.md"), "utf8")
      : "";
    const main = fs.readFileSync(path.join(ROOT, "src/main.cjs"), "utf8");
    assert.ok(
      /update|auto-update|electron-updater/i.test(readme + main),
      "document or stub auto-update",
    );
  });
});
