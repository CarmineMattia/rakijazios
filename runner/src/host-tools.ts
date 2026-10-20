/**
 * Local host-tools executor for the Rakijazios runner (P1 / P5).
 * Shell + file I/O under an allowlisted root; optional computer-use stubs when gated.
 */
import { spawn, spawnSync, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  lstat,
  open,
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
import { permissionsPath } from "./permissions.ts";
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
  // Check every existing component below the root: a symlink is only acceptable when it resolves
  // inside the root. Dangling symlinks are refused (a write would create their target outside).
  const parts = abs.slice(rootReal.length).split(sep).filter(Boolean);
  let cur = rootReal;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
      throw error;
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(cur);
      } catch {
        throw new Error(`Path escapes host root (${rootReal}): dangling symlink ${part}`);
      }
      if (!inside(real)) throw new Error(`Path escapes host root (${rootReal})`);
    }
  }
  return abs;
}

/** Runner config (credentials, permissions.json) must never be reachable from the host root. */
function configOverlapsRoot(rootReal: string): string | null {
  const cfg = resolve(dirname(permissionsPath()));
  const within = (a: string, b: string) => a === b || a.startsWith(b + sep);
  return within(cfg, rootReal) || within(rootReal, cfg) ? cfg : null;
}

type BgShell = {
  id: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  startedAt: number;
  sandboxPid: Promise<number | null>;
};

// Every sandbox is spawned with bwrap --info-fd 3: once the sandbox is set up, bwrap reports the
// host pid of its init (pid 1 of the sandbox's pid namespace). Killing that pid kills everything in
// the sandbox. Signalling only the outer bwrap is not enough: if it dies during setup (a kill right
// after spawn), --die-with-parent is not armed yet and the half-built sandbox is orphaned for good,
// holding the output pipes open (a killed shell that never dies, and a runner that can't exit).
const SANDBOX_INFO_FD = 3;
const SANDBOX_READY_WAIT_MS = 5_000;

function spawnSandbox(bwrap: string, args: string[], cwd: string, stdin: "pipe" | "ignore") {
  const child = spawn(bwrap, args, { cwd, env: {}, stdio: [stdin, "pipe", "pipe", "pipe"], detached: false });
  const info = child.stdio[SANDBOX_INFO_FD] as NodeJS.ReadableStream | null;
  const sandboxPid = new Promise<number | null>((resolve) => {
    let buf = "";
    const done = () => {
      const pid = Number(/"child-pid"\s*:\s*(\d+)/.exec(buf)?.[1]);
      resolve(Number.isInteger(pid) && pid > 1 ? pid : null);
    };
    if (!info) return resolve(null);
    info.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (/"child-pid"\s*:\s*\d+/.test(buf)) done();
    });
    info.on("end", done);
    info.on("error", () => resolve(null));
    child.on("exit", done);
  });
  return { child, sandboxPid };
}

/** Kill a sandbox and everything in it; never leaves an orphan behind. Bounded (~5 s). */
async function killSandbox(child: ReturnType<typeof spawn>, sandboxPid: Promise<number | null>): Promise<void> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  // Wait until bwrap has finished setting up (or exited) before signalling anything.
  const pid = await Promise.race([sandboxPid, new Promise<null>((r) => setTimeout(() => r(null), SANDBOX_READY_WAIT_MS).unref?.())]);
  if (pid) {
    try {
      process.kill(pid, "SIGKILL"); // init of the sandbox's pid namespace: the kernel kills the rest
    } catch {
      /* already gone */
    }
  }
  if (!exited()) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Never let a stuck descendant keep our end of the pipes (and the runner) alive.
  setTimeout(() => {
    for (const s of child.stdio) (s as { destroy?: () => void } | null)?.destroy?.();
  }, 1_000).unref?.();
}

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
  const spawnArgs = sandboxArgs({ root, cwd, egressAllowed, command, infoFd: SANDBOX_INFO_FD });
  if (opts?.background) {
    const id = opts.shellId || `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (backgroundShells.has(id)) {
      // never overwrite (and orphan) a running shell
      return { ok: false, denied: true, error: `Background shell id ${id} is already in use.` };
    }
    const { child, sandboxPid } = spawnSandbox(sandbox.bwrap, spawnArgs, cwd, "pipe");
    const entry: BgShell = { id, child, stdout: "", stderr: "", startedAt: Date.now(), sandboxPid };
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
    const { child, sandboxPid } = spawnSandbox(sandbox.bwrap, spawnArgs, cwd, "ignore");
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
      void killSandbox(child, sandboxPid);
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

  if (req.localDecision !== "allow" && req.localDecision !== "ask") {
    // Fail closed: no explicit local decision means no host action.
    return { ok: false, denied: true, error: "Denied by local permissions.json" };
  }
  if (req.localDecision === "ask") {
    return {
      ok: false,
      denied: true,
      error: "Local runner requires an explicit grant (ask). Approve in Rakijazios, then retry.",
    };
  }

  if (action !== "computer-wait") {
    const overlap = configOverlapsRoot(resolve(root));
    if (overlap) {
      return {
        ok: false,
        denied: true,
        error: `Host tools are refused: the runner config dir (${overlap}) overlaps the host root. Move one of them.`,
      };
    }
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
        const rfh = await open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          bytes = await rfh.readFile();
        } finally {
          await rfh.close();
        }
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
        await ensureInsideRoot(root, path); // re-check after creating parents
        const fh = await open(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
        try {
          await fh.writeFile(content, "utf8");
        } finally {
          await fh.close();
        }
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
          // Kills the whole sandbox (its pid-namespace init), also right after start; see killSandbox.
          await killSandbox(shell.child, shell.sandboxPid);
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
