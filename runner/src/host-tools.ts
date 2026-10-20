/**
 * Local host-tools executor for the Rakijazios runner (P1 / P5).
 * Shell + file I/O under an allowlisted root; optional computer-use stubs when gated.
 */
import { spawn, spawnSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  mkdtemp,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { constants as fsConstants } from "node:fs";

import { escalationAttempt, sandboxArgs, sandboxStatus } from "./sandbox.ts";
import { checkComputerAction, readFocusedWindow, type FocusedWindow } from "./payment-guard.ts";

const execFile = promisify(execFileCb);

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split("\n")[0]!;
  return null;
}

async function linuxScreenshot(): Promise<HostToolResponse> {
  const dir = await mkdtemp(join(tmpdir(), "rk-cua-"));
  const out = join(dir, "shot.png");
  const tries: Array<{ bin: string; args: string[] }> = [
    { bin: "grim", args: [out] },
    { bin: "gnome-screenshot", args: ["-f", out] },
    { bin: "import", args: ["-window", "root", out] },
    { bin: "scrot", args: [out] },
    { bin: "maim", args: [out] },
  ];
  for (const t of tries) {
    if (!which(t.bin)) continue;
    try {
      await execFile(t.bin, t.args, { timeout: 15_000 });
      const bytes = await readFile(out);
      return {
        ok: true,
        output: {
          format: "png",
          bytes: bytes.length,
          base64: bytes.toString("base64"),
          tool: t.bin,
          platform: process.platform,
        },
      };
    } catch {
      /* try next */
    }
  }
  return {
    ok: false,
    error:
      "No screenshot tool found. Install grim (Wayland), maim/scrot/import (X11), or gnome-screenshot.",
  };
}

