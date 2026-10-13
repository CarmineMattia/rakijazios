# Rakijazios local runner (0.2.1-m2a)

A small Node 22 program that lets your bots use a model running on **your own computer**.
It opens an **outbound** WebSocket to Rakijazios, signs in with a device key, and forwards
chat-completion requests **only** to a model server on that computer's loopback (Ollama,
LM Studio, llama.cpp, vLLM, KoboldCpp, Jan). It never opens a listening port, runs no tools and
needs no admin rights.

Design: [`docs/share-local-ai.md`](../docs/share-local-ai.md) and [`docs/m2-plan.md`](../docs/m2-plan.md).

## 1. Connect a computer (recommended: from the web)

**Settings → My hardware → Add a computer.** The dialog detects the system and shows one action
with a one-time code (8 characters, 10 minutes, single use):

- **Linux / macOS:** paste the command into a terminal:
  ```bash
  curl -fsSL 'https://<your-rakijazios>/api/local-runners/install.sh' | sh -s -- --code K7QF-3MZD
  ```
  The installer:
  - uses Node ≥ 22.18, or downloads a portable Node.js and checks it against a pinned SHA-256;
  - fetches the runner files served by that Rakijazios server and checks each SHA-256;
  - installs to `~/.local/share/rakijazios-runner`, with `~/.local/bin/rakazo-runner`;
  - pairs and starts the runner. With "Start automatically" it uses a **systemd --user** unit
    (`rakijazios-runner`) on Linux or a **launchd** agent (`com.rakijazios.runner`) on macOS.
    Without it (`--no-autostart`), it starts a background process.
- **Windows:** **Download the installer** gives `Rakijazios-connect.cmd` with the code inside.
  Double-click it. It runs `install.ps1` without admin rights:
  - portable Node.js (checked) when needed;
  - files under `%LOCALAPPDATA%\Rakijazios\runner`;
  - a Startup-folder entry for autostart.
  SmartScreen may ask "More info → Run anyway". The dialog also offers a PowerShell one-liner.

The code goes in an argument or an environment variable, never in a URL. The device key is
written only to `~/.config/rakazo-runner/credentials.json` (`0600`). It is never printed.

