// The api serves the runner to installers from a fixed list (RUNNER_FILES in
// patches/api/local-runner-install.ts). Any runner file missing from that list breaks every
// install with ERR_MODULE_NOT_FOUND (it happened with host-tools.ts after PR #22). These checks
// read the sources directly, so they never skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const installSrc = read("patches/api/local-runner-install.ts");
const listSrc = /export const RUNNER_FILES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(installSrc)?.[1] ?? "";
const served = [...listSrc.matchAll(/\{\s*name:\s*"([^"]+)",\s*path:\s*"([^"]+)"\s*\}/g)].map((m) => ({ name: m[1], path: m[2] }));
const runnerSrc = readdirSync(new URL("../runner/src", import.meta.url)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

test("RUNNER_FILES parses", () => {
  assert.ok(served.length >= 10, `parsed ${served.length} entries`);
});

test("every non-test runner/src/*.ts is served by the installer", () => {
  const paths = new Set(served.map((f) => f.path));
  const missing = runnerSrc.filter((f) => !paths.has(`src/${f}`));
  assert.deepEqual(missing, [], `add to RUNNER_FILES: ${missing.join(", ")}`);
});

test("every served file exists, names are unique and match the file", () => {
  const names = served.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, "duplicate names");
  for (const f of served) {
    assert.doesNotThrow(() => read(`runner/${f.path}`), `runner/${f.path} does not exist`);
    assert.equal(f.path.split("/").pop(), f.name, `${f.name} -> ${f.path}`);
  }
  assert.ok(served.some((f) => f.path === "package.json"), "package.json is served");
  assert.ok(!served.some((f) => f.path.endsWith(".test.ts")), "tests are not served");
});

test("every relative import of a served file is served (incl. dynamic imports)", () => {
  const paths = new Set(served.map((f) => f.path));
  for (const f of served.filter((x) => x.path.endsWith(".ts"))) {
    const src = read(`runner/${f.path}`);
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const target = new URL(m[1], `file:///app/${f.path}`).pathname.replace(/^\/app\//, "");
      assert.ok(paths.has(target), `${f.path} imports ${m[1]} (${target}), which the installer does not serve`);
    }
  }
});

test("the runner needs no npm packages (the installer never runs npm install)", () => {
  const pkg = JSON.parse(read("runner/package.json"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], "runner/package.json dependencies");
  for (const f of runnerSrc) {
    const src = read(`runner/src/${f}`);
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"'./][^"']*)["']/g)) {
      assert.ok(m[1].startsWith("node:"), `runner/src/${f} imports the package "${m[1]}"`);
    }
  }
});

test("the desktop app looks for the runner where the installers put it", () => {
  const main = read("packages/desktop/src/main.cjs");
  // install.sh: $HOME/.local/bin/rakazo-runner -> $PREFIX/rakazo-runner (PREFIX default ~/.local/share/rakijazios-runner)
  assert.match(installSrc, /BIN_DIR="\\\$\{RAKAZO_RUNNER_BIN_DIR:-\$HOME\/\.local\/bin\}"/);
  assert.match(installSrc, /PREFIX="\\\$\{RAKAZO_RUNNER_HOME:-\$HOME\/\.local\/share\/rakijazios-runner\}"/);
  assert.match(main, /\.local\/bin\/rakazo-runner/);
  assert.match(main, /\.local\/share\/rakijazios-runner/);
  assert.match(main, /RAKAZO_RUNNER_HOME/);
  // install.ps1: %LOCALAPPDATA%\Rakijazios\runner\rakazo-runner.cmd
  assert.match(installSrc, /Join-Path \$env:LOCALAPPDATA 'Rakijazios\\\\runner'/);
  assert.match(installSrc, /'rakazo-runner\.cmd'/);
  assert.match(main, /LOCALAPPDATA/);
  assert.match(main, /rakazo-runner\.cmd/);
});
