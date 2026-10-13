# 🚀 Self-hosting Rakijazios

The full version of the README's Quick start. Everything here uses **placeholders**: never put
real secrets in files you commit.

**Contents**

- [What you need](#what-you-need)
- [1. Get the code and create `.env`](#1-get-the-code-and-create-env)
- [2. Fill in `.env`](#2-fill-in-env)
- [3. Check the host-specific compose bits](#3-check-the-host-specific-compose-bits)
- [4. Start it](#4-start-it)
- [5. Sign in](#5-sign-in)
- [6. Connect a model](#6-connect-a-model)
- [7. Share your own computer's AI](#7-share-your-own-computers-ai)
- [Reference: the original deployment notes](#reference-the-original-deployment-notes)

## What you need

- A Linux host with **Docker** and the **Docker Compose** plugin, plus `curl`, `openssl`, `git`.
- An **SMTP account** for magic-link emails (Resend, Amazon SES, … or a local catcher like
  Mailpit for testing). **Without email, nobody can sign in.**
- Optional: an **OpenRouter** key or an **OpenAI-compatible** model server (Ollama, LM Studio,
  llama.cpp, vLLM, …).

## 1. Get the code and create `.env`

```bash
git clone https://github.com/CarmineMattia/rakijazios.git
cd rakijazios
bash install-images.sh --local --prepare-only
```

- `--local` uses this repo's `docker-compose.images.yml` and `.env.images.example` instead of
  downloading upstream copies.
- `--prepare-only` creates `.env` with **random secrets** (Postgres password, auth secret,
  encryption key, screen-proxy secret, supervisor token) and stops before starting anything.
- Don't use plain `bash install-images.sh` to start the stack. It starts only
  `docker-compose.images.yml`, **without** our patches.

## 2. Fill in `.env`

| Variable | What to put | Notes |
|---|---|---|
| `WEB_ORIGIN`, `BETTER_AUTH_URL`, `API_URL` | The URL people open, e.g. `https://chat.example.com` | Default `http://127.0.0.1:5173` works only on the host itself |
| `RAKAZO_HOST` | The public hostname, e.g. `chat.example.com` | Vite only allows this host |
| `SMTP_URL` | `smtps://<user>:<password>@<smtp-host>:465` | **Required** for magic links in this setup |
| `EMAIL_FROM` | `"Rakijazios <noreply@example.com>"` | Must be a sender your SMTP provider accepts |
| `SIGNUPS_ENABLED`, `SIGNUP_ALLOWLIST` | `true` / comma-separated emails | Limit who can create an account |
| `OPENROUTER_API_KEY` | Leave **empty** on a shared server | A key here is the **server-wide fallback**, so it pays for every user's bots. Let each person add their own key in Settings → Models |
| `SANDBOX_PROVIDER` | `docker` (default) or `none` | `none` boots without bot computers |

- The generated secrets (`POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`,
  `SCREEN_PROXY_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`) are already filled in. Keep them private.
- In this production setup, leaving `SMTP_URL` empty doesn't give you a dev mailbox
  (`/api/dev/emails` only exists in development mode). Use a real SMTP account or Mailpit.
- **Never commit `.env`** (it's in `.gitignore`).

## 3. Check the host-specific compose bits

`docker-compose.override.yml` matches the Host-001 setup. Check these before you start:

- `supervisor.group_add: "963"` is the **docker group id** on Host-001. Use yours:
  `getent group docker | cut -d: -f3`.
- `supervisor.security_opt: label:disable` is for SELinux hosts (Fedora); it's harmless elsewhere.
- `RAKAZO_HOST_HOME: ${HOME}/rakazo-local` is the folder bots may see when Settings → Computer →
  Allow local access is on (default off). Create it: `mkdir -p ~/rakazo-local`.
- `RAKAZO_SHARED_LOCAL_MODELS` is the model id offered by the M1 local runner (step 7). Change it
  or ignore it.
- The `computer` image (`rakazo/computer:pcmanfm`) is **built locally** from `computer/` on first
  start.

## 4. Start it

```bash
docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.override.yml up -d
docker compose --env-file .env -f docker-compose.images.yml -f docker-compose.override.yml ps
```

Open `WEB_ORIGIN` (default `http://127.0.0.1:5173`). For a public server, put HTTPS (a reverse
proxy) in front of port `5173`. The api port `3100` is also published by the upstream compose
file, so firewall it if it shouldn't be reachable.

## 5. Sign in

1. Open the site, enter your email, press **Send magic link**.
2. Click the link in the email. You're in; there are no passwords.
3. Invite others from **Share → People & invites** (they get a link).

## 6. Connect a model

- **Your own API key:** Settings → **Models** → add your provider key (e.g. OpenRouter). Each user
  uses their own key; Rakijazios ships **no default shared key**.
- **A model server you run:** add an **OpenAI-compatible server URL**. From inside the containers,
  a model on the host is `http://host.docker.internal:<port>/v1` (the override adds
  `host.docker.internal`). The server must listen on an address containers can reach.

## 7. Share your own computer's AI

Let your bots use a model running on **your** computer (no open ports; an outbound runner):

- ✅ **M2a (recommended):** **Settings → My hardware → Add a computer**, steps below.
- ✅ **M1 (operator path, still supported):** see [M1 steps](#m1-steps-operator) and [runner/README.md](../runner/README.md).

### M2a steps: connect computers from the web

Needs the flag `RAKAZO_LOCAL_RUNNERS_UI=1` on the api (set in the compose override). As-built
notes: [`m2-plan.md` §12](m2-plan.md#12-m2a-as-built-2026-10-08).

1. **Settings → My hardware → Add a computer.** The dialog detects the OS:
   - Linux/macOS: one `curl … | sh -s -- --code XXXX-XXXX` command;
   - Windows: a downloadable `.cmd` with the code inside.

   The installer gets Node.js if needed (portable, checksum-verified), installs the pinned runner,
   pairs, starts it, and sets up autostart (systemd --user / launchd / Startup folder). The dialog
   flips to **connected** by itself.
   - On a computer that already runs a runner (M1 `start.sh` or an earlier install), it keeps the
     existing connection and only upgrades and restarts the runner.
   - Anything ambiguous (another server or account) is refused without changes. `--replace`
     connects it as a new computer.
   - Only one runner ever uses a config folder (see
     [`runner/README.md`](../runner/README.md#existing-installs-upgrade-replace-one-runner-per-folder)).
2. Switch on the models to offer (all start off). Per computer you can **Rename**,
   **Pause sharing**, use **New key** (rotate) and **Remove** (revoke). Up to 10 computers per account.
3. Binding bots to a computer from the UI, and grants for shared groups, come in M2b/M2c. Until
   then, a `shared-local` bot uses any online computer of its owner that offers its model.

### M1 steps (operator)

Owner-only, same-host prototype: one bot answers via a model on the owner's machine, through an
outbound runner (no inbound port). Details: [`docs/share-local-ai.md` → M1 as built](share-local-ai.md#m1-as-built-2026-10-08).

1. Compose already sets `RAKAZO_SHARED_LOCAL_GATEWAY_URL` / `RAKAZO_SHARED_LOCAL_MODELS` and mounts
   the gateway/provider patches for `api` and `worker`.
2. Seed a device token into a `0600` file (never printed) — see [`runner/README.md`](../runner/README.md#4-operator-seeding-m1-path-still-supported).
3. `runner/scripts/start.sh` (stop: `runner/scripts/stop.sh`; log: `~/.config/rakazo-runner/runner.log`).
4. Point one bot at it (operator SQL; no UI in M1):
   `UPDATE bots SET "modelProvider"='shared-local', "modelId"='gemma4:26b-a4b-it-q4_K_M' WHERE id='<bot>';`

If the runner is offline the bot's reply fails with *"{Bot} runs on {owner}'s computer, which is
offline right now. Try again later."* — no fallback model (decision D1).


## Reference: the original deployment notes

```bash
cp .env.images.example .env
# edit .env: BETTER_AUTH_*, WEB_ORIGIN, API_URL, RAKAZO_HOST, SMTP_URL, EMAIL_FROM, ...
./install-images.sh   # or follow bootstrap-rakazo.sh
docker compose -f docker-compose.images.yml -f docker-compose.override.yml up -d
```

Web UI on `:5173`, API on `:3100`. Services: web, api, worker, supervisor, postgres, computer.

> The original notes above use plain `install-images.sh`, which **downloads upstream compose
> files and starts without the override**. Prefer steps 1–4.

Details on how patches are mounted: [architecture.md](architecture.md#patches-and-overlays).
