/**
 * Shell sandbox for host-tools (bubblewrap).
 *
 * Every run-command (foreground and background) runs inside bwrap:
 *  - only the host root (default ~/Rakijazios) is mounted, read-write, and is $HOME;
 *  - system dirs (/usr, /etc, /bin, /lib*, /sbin) are read-only; /home, /root, /run, /media,
 *    /mnt, /srv, /var and the real /tmp are not mounted at all (a fresh tmpfs /tmp instead);
 *  - new user, pid, ipc, uts and cgroup namespaces, all capabilities dropped, and bwrap sets
 *    PR_SET_NO_NEW_PRIVS, so setuid binaries (sudo, su, pkexec, doas...) cannot gain privileges;
 *    bind mounts are nosuid as well;
 *  - the environment is cleared (no runner tokens, no DISPLAY/WAYLAND/DBUS sockets);
 *  - network: a new, empty network namespace unless egress is allowed.
 *
 * If bwrap is missing or cannot create namespaces, shell is refused (no unsandboxed fallback).
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";

export type SandboxStatus = { ok: true; bwrap: string } | { ok: false; reason: string };

let cached: { key: string; status: SandboxStatus } | undefined;

export function bwrapPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAKAZO_BWRAP?.trim() || "/usr/bin/bwrap";
}

/** Probe once per bwrap path: it must exist and be able to build the namespaces we need. */
export function sandboxStatus(env: NodeJS.ProcessEnv = process.env): SandboxStatus {
  const bwrap = bwrapPath(env);
  if (cached?.key === bwrap) return cached.status;
  let status: SandboxStatus;
  if (process.platform !== "linux") {
    status = { ok: false, reason: `no shell sandbox on ${process.platform} (bubblewrap is Linux only)` };
  } else if (!existsSync(bwrap)) {
    status = { ok: false, reason: `bubblewrap not found at ${bwrap} (install the bubblewrap package)` };
  } else {
    const probe = spawnSync(
      bwrap,
      [...systemMounts(), "--proc", "/proc", "--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--", "/bin/sh", "-c", "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status"],
      { encoding: "utf8", timeout: 10_000, env: {} },
    );
    status =
      probe.status === 0
        ? { ok: true, bwrap }
        : { ok: false, reason: `bubblewrap cannot create a sandbox here: ${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim().slice(0, 200)}` };
  }
  cached = { key: bwrap, status };
  return status;
}

export function resetSandboxCache(): void {
  cached = undefined;
}

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc"];

/** Read-only system mounts; top-level symlinks (/bin -> usr/bin) are recreated as symlinks. */
export function systemMounts(): string[] {
  const args: string[] = [];
  for (const dir of SYSTEM_DIRS) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) args.push("--symlink", readlinkSync(dir), dir);
    else args.push("--ro-bind", dir, dir);
  }
  return args;
}

export function sandboxArgs(input: {
  root: string;
  cwd: string;
  egressAllowed: boolean;
  command: string;
}): string[] {
  const args = [
    ...systemMounts(),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/var/tmp",
    "--bind", input.root, input.root,
    "--chdir", input.cwd,
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    "--new-session",
    "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "HOME", input.root,
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "--setenv", "LANG", process.env.LANG || "C.UTF-8",
    "--setenv", "TERM", "dumb",
    "--setenv", "RAKAZO_SANDBOX", "1",
  ];
  if (!input.egressAllowed) args.push("--unshare-net");
  else {
    // DNS: /etc/resolv.conf often points into /run (systemd-resolved).
    args.push("--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve");
  }
  args.push("--", "/bin/bash", "--noprofile", "--norc", "-c", input.command);
  return args;
}

/**
 * Defense in depth only (the sandbox is the control): refuse commands that invoke a privilege
 * escalation tool in command position, so the user gets a clear message instead of a sandbox error.
 * Obfuscated forms (variables, eval, base64) are not caught here; they fail in the sandbox instead.
 */
const ESCALATION_TOOLS = "sudo|su|doas|pkexec|run0|runuser|setpriv|sg|newgrp|chroot|nsenter|machinectl|systemd-run";
const ESCALATION = new RegExp(
  "(?:^|[;&|(`\\n{!]|\\$\\()\\s*(?:(?:exec|env|command|builtin|nohup|time|nice|xargs|timeout\\s+\\S+|stdbuf\\s+\\S+)\\s+(?:-\\S+\\s+)*)*" +
    "(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:\\S*/)?[\"']?(" + ESCALATION_TOOLS + ")[\"']?(?=$|[\\s;&|)`])",
);

export function escalationAttempt(command: string): string | null {
  const m = ESCALATION.exec(command);
  return m ? m[1]! : null;
}
