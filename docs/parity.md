# Rakijazios ↔ Grok Bot parity (without cloning)

This track implements a **self-hosted** agent runtime with the same *classes* of
capability as Grok Bot, without depending on Cursor/xAI subscriptions.

## Status

| Phase | Area | Status |
|---|---|---|
| P0 | Tool permissions + per-action approvals + M2b bot→computer/model bind | Done + tests |
| P1 | Host-tools (sandboxed shell, file) + permissions.json mirror | Done + tests (opt-in, off by default) |
| P2 | Routines UI + pause/resume/run-now | Done |
| P3 | Transcripts + background shells (start/kill/send-input, approval-gated) | Done + tests |
| P4 | MCP catalog + secrets list | Done (OAuth via existing broker) |
| P5 | Computer-use gate + Linux drivers + payment-page guard | Done (X11: xdotool/xprop) |
| P6 | Electron desktop shell + update stub | Done + smoke test |
| P7 | Marketplace publish + add-to-chat (private-by-default; never host tools) | Done |
| P8 | Auth status (password/passkey paths) | Done |
| P9 | i18n strings IT/EN/DE/FR/ES | Done |

## Security model for host tools (what is enforced, and where)

Host tools are **off by default**. An action on someone's computer needs all of:

1. **Runner opt-in**: `RAKAZO_HOST_TOOLS=1` (otherwise the runner doesn't advertise host-tools and
   refuses `tool.invoke`).
2. **Local permission** in `permissions.json` that explicitly allows it (`permission: "always"` or an
   `always` grant for the action). The default `ask` refuses. The local file can only tighten what the
   server decides, never loosen it. Computer use and network egress need the env opt-in
   (`RAKAZO_COMPUTER_USE_GATE=1`, `RAKAZO_HOST_EGRESS=1`) **and** the file (`computerUseGate`,
   `egressAllowed`).
3. **Server policy** for the owner of the bot (always / ask / never + ceiling + auto-review +
   standing grants). Always the bot owner's policy: resolved from the bot row, never from the person
   who triggered the run. Published bots never use host tools. The device must belong to that owner.
   Computer use also needs the per-device gate (`/api/parity/devices/:id/computer-use`).
4. **Per-action approval** under `ask`: the action pauses and a pending approval is stored
   (`host_tool_pending_approvals`). The web overlay shows it as an approval card (allow once / always /
   deny). Allow once runs exactly that action once (allowed → consumed is atomic), always records a
   standing grant for that exact command/path on that computer, deny and expiry fail the action
   cleanly. TTL `RAKAZO_HOST_APPROVAL_TTL_MS` (default 10 min, clamped 30 s–1 h). `POST
   /api/host-tools/grants` can only add `never` grants; allowing is only possible on a server-issued
   approval.

On the computer:

- **Shell sandbox (bubblewrap)**: every shell command (foreground and background) runs in `bwrap`.
  Only the host root (`RAKAZO_HOST_ROOT`, default `~/Rakijazios`) is mounted, writable, and is `$HOME`.
  `/usr`, `/etc` and the `/bin`/`/lib` links are read-only. `/home`, `/root`, `/run`, `/media`, `/mnt`,
  `/srv`, `/var` and the host `/tmp` aren't mounted (a private tmpfs `/tmp` instead). The runner config
  dir (credentials, permissions.json) is never visible, and host tools are refused if it overlaps the
  host root. The env is cleared to PATH/HOME/LANG/TERM. New user, pid, ipc, uts and cgroup namespaces
  are used, with all capabilities dropped.
- **No privilege escalation**: bwrap sets `PR_SET_NO_NEW_PRIVS`, so setuid binaries (`sudo`, `su`,
  `pkexec`, `doas`, …) can't gain privileges even when obfuscated. As defense in depth, commands that
  call them by name are refused with a clear message.
- **Network off is real**: without egress the sandbox has its own empty network namespace (loopback
  only). There is no word filter to bypass.
- **No sandbox, no shell**: if bwrap is missing or can't create user namespaces (non-Linux, hardened
  kernels, some containers), shell commands are refused, never run unsandboxed. File tools keep
  working inside the root.
- **File tools** resolve every path component. Symlinks that leave the root, or dangling ones, are
  refused, and files are opened with `O_NOFOLLOW`.
