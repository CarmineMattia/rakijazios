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

// The desktop app starts the runner the installers put on disk (Linux/macOS launcher, Windows .cmd).
const fn = (name) => src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const load = (name, pathMod) =>
  new Function("path", "process", `${fn(name)}; return ${name};`)(pathMod, { env: {}, platform: "linux" });

test("desktop finds the runner where install.sh / install.ps1 put it", async () => {
  const { posix, win32 } = await import("node:path");
  const lin = load("runnerCandidates", posix);
  assert.deepEqual(lin({ HOME: "/home/u" }, "linux"), [
    "/home/u/.local/bin/rakazo-runner",
    "/home/u/.local/share/rakijazios-runner/rakazo-runner",
  ]);
  assert.equal(lin({ HOME: "/home/u", RAKAZO_RUNNER_HOME: "/opt/rk" }, "darwin")[0], "/opt/rk/rakazo-runner");
  const win = load("runnerCandidates", win32);
  assert.deepEqual(win({ USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32"), [
    "C:\\Users\\u\\AppData\\Local\\Rakijazios\\runner\\rakazo-runner.cmd",
  ]);
  assert.deepEqual(win({ RAKAZO_RUNNER_HOME: "D:\\rk" }, "win32"), ["D:\\rk\\rakazo-runner.cmd"]);
});

test("desktop runs a Windows .cmd launcher through cmd.exe, others directly", () => {
  const spawnArgs = load("runnerSpawnArgs", null);
  assert.deepEqual(spawnArgs("/home/u/.local/bin/rakazo-runner", "linux"), { file: "/home/u/.local/bin/rakazo-runner", args: ["run"], windowsVerbatimArguments: false });
  const w = spawnArgs("C:\\Users\\u\\AppData\\Local\\Rakijazios\\runner\\rakazo-runner.cmd", "win32");
  assert.equal(w.file, "cmd.exe");
  assert.deepEqual(w.args, ["/d", "/s", "/c", '"C:\\Users\\u\\AppData\\Local\\Rakijazios\\runner\\rakazo-runner.cmd" run']);
  assert.equal(w.windowsVerbatimArguments, true);
});
