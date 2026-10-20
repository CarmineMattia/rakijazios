/**
 * Rakijazios Electron main process (P6 device node).
 * Loads the web UI and optionally spawns the local runner as a child.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const SERVER_URL = process.env.RAKIJAZIOS_URL || "https://localhost:5173";
let mainWindow = null;
let tray = null;
let runnerChild = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: "#0d0d0e",
    title: "Rakijazios",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(SERVER_URL);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only web links leave the app; never file:, smb:, custom protocol handlers, etc.
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Rakijazios");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: "Start local runner",
        click: () => startRunner(),
      },
      {
        label: "Stop local runner",
        click: () => stopRunner(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          stopRunner();
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => mainWindow?.show());
}

// Where the installers put the launcher (keep in sync with patches/api/local-runner-install.ts;
// tests/runner-bundle.test.mjs checks it):
//   install.sh:  $RAKAZO_RUNNER_HOME or ~/.local/share/rakijazios-runner/rakazo-runner, linked from ~/.local/bin
//   install.ps1: $RAKAZO_RUNNER_HOME or %LOCALAPPDATA%\Rakijazios\runner\rakazo-runner.cmd
function runnerCandidates(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || "";
  if (platform === "win32") {
    const prefix = env.RAKAZO_RUNNER_HOME || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Rakijazios", "runner") : "");
    return [env.RAKAZO_RUNNER_BIN, prefix && path.join(prefix, "rakazo-runner.cmd")].filter(Boolean);
  }
  return [
    env.RAKAZO_RUNNER_BIN,
    env.RAKAZO_RUNNER_HOME && path.join(env.RAKAZO_RUNNER_HOME, "rakazo-runner"),
    home && path.join(home, ".local/bin/rakazo-runner"),
    home && path.join(home, ".local/share/rakijazios-runner/rakazo-runner"),
  ].filter(Boolean);
}

function runnerBin() {
  return runnerCandidates().find((p) => fs.existsSync(p)) || null;
}

// Node refuses to spawn .cmd/.bat directly (EINVAL since the 2024 batch-file fix). Run it through
// cmd.exe with the path quoted; the only argument is the fixed word "run".
function runnerSpawnArgs(bin, platform = process.platform) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${bin}" run`], windowsVerbatimArguments: true };
  }
  return { file: bin, args: ["run"], windowsVerbatimArguments: false };
}

function isWebUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function startRunner() {
  if (runnerChild) return;
  const bin = runnerBin();
  if (!bin) {
    console.error("[desktop] rakazo-runner not found; install from My hardware");
    return;
  }
  const { file, args, windowsVerbatimArguments } = runnerSpawnArgs(bin);
  runnerChild = spawn(file, args, {
    stdio: "ignore",
    detached: false,
    windowsHide: true,
    windowsVerbatimArguments,
    // Host tools stay opt-in: the runner inherits the user's own RAKAZO_HOST_TOOLS (default off).
    env: { ...process.env },
  });
  runnerChild.on("exit", () => {
    runnerChild = null;
  });
}

function stopRunner() {
  if (!runnerChild) return;
  try {
    runnerChild.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  runnerChild = null;
}

function checkUpdatesStub() {
  if (process.env.RAKIJAZIOS_CHECK_UPDATES !== "1") return;
  // Stub for electron-updater; wire to /api/parity/desktop/manifest in release builds.
  const base = SERVER_URL.replace(/\/+$/, "");
  console.log(`[desktop] auto-update stub: would check ${base}/api/parity/desktop/manifest`);
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  checkUpdatesStub();
  if (process.env.RAKIJAZIOS_AUTOSTART_RUNNER === "1") startRunner();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    /* stay in tray */
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopRunner();
});