Running the command again on the same computer, or using **New key**, keeps the same entry in
My hardware (models and switches are kept). The dialog switches to **connected** on its own.
If the computer already runs a runner (an earlier M2a install or the M1 `start.sh` runner), the
installer keeps its connection and only updates the runner files; see
[Existing installs](#existing-installs-upgrade-replace-one-runner-per-folder).

## 2. Commands

```bash
rakazo-runner pair --server https://<your-rakijazios> --code K7QF-3MZD [--name "My PC"] [--replace]
rakazo-runner start      # background (or the systemd/launchd service if installed)
rakazo-runner stop       # the service AND any runner from the pid file (e.g. M1 start.sh)
rakazo-runner status     # connection, model server, models; never shows the key
rakazo-runner inspect    # what is installed in this config dir (no secrets); exit 1 = nothing
rakazo-runner run        # foreground; also the default with no command (as in M1)
rakazo-runner version
```

Exit codes: `0` ok, `1` error, `3` refused because of an existing install (nothing changed).

From a checkout: `node runner/src/index.ts <command>`. The M1 scripts still work:
`runner/scripts/start.sh` / `stop.sh` (= `run` in the background; pid and log in the config dir).

When the owner clicks **Remove** or **New key** in My hardware, the runner gets `bye` and exits
with code 0, so services don't restart it. After 3 rejected keys in a row it exits too.

## Existing installs (upgrade, replace, one runner per folder)

The config dir (`~/.config/rakazo-runner` by default) is shared by the M1 runner and M2a.
Running the installer (or `rakazo-runner pair`) where credentials already exist is safe:

| Found in the config dir | What happens |
|---|---|
| A key for **this server and this account** that still works (M2a, or M1/seeded credentials whose gateway is the same host) | **Kept.** No new key is created and `credentials.json` is not touched. The one-time code is used up, the dialog shows **connected** with the existing computer, its models and switches stay. The runner files are upgraded and the runner restarted. Output: `This computer is already connected as "<name>". Kept its key and settings` |
| A key for **another server**, **another account**, a key the server does not know, or a **New key** code meant for a different computer | **Refused**, exit code `3`. Nothing is stopped, written or uploaded, and the code stays unused. The message explains the two ways out below |
| A key that **no longer works** (computer removed, or re-keyed elsewhere) | Paired again normally; the old file is kept as `credentials.previous-<time>.json` |
| An unreadable `credentials.json` | Paired normally; the old file is kept as `credentials.unreadable-<time>.json` |
| A login service (systemd unit / launchd agent / Startup entry) that belongs to **another install** | **Refused**, exit code `3`, before anything is paired |

Ways out of a refusal:

- **`--replace`** (`curl … | sh -s -- --code XXXX-XXXX --replace`; Windows: set
  `RAKAZO_REPLACE=1`): connects this computer as a **new** computer. The old credentials are kept
  as `credentials.replaced-<time>.json` (`0600`) and are never sent to the new server. Nothing is
  removed on any server: remove the old computer in My hardware if you no longer need it.
- **A second, separate runner:** set both `RAKAZO_RUNNER_CONFIG_DIR` and `RAKAZO_RUNNER_SERVICE`
  (and `RAKAZO_RUNNER_HOME`) to other values.

The existing key is only offered back to the server that issued it: same origin for M2a
credentials. M1 credentials only store the gateway URL, so there the host name must match
(`localhost`, `127.0.0.1` and `::1` count as one host). The server checks the device, the account
and the key before keeping it, and answers `409` without using the code otherwise.

**One runner per config dir.** Every runner writes `runner.pid` there (the M1 `scripts/start.sh`
does too). `run` and `start` refuse to start while another runner holds the folder. The installer
stops the old runner before switching: `stop` stops the systemd/launchd service and then any
runner named in the pid file (for example an M1 `start.sh` runner), and fails if it does not exit.
Only then are the new files put in place and the service started. On Windows the pid file is
refreshed every 30 s and counts as stale after 2 minutes.

## 3. Environment overrides

| Variable | Default |
|---|---|
| `RAKAZO_RUNNER_MODEL_URL` | auto-detect on loopback: Ollama :11434, LM Studio :1234, llama.cpp :8080, vLLM :8000, KoboldCpp :5001, Jan :1337 (re-checked every minute). If set, it must be `127.0.0.1`, `localhost` or `::1` |
| `RAKAZO_RUNNER_MODELS` | all models found (comma-separated filter) |
| `RAKAZO_RUNNER_CONFIG_DIR` | `~/.config/rakazo-runner` (credentials, config, status, pid, log) |
| `RAKAZO_RUNNER_CREDENTIALS` | `<config dir>/credentials.json` |
| `RAKAZO_RUNNER_SERVICE` | `rakijazios-runner` / `com.rakijazios.runner` (service name used by `start`/`stop`) |
| `RAKAZO_RUNNER_HOME`, `RAKAZO_RUNNER_BIN_DIR` | installer only: install dir and shim dir |
| `RAKAZO_REPLACE=1` | Windows installer only: same as `--replace` |

`wss://` / `https://` are required unless the server is on loopback.
`RAKAZO_RUNNER_ALLOW_INSECURE=1` is for tests only.

## 4. Operator seeding (M1 path, still supported)

Without the web UI, an operator can still seed a device into a `0600` file (token never printed):

```bash
mkdir -p ~/.config/rakazo-runner && chmod 700 ~/.config/rakazo-runner
umask 077
docker exec rakazo-api-1 sh -c \
  'cd /app/apps/api && npx tsx src/local-runner-seed.ts --email you@example.com --name my-pc' \
  > ~/.config/rakazo-runner/credentials.json
```

Seeded ("legacy") computers get the operator's `RAKAZO_SHARED_LOCAL_MODELS` switched on
automatically. Computers paired from the web start with every model **off**.

## 5. Tests

```bash
cd runner && node --test src/*.test.ts   # protocol, loopback rule, discovery, pairing, existing installs, CLI
```

## Behaviour

- `hello` (device id + key + models found) must be the first frame. Other frames wait for it to be
  accepted; the first `policy` frame confirms it. Then the runner sends its `models` frame. The
  heartbeat runs every 15 s, and the gateway drops a silent session after 45 s.
- `policy` carries `enabled` (Pause sharing) and the allowed models. The runner refuses other
  requests locally as well.
- Requests: `infer.request` → POST `<base>/chat/completions` (stream) → `infer.chunk` lines →
  `infer.done` / `infer.error`. `infer.cancel` aborts the local fetch.
- Reconnect backoff is 1 s → 30 s. It resets only after a successful hello, and goes to the
  maximum on "too many attempts".
- The model URL is re-validated on every request, and redirects are refused. Tool calls are only
  text in the stream; the runner never executes anything.