- **Payment pages**: before screenshot/click/type/key/scroll the focused window (X11 title + class)
  is checked against a bank/payment/checkout denylist (domains and IT/EN keywords). A browser whose
  URL can't be read from the title, or an unknown focused window (no X11/xdotool, Wayland), is
  refused. Typing card numbers (Luhn) or IBANs is refused.

### Not enforced / limits

- The payment guard sees window **titles and URLs only**. It doesn't detect a payment form inside a
  page whose title/URL look harmless, and browsers expose the URL only if an extension or setting puts
  it in the title (otherwise browsers are refused entirely). On Wayland computer use is refused.
- Inside the root the shell can do anything the user can (delete files, run binaries found there).
  Approve accordingly.
- The bwrap sandbox shares the kernel; it is not a VM. Kernel exploits are out of scope.
- File-tool path checks and the open are not one atomic `openat2(RESOLVE_BENEATH)`. A sandboxed
  background shell racing a symlink swap of an *intermediate* directory between check and open is a
  residual TOCTOU (the final component is `O_NOFOLLOW`).
- `kill-shell` on your own background shell is not approval-gated.
- macOS/Windows runners: no sandbox implementation, so shell is refused there.

## Tests

```bash
scripts/ci-test.sh     # runner tests, tsc, vitest, overlay DOM tests (RAKAZO_TEST_REQUIRE_SANDBOX=1 in CI)
scripts/ci-boot.sh     # api boot + migrations + patch DDL + *.postgres.test.ts on a throwaway PostgreSQL
scripts/ci-install.sh  # install the runner from the bundle the api serves (real install.sh), start it, wait for it to connect

# end to end on an isolated stack (never the live one)
eval "$(e2e/parity/isolated-stack.sh up)"
ISO_BASE=http://127.0.0.1:$PORT ISO_PG=$PG node e2e/parity/90-host-tools-approvals.mjs
e2e/parity/isolated-stack.sh down "$PROJECT"
```

### Runner installer bundle

The api serves the runner to installers from a fixed list, `RUNNER_FILES` in
`patches/api/local-runner-install.ts`. **A new file under `runner/src/` must be added there**, or every
install fails with `ERR_MODULE_NOT_FOUND` (this happened with `host-tools.ts` after PR #22). Three
checks guard it: `tests/runner-bundle.test.mjs` (list == `runner/src/*.ts`, imports, no npm deps,
desktop launcher paths), the vitest bundle tests (now run against the mounted `./runner`, never
skipped in CI) and `scripts/ci-install.sh` (a real install from the served bundle).

## Key endpoints

- `GET/POST /api/host-tools/permissions`, `POST /api/host-tools/grants` (never only)
- `GET /api/host-tools/approvals`, `POST /api/host-tools/approvals/:id/decision`
- `GET /api/local-runners/offered-models`
- `POST /api/local-runners/bots/:botId/model`
- `GET /api/parity/bots/:botId/routines`
- `POST /api/parity/bots/:botId/routines/:id/run-now`
- `GET/POST /api/parity/background-shells` (deviceId required; 202 `pending_approval` under ask),
  `…/:id/kill`, `…/:id/send-input`
- `GET /api/parity/marketplace`, `POST …/publish`, `POST …/add-to-chat`
- `GET/POST /api/parity/devices/:deviceId/computer-use`
- `GET /api/parity/mcp/catalog`, `/api/parity/secrets`, `/api/parity/i18n`
- `GET /api/parity/desktop/manifest`

## Runner env

- `RAKAZO_HOST_TOOLS=1`: enable host-tools (default **off**)
- `RAKAZO_HOST_ROOT`: allowlisted workspace (default `~/Rakijazios`)
- `RAKAZO_HOST_EGRESS=1`: give the shell sandbox the host network (also needs `egressAllowed` in
  permissions.json). Off = empty network namespace.
- `RAKAZO_COMPUTER_USE_GATE=1`: allow computer use (also needs `computerUseGate` in permissions.json and
  the server-side device gate)
- `RAKAZO_BWRAP`: path to bubblewrap (default `/usr/bin/bwrap`)
- Local mirror: `~/.config/rakazo-runner/permissions.json` (0600). Must be outside the host root.

## UI

`patches/web/dist/parity-overlays.js` floating menu: Permissions, Marketplace,
Connectors, Security, On my PC, Routines. Pending approvals are polled from
`/api/host-tools/approvals` and shown as an approval card. A tool result can also announce one at once
with `window.dispatchEvent(new CustomEvent('rakijazios:host-tool-permission', { detail: { approval } }))`.
