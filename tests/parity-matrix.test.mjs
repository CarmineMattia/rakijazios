/**
 * Parity capability matrix vs Grok Bot surfaces (P0–P9).
 * Pure/static checks: routes, overlays, runner modules, desktop shell.
 * Run: node --test tests/parity-matrix.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const GROK_SURFACES = [
  { id: "P0", name: "Tool permissions always/ask/never", files: ["patches/api/host-tool-permissions.ts", "patches/api/host-tool-control.ts"] },
  { id: "P0", name: "M2b bot→computer/model bind", files: ["patches/api/local-runner-control.ts"] },
  { id: "P1", name: "Host shell/file tools", files: ["runner/src/host-tools.ts", "patches/api/host-tool-bridge.ts", "patches/api/host-tool-try.ts"] },
  { id: "P1", name: "permissions.json local mirror", files: ["runner/src/permissions.ts"] },
  { id: "P2", name: "Routines list/pause/resume/run-now", files: ["patches/api/parity-routes.ts"] },
  { id: "P3", name: "Background shells + transcripts", files: ["patches/api/parity-routes.ts", "runner/src/host-tools.ts"] },
  { id: "P4", name: "MCP catalog + secrets", files: ["patches/api/parity-routes.ts"] },
  { id: "P5", name: "Computer-use Linux drivers", files: ["runner/src/host-tools.ts"] },
  { id: "P6", name: "Desktop Electron shell", files: ["packages/desktop/src/main.cjs", "packages/desktop/package.json"] },
  { id: "P7", name: "Marketplace publish + add-to-chat", files: ["patches/api/parity-routes.ts"] },
  { id: "P8", name: "Auth password/passkey status", files: ["patches/api/parity-routes.ts"] },
  { id: "P9", name: "i18n catalog", files: ["patches/api/parity-routes.ts"] },
  { id: "UI", name: "Parity overlays", files: ["patches/web/dist/parity-overlays.js"] },
];

describe("parity file presence", () => {
  for (const surface of GROK_SURFACES) {
    it(`${surface.id}: ${surface.name}`, () => {
      for (const f of surface.files) {
        assert.ok(existsSync(join(ROOT, f)), `missing ${f}`);
      }
    });
  }
});

describe("parity API route surface", () => {
  const routes = read("patches/api/parity-routes.ts");

  const required = [
    "/api/parity/bots/:botId/routines",
    "/api/parity/bots/:botId/routines/:routineId/pause",
    "/api/parity/bots/:botId/routines/:routineId/resume",
    "/api/parity/bots/:botId/routines/:routineId/run-now",
    "/api/parity/bots/:botId/transcripts",
    "/api/parity/transcripts/:id",
    "/api/parity/background-shells",
    "/api/parity/background-shells/:id/kill",
    "/api/parity/background-shells/:id/send-input",
    "/api/parity/mcp/catalog",
    "/api/parity/secrets",
    "/api/parity/devices/:deviceId/computer-use",
    "/api/parity/marketplace",
    "/api/parity/bots/:botId/publish",
    "/api/parity/marketplace/:botId/add-to-chat",
    "/api/parity/auth/status",
    "/api/parity/i18n",
    "/api/parity/desktop/manifest",
  ];

  for (const path of required) {
    it(`defines ${path}`, () => {
      // Route templates use string literals; match the static path segments.
      const needle = path.replace(/:[^/]+/g, "");
      assert.ok(routes.includes(path.split("/:")[0]) || routes.includes(path), `route missing: ${path}`);
      // Stronger: ensure distinctive last segment exists with /api/parity prefix context
      const parts = path.split("/");
      const last = parts[parts.length - 1];
      if (!last.startsWith(":")) {
        assert.ok(routes.includes(`"${path}"`) || routes.includes(`'${path}'`) || routes.includes(path), needle);
      } else {
        const parent = parts.slice(0, -1).join("/");
        assert.ok(routes.includes(parent), `parent ${parent}`);
      }
    });
  }
});

describe("host-tools runner capabilities", () => {
  const src = read("runner/src/host-tools.ts");

  const actions = [
    "run-command",
    "read-file",
    "write-file",
    "list-directory",
    "computer-screenshot",
    "computer-click",
    "computer-type",
    "computer-key",
    "computer-scroll",
    "computer-wait",
    "computer-apps",
    "send-input",
    "kill-shell",
  ];

  for (const action of actions) {
    it(`implements ${action}`, () => {
      assert.ok(src.includes(`"${action}"`) || src.includes(`case "${action}"`), action);
    });
  }

  it("has Linux screenshot drivers (grim/maim/scrot)", () => {
    assert.ok(src.includes("grim"));
    assert.ok(src.includes("maim") || src.includes("scrot"));
  });

  it("has pointer drivers (xdotool/ydotool)", () => {
    assert.ok(src.includes("xdotool"));
    assert.ok(src.includes("ydotool"));
  });

  it("sandbox path escape check", () => {
    assert.ok(src.includes("escapes host root"));
  });
});

describe("permission model", () => {
  const src = read("patches/api/host-tool-permissions.ts");
  it("exports always/ask/never", () => {
    assert.ok(src.includes('"always"'));
    assert.ok(src.includes('"ask"'));
    assert.ok(src.includes('"never"'));
  });
  it("includes kill-shell in actions", () => {
    assert.ok(src.includes("kill-shell"));
  });
});

describe("parity overlays UI", () => {
  const ui = read("patches/web/dist/parity-overlays.js");
  it("exposes Permissions / Marketplace / Routines / On my PC", () => {
    assert.ok(ui.includes("openToolPermissions"));
    assert.ok(ui.includes("openMarketplace"));
    assert.ok(ui.includes("openRoutines"));
    assert.ok(ui.includes("openBotModelPicker"));
  });
  it("wires run-now, add-to-chat, MCP, and approval card", () => {
    assert.ok(ui.includes("run-now"));
    assert.ok(ui.includes("add-to-chat"));
    assert.ok(ui.includes("openMcpCatalog"));
    assert.ok(ui.includes("showApprovalCard"));
    assert.ok(ui.includes("rakijazios:host-tool-permission"));
  });
});

describe("desktop package", () => {
  it("has electron main + preload", () => {
    assert.ok(existsSync(join(ROOT, "packages/desktop/src/main.cjs")));
    assert.ok(existsSync(join(ROOT, "packages/desktop/src/preload.cjs")));
  });
  it("manifest lists expected features", () => {
    const main = read("packages/desktop/src/main.cjs");
    assert.ok(main.includes("BrowserWindow") || main.includes("Tray"));
    assert.ok(main.includes("runner") || main.includes("RAKAZO"));
  });
});

describe("executor host-tool try routing", () => {
  const trySrc = read("patches/api/host-tool-try.ts");
  it("maps shell/read/write/list", () => {
    const bridge = read("patches/api/host-tool-bridge.ts");
    assert.ok(bridge.includes("run-command"));
    assert.ok(bridge.includes("read-file"));
    assert.ok(bridge.includes("write-file"));
    assert.ok(bridge.includes("list-directory"));
    assert.ok(trySrc.includes("tryOwnerHostTool"));
  });
});