async function linuxPointer(
  kind: "click" | "move" | "type" | "key" | "scroll",
  args: Record<string, unknown>,
): Promise<HostToolResponse> {
  const xdotool = which("xdotool");
  const ydotool = which("ydotool");
  if (!xdotool && !ydotool) {
    return {
      ok: false,
      error: "Install xdotool (X11) or ydotool (Wayland) for pointer/keyboard control.",
    };
  }
  try {
    if (xdotool) {
      if (kind === "click") {
        const x = Number(args.x ?? args.X);
        const y = Number(args.y ?? args.Y);
        const btn = String(args.button ?? 1);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          await execFile(xdotool, ["mousemove", String(x), String(y), "click", btn], {
            timeout: 10_000,
          });
        } else {
          await execFile(xdotool, ["click", btn], { timeout: 10_000 });
        }
      } else if (kind === "move") {
        await execFile(xdotool, ["mousemove", String(args.x ?? 0), String(args.y ?? 0)], {
          timeout: 10_000,
        });
      } else if (kind === "type") {
        await execFile(xdotool, ["type", "--clearmodifiers", "--", String(args.text ?? "")], {
          timeout: 30_000,
        });
      } else if (kind === "key") {
        await execFile(xdotool, ["key", "--clearmodifiers", String(args.key ?? "Return")], {
          timeout: 10_000,
        });
      } else if (kind === "scroll") {
        const dy = Number(args.dy ?? args.deltaY ?? 3);
        const btn = dy > 0 ? "5" : "4";
        const times = Math.min(20, Math.abs(Math.round(dy)) || 3);
        for (let i = 0; i < times; i++) {
          await execFile(xdotool, ["click", btn], { timeout: 5_000 });
        }
      }
      return { ok: true, output: { driver: "xdotool", kind, args } };
    }
    // ydotool (best-effort)
    if (kind === "type") {
      await execFile(ydotool!, ["type", String(args.text ?? "")], { timeout: 30_000 });
    } else if (kind === "key") {
      await execFile(ydotool!, ["key", String(args.key ?? "enter")], { timeout: 10_000 });
    } else if (kind === "click") {
      await execFile(ydotool!, ["click", String(args.button ?? 1)], { timeout: 10_000 });
    } else {
      return { ok: false, error: `ydotool does not support ${kind} in this build yet` };
    }
    return { ok: true, output: { driver: "ydotool", kind, args } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type HostToolRequest = {
  action: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  /** When false, computer-* actions are refused. */
  computerUseGate?: boolean;
  hostRoot?: string;
  /** Shell network egress (default false). */
  egressAllowed?: boolean;
  /** Local permission decision from permissions.json mirror. */
  localDecision?: "allow" | "deny" | "ask";
  /** Tests: focused-window reader for the payment guard (default: X11 via xdotool/xprop). */
  readWindow?: () => FocusedWindow;
};

export type HostToolResponse =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string; denied?: boolean };

function defaultRoot(): string {
  return process.env.RAKAZO_HOST_ROOT?.trim() || join(homedir(), "Rakijazios");
}

async function ensureInsideRoot(root: string, requested: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + sep);
  const rel = requested.replace(/^~\//, "");
  const abs = resolve(rootReal, rel.startsWith("/") ? rel.slice(1) : rel);
  if (!inside(abs)) throw new Error(`Path escapes host root (${rootReal})`);
  // Resolve symlinks on the deepest existing ancestor so a link inside the root
  // cannot point the read/write/list outside it.
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(real)) throw new Error(`Path escapes host root (${rootReal})`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return abs;
}

type BgShell = {
  id: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  startedAt: number;
};

const backgroundShells = new Map<string, BgShell>();

export function getBackgroundShell(id: string): BgShell | undefined {
  return backgroundShells.get(id);
}

async function runCommand(
  command: string,
  root: string,
  cwd: string,
  timeoutMs: number,
  egressAllowed: boolean,
  opts?: { background?: boolean; shellId?: string },
): Promise<HostToolResponse> {
  if (!command.trim()) return { ok: false, error: "Empty command" };
  const escalation = escalationAttempt(command);
  if (escalation) {
    return { ok: false, denied: true, error: `Privilege escalation is not allowed (${escalation}).` };
  }
  const sandbox = sandboxStatus();
  if (!sandbox.ok) {
    return { ok: false, denied: true, error: `Shell is refused: ${sandbox.reason}.` };
  }
  const spawnArgs = sandboxArgs({ root, cwd, egressAllowed, command });
  if (opts?.background) {
    const id = opts.shellId || `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn(sandbox.bwrap, spawnArgs, {
      cwd,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    const entry: BgShell = { id, child, stdout: "", stderr: "", startedAt: Date.now() };
    const max = 512 * 1024;
    child.stdout?.on("data", (buf: Buffer) => {
      if (entry.stdout.length < max) entry.stdout += buf.toString("utf8").slice(0, max - entry.stdout.length);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (entry.stderr.length < max) entry.stderr += buf.toString("utf8").slice(0, max - entry.stderr.length);
    });
    child.on("close", () => {
      // Keep entry briefly so transcript can be read; drop after 10 min.
      setTimeout(() => backgroundShells.delete(id), 10 * 60_000).unref?.();
    });
    backgroundShells.set(id, entry);
    return {
      ok: true,
      output: { shellId: id, pid: child.pid ?? null, background: true, cwd },
    };
  }
  return await new Promise((resolvePromise) => {
    const child = spawn(sandbox.bwrap, spawnArgs, {
      cwd,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const max = 512 * 1024;
    child.stdout?.on("data", (buf: Buffer) => {
      if (stdout.length < max) stdout += buf.toString("utf8").slice(0, max - stdout.length);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (stderr.length < max) stderr += buf.toString("utf8").slice(0, max - stderr.length);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolvePromise({ ok: false, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        ok: true,
        output: {
          exitCode: code,
          signal,
          stdout,
          stderr,
          cwd,
        },
      });
    });
  });
}

export async function executeHostTool(req: HostToolRequest): Promise<HostToolResponse> {
  const root = req.hostRoot ?? defaultRoot();
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 60_000, 1_000), 10 * 60_000);
  const egress = req.egressAllowed === true;
  const action = req.action;
  const args = req.args ?? {};

  if (req.localDecision === "deny") {
    return { ok: false, denied: true, error: "Denied by local permissions.json" };
  }
  if (req.localDecision === "ask") {
    return {
      ok: false,
      denied: true,
      error: "Local runner requires an explicit grant (ask). Approve in Rakijazios, then retry.",
    };
  }

  try {
    switch (action) {
      case "run-command": {
        const command = String(args.command ?? args.cmd ?? "");
        const cwdArg = typeof args.cwd === "string" ? args.cwd : ".";
        const cwd = await ensureInsideRoot(root, cwdArg);
        await mkdir(cwd, { recursive: true });
        return await runCommand(command, await realpath(root), cwd, timeoutMs, egress, {
          background: args.background === true,
          shellId: typeof args.shellId === "string" ? args.shellId : undefined,
        });
      }
      case "read-file": {
        const path = String(args.path ?? "");
        const abs = await ensureInsideRoot(root, path);
        await access(abs, fsConstants.R_OK);
        const bytes = await readFile(abs);
        const max = 256 * 1024;
        const truncated = bytes.length > max;
        const text = bytes.subarray(0, max).toString("utf8");
        return { ok: true, output: { path: abs, text, truncated, bytes: bytes.length } };
      }
      case "write-file": {
        const path = String(args.path ?? "");
        const content = String(args.content ?? args.text ?? "");
        const abs = await ensureInsideRoot(root, path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, { encoding: "utf8", mode: 0o600 });
        return { ok: true, output: { path: abs, bytes: Buffer.byteLength(content) } };
      }
      case "list-directory": {
        const path = String(args.path ?? ".");
        const abs = await ensureInsideRoot(root, path);
        const entries = await readdir(abs, { withFileTypes: true });
        const items = [];
        for (const ent of entries.slice(0, 500)) {
          const full = join(abs, ent.name);
          let size: number | null = null;
          try {
            size = (await stat(full)).size;
          } catch {
            size = null;
          }
          items.push({
            name: ent.name,
            type: ent.isDirectory() ? "dir" : ent.isFile() ? "file" : "other",
            size,
          });
        }
        return { ok: true, output: { path: abs, entries: items } };
      }
      case "computer-screenshot":
      case "computer-click":
      case "computer-type":
      case "computer-key":
      case "computer-scroll":
      case "computer-wait":
      case "computer-apps": {
        if (!req.computerUseGate) {
          return {
            ok: false,
            denied: true,
            error: "Computer use is off for this computer. Enable it in Settings.",
          };
        }
        if (process.platform !== "linux") {
          return {
            ok: false,
            error: `Computer use drivers are Linux-first; platform=${process.platform}`,
          };
        }
        if (action !== "computer-wait" && action !== "computer-apps") {
          const guard = checkComputerAction({
            action,
            window: (req.readWindow ?? readFocusedWindow)(),
            typedText: action === "computer-type" ? String(args.text ?? "") : undefined,
          });
          if (!guard.ok) return { ok: false, denied: true, error: guard.reason };
        }
        if (action === "computer-screenshot") return await linuxScreenshot();
        if (action === "computer-wait") {
          const ms = Math.min(30_000, Math.max(0, Number(args.ms ?? args.durationMs ?? 500)));
          await new Promise((r) => setTimeout(r, ms));
          return { ok: true, output: { waitedMs: ms } };
        }
        if (action === "computer-apps") {
          const wmctrl = which("wmctrl");
          if (wmctrl) {
            const { stdout } = await execFile(wmctrl, ["-l"], { timeout: 5_000 });
            return {
              ok: true,
              output: {
                windows: stdout
                  .split("\n")
                  .filter(Boolean)
                  .slice(0, 100)
                  .map((line) => ({ raw: line })),
              },
            };
          }
          return { ok: true, output: { windows: [], note: "Install wmctrl for window list" } };
        }
        if (action === "computer-click") return await linuxPointer("click", args);
        if (action === "computer-type") return await linuxPointer("type", args);
        if (action === "computer-key") return await linuxPointer("key", args);
        if (action === "computer-scroll") return await linuxPointer("scroll", args);
        return { ok: false, error: `Unhandled computer action ${action}` };
      }
      case "send-input": {
        const shellId = String(args.shellId ?? args.id ?? "");
        const text = String(args.text ?? args.input ?? "");
        const shell = backgroundShells.get(shellId);
        if (!shell) return { ok: false, error: "send-input requires an active background shell id" };
        if (!shell.child.stdin || shell.child.killed) {
          return { ok: false, error: "Background shell stdin is closed" };
        }
        shell.child.stdin.write(text);
        return { ok: true, output: { shellId, bytes: Buffer.byteLength(text) } };
      }
      case "kill-shell": {
        const shellId = String(args.shellId ?? args.id ?? "");
        const shell = backgroundShells.get(shellId);
        if (shell) {
          try {
            shell.child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            try {
              if (!shell.child.killed) shell.child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, 2_000).unref?.();
          backgroundShells.delete(shellId);
          return {
            ok: true,
            output: {
              shellId,
              killed: true,
              stdout: shell.stdout,
              stderr: shell.stderr,
            },
          };
        }
        return { ok: false, error: "Unknown background shell" };
      }
      default:
        return { ok: false, error: `Unknown host action: ${action}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
