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
    shell.openExternal(url);
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

function runnerBin() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    process.env.RAKAZO_RUNNER_BIN,
    path.join(home, ".local/bin/rakazo-runner"),
    path.join(home, ".local/share/rakijazios-runner/rakazo-runner"),
  ].filter(Boolean);
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function startRunner() {
  if (runnerChild) return;
  const bin = runnerBin();
  if (!bin) {
    console.error("[desktop] rakazo-runner not found; install from My hardware");
    return;
  }
  runnerChild = spawn(bin, ["run"], {
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      RAKAZO_HOST_TOOLS: "1",
    },
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
