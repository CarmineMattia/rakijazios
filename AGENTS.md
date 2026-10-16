# 🤖 AGENTS.md: guide for AI coding agents

For **any** coding agent working on this repo: Grok, Claude, Codex, Cursor, and our own
**Rakijazios bots**. Humans are welcome too. Read the **hard rules** first; the rest is reference.

| Jump to | |
|---|---|
| 🚨 [Hard rules](#hard-rules) | 🗂️ [Project map](#project-map) |
| 🏗️ [How the live stack works](#how-the-live-stack-works) | 🧪 [Build, typecheck, test](#build-typecheck-test) |
| 🚀 [Deploying to the live stack](#deploying-to-the-live-stack) | ✅ [PR checklist + QA handoff](#pr-checklist) |
| 🏷️ [Brand and copy](#brand-and-copy) | 🗺️ [Roadmap and decisions](#roadmap-and-decisions) |

---

<a id="hard-rules"></a>

## 🚨 Hard rules

1. 🔐 **Never commit or print secrets**: `.env`, `credentials.json`, API keys, tokens, pairing
   codes, magic-link tokens, SMTP URLs, real passwords. **The repo is public.** Count secrets in
   logs instead of printing them. Keep long-lived tokens out of URLs and shell history.
2. 📦 **Rakazo patches go only in this repo** (`rakijazios`; the local checkout may still be called `rakazo-online`). Not in the live folder, not in any
   other checkout or bot workspace. The live stack gets **copies**.
3. 🗄️ **Database changes are additive only** (new tables/columns, idempotent `IF NOT EXISTS`). Never
   drop or rewrite existing data.
4. 💾 **Back up before any live deploy**: `~/projects/rakazo/.backups/<name>-<YYYYMMDD-HHMMSS>/`
   ([details](#deploying-to-the-live-stack)). Deploy to the live stack only when the task says so.
5. 🛑 **Never merge a PR** without the owner's explicit OK. Open the PR, report, stop.
6. 🧪 **Every change goes to QA**: hand the QA tester bot (Rakazo Tester) **what changed** and
   **what to test** ([template](#qa-handoff)).
7. 🙅 **Don't touch the owner's real things**: their bots, groups, devices, runner
   (`~/.config/rakazo-runner`) or credentials. Use **test accounts** (`qa@rakazo.test`,
   `qa2@rakazo.test`, `rakazo.test2@example.com`, `rakazo.test3@example.com`) and throwaway
   `HOME` / `RAKAZO_RUNNER_CONFIG_DIR` / `RAKAZO_RUNNER_SERVICE` values. Don't add the owner's bots
   to shared groups.
8. 🔑 **No default shared API key.** Never wire one person's key (e.g. OpenRouter) in as a default
   for others. Each user brings their own key or hardware.
9. 🍾 **The brand is "Rakijazios"** in all user-facing text ([rules](#brand-and-copy)).
   ⚖️ **License: Apache-2.0.** Keep upstream copyright notices in files under `patches/`, keep
   `LICENSE` and `NOTICE`, and mark substantial changes to upstream files.
10. 🧯 **If something big is blocked, stop and report.** Don't improvise risky workarounds.

Design invariants of *Share your local AI* (don't break them): the runner is **outbound-only**
and opens no ports; it dials models on **loopback only**; device tokens are stored **hashed**;
when a runner is offline the bot replies with a **friendly notice and no fallback model**
(decision D1).

---

<a id="project-map"></a>

## 🗂️ Project map

```text
rakijazios/                      (local checkout on Host-001: ~/projects/rakazo-online)
├── README.md                    front page (short, for humans)
├── LICENSE / NOTICE             Apache-2.0; NOTICE credits upstream Rakazo (keep both when copying files)
├── AGENTS.md / CLAUDE.md        this guide (CLAUDE.md just points here)
├── docker-compose.images.yml    upstream image-based stack (web, api, worker, supervisor, postgres, computer)
├── docker-compose.override.yml  our layer: bind-mounts patches/*, env, host bits
├── .env.images.example          template for .env (never commit .env)
├── install-images.sh            creates .env with random secrets (--local --prepare-only)
├── bootstrap-rakazo.sh          Host-001 helper (Fedora, user cr1m3), not a general installer
├── patches/
│   ├── api/          api + adapters source files, each mounted over the same file in the image
│   │                 (most → /app/apps/api/src, some → /app/packages/adapters/src); *.test.ts are not mounted
│   ├── auth/         Better Auth config → /app/packages/auth/src/index.ts
│   ├── contracts/    typed RPC/domain contracts → /app/packages/contracts/src
│   ├── supervisor/   sandbox supervisor → /app/infra/sandboxes/supervisor/src/index.ts
│   └── web/
│       ├── dist/     the whole web build (one mount) + plain-JS overlays loaded by index.html
│       └── bot-panel.tsx, new-index-name.txt   reference files (not mounted)
├── runner/           outbound local runner (Node ≥ 22.18, no deps): src/*.ts, scripts/start.sh|stop.sh
├── computer/         local bot-computer image (Dockerfile, Fluxbox menu, helper launchers)
├── tests/            DOM tests (*.test.mjs, jsdom) + live API smoke test (social-smoke.mjs)
└── docs/             design docs + guides (architecture, self-hosting, operations, roadmap)
```

- **Which file is mounted where:** read `docker-compose.override.yml`. It's the source of truth.
  The api and worker sections list the same adapter files.
- **Overlays loaded by `patches/web/dist/index.html`:** `magic-auth` (`?v=sentfix1`), `invite`,
  `social`, `stream-watchdog`, `group-sharing`, `ui-tweaks`, `account-avatar`, `local-hardware` (M2a).
  `computer-settings-overlay.js` and `bot-time-prefs.js` are present but **not loaded**.
  - New overlay = new file in `dist/` + a `<script defer>` tag in `index.html`.
  - Bump a `?v=` query when you change an overlay that browsers may have cached.
- More detail: [docs/architecture.md](docs/architecture.md).

---

<a id="how-the-live-stack-works"></a>

## 🏗️ How the live stack works

- 📍 **Live folder:** `~/projects/rakazo` on **Host-001**. It is **not a git checkout**: it holds
  copies of `patches/` (and `runner/` once M2a lands) plus its own compose files and `.env`.
- 🔗 **Bind-mounted patches:** containers read the files under `~/projects/rakazo/patches`
  read-only. Copy a changed file there, restart the service, done. **Editing this repo alone
  changes nothing live.**
- 🧩 **Web = `dist` + overlays:** we never rebuild the minified bundle. UI changes are overlay JS
  files plus `index.html`.
- ▶️ **Compose:** `docker compose -f docker-compose.images.yml -f docker-compose.override.yml <cmd>`
  inside `~/projects/rakazo`. Containers: `rakazo-api-1`, `-web-1`, `-worker-1`, `-postgres-1`,
  `-supervisor-1`, `-mailpit-1`.
- 📨 **Live-only:** the live override also runs **Mailpit** (TLS cert + `NODE_EXTRA_CA_CERTS`).
  Keep those lines when copying the repo override over the live one.
- 🌐 **Ports:** web `:5173`, api `:3100` (both published by the upstream compose file). Don't open
  new ports.
- More: [docs/operations.md](docs/operations.md).

---

<a id="build-typecheck-test"></a>

## 🧪 Build, typecheck, test

Run `bash scripts/ci-test.sh` for runner tests, API/adapters/auth typechecks, unit
tests and overlay DOM tests against the pinned app image. Gateway regression tests
use a synthetic database and loopback runner; they do not use the live stack.

Nothing is built locally: checks run **inside the published app image**
(`ghcr.io/elie222/rakazo/app:edge`, Node 22, vitest, tsc), with our patches mounted the same way
Compose does. Run these from the repo root. They need Docker; host Node ≥ 22.18 only for the runner.

<details open>
<summary>🔎 Typecheck api + adapters (mounts read from the override)</summary>

```bash
R=$PWD; M=()
while IFS= read -r line; do
  src=$(echo "$line" | sed -E 's/^ *- \.\/(patches\/[^:]+):([^:]+):.*/\1/')
  dst=$(echo "$line" | sed -E 's/^ *- \.\/(patches\/[^:]+):([^:]+):.*/\2/')
  M+=(-v "$R/$src:$dst:ro,z")
done < <(awk '/^  api:/,/^  worker:/' docker-compose.override.yml | grep -E '^ *- \./patches/')
docker run --rm "${M[@]}" --entrypoint sh ghcr.io/elie222/rakazo/app:edge \
  -c 'cd /app/apps/api && ../../node_modules/.bin/tsc --noEmit -p .; echo exit=$?'
```

For the **worker** use the `/^  worker:/,/^  web:/` block and run
`cd /app/packages/adapters && ../../node_modules/.bin/tsc --noEmit -p .`.

</details>

<details>
<summary>🧪 Unit tests (vitest, patches/api/*.test.ts)</summary>

Each test is copied next to the module it imports (`apps/api/src` or `packages/adapters/src`):

```bash
R=$PWD; M=()   # build M exactly as in the typecheck block above, then:
docker run --rm -u 0 "${M[@]}" -v "$R/patches/api:/p:ro,z" --entrypoint sh ghcr.io/elie222/rakazo/app:edge -c '
cd /app
for t in /p/*.test.ts; do
  n=$(basename $t); case $n in *.postgres.test.ts) continue;; esac
  mod=$(grep -oE "from \"\./[a-z-]+\.js\"" $t | head -1 | sed -E "s/.*\.\/(.*)\.js\"/\1/")
  if [ -n "$mod" ] && [ -f packages/adapters/src/$mod.ts ] && [ ! -f apps/api/src/$mod.ts ]; then
    cp $t packages/adapters/src/; echo packages/adapters/src/$n
  else cp $t apps/api/src/; echo apps/api/src/$n; fi
done > /tmp/list
node_modules/.bin/vitest run $(cat /tmp/list)'
```

`group-sharing.postgres.test.ts` needs a schema-only test database; see
[docs/operations.md](docs/operations.md#testing-and-verification).

</details>

<details>
<summary>🖱️ DOM tests for overlays (tests/*.test.mjs, jsdom from the image)</summary>

```bash
docker run --rm -v "$PWD:/r:ro,z" --entrypoint sh ghcr.io/elie222/rakazo/app:edge -c '
J=$(ls -d /app/node_modules/.pnpm/jsdom@*/node_modules/jsdom | head -1)
cd /r && RAKAZO_JSDOM_PATH=$J node --test tests/*.test.mjs'
```

Override the overlay under test with `RAKAZO_AUTH_OVERLAY`, `RAKAZO_SHARING_OVERLAY` or
`RAKAZO_WATCHDOG_OVERLAY`.

</details>

<details>
<summary>🏃 Runner: tests + strict typecheck</summary>

```bash
cd runner && node --test src/*.test.ts        # host Node ≥ 22.18 (runs .ts directly)
docker run --rm -v "$PWD:/r:ro,z" --entrypoint sh ghcr.io/elie222/rakazo/app:edge -c \
  'cd /app && node_modules/.bin/tsc --noEmit --strict --target es2023 --module nodenext \
   --moduleResolution nodenext --allowImportingTsExtensions --erasableSyntaxOnly --skipLibCheck \
   --types node --typeRoots /app/node_modules/@types /r/src/*.ts; echo exit=$?'
```

</details>

<details>
<summary>🌐 Live checks (against a running stack, test accounts only)</summary>

- `node tests/social-smoke.mjs` (or `RAKAZO_TEST_URL=http://127.0.0.1:5173 node tests/social-smoke.mjs`):
  creates and removes disposable `example.invalid` accounts.
- **Browser e2e (puppeteer), `e2e/m2a/`** ([README](e2e/m2a/README.md)): `50-m2a-pair.mjs`
  (add/pause/rename/new key/remove + abuse cases), `51-m2a-owner-view.mjs` (read-only, needs
  `RK_OWNER_EMAIL`), `52-m2a-migrate.mjs` (install over an M1/earlier runner). They use test
  accounts, a throwaway `HOME` / `RAKAZO_RUNNER_CONFIG_DIR` / `RAKAZO_RUNNER_SERVICE`, never print
  secrets (they count leaks in logs and expect 0), and **must run one at a time** (shared
  browser profiles).
  ```bash
  npm i --prefix /tmp/rk-e2e-npm puppeteer-core    # once
  cd e2e/m2a && node 50-m2a-pair.mjs && node 52-m2a-migrate.mjs   # exit 0 = all passed
  ```
  Never point them at the owner's real `~/.config/rakazo-runner` or default service.

</details>

---

<a id="deploying-to-the-live-stack"></a>

## 🚀 Deploying to the live stack (only when asked)

1. ✅ Typecheck + tests green in the repo.
2. 💾 **Backup:**
   ```bash
   cd ~/projects/rakazo && B=.backups/<name>-$(date +%Y%m%d-%H%M%S) && mkdir -p $B && chmod 700 $B
   cp -a docker-compose.images.yml docker-compose.override.yml patches $B/   # + runner/ if present
   # + data-only pg_dump of any table you change (chmod 600)
   ```
3. 📋 `diff -rq` repo vs live first, then copy **only** the changed files.
4. 🔄 Restart only the affected services; check `docker logs` and that the owner's things still
   work (read-only checks).
5. 🧪 Re-run tests/e2e and confirm no new listening ports (`ss -ltn` before/after).

---

<a id="pr-checklist"></a>

## ✅ PR checklist

- [ ] Branch from up-to-date `origin/main`: `feat/<topic>`, `fix/<topic>` or `docs/<topic>`.
- [ ] One topic per PR. Keep edits minimal where other open PRs touch the same files.
- [ ] Scan the diff for secrets (`.env`, keys, tokens, emails, credentials) before committing.
- [ ] Typecheck + unit/DOM/runner tests pass; e2e where relevant.
- [ ] DB changes are additive; live deploy only after a backup (and only if asked).
- [ ] Docs updated: README (short, user-facing), `docs/` (details), this file (rules/commands).
- [ ] PR description: what, why, how verified, risks, **what to test**.
- [ ] **Do not merge.** Report the PR URL and hand off to QA.

<a id="qa-handoff"></a>

**QA handoff template** (to the QA tester bot):

```text
PR: #<n> (<branch>), commit <sha>
Changed: <2–5 bullets, user-visible first>
Deployed live: yes/no (backup: .backups/<name>-<ts>/)
Please test: <numbered steps with expected results>
Test accounts: qa@rakazo.test / qa2@rakazo.test (never the owner's account)
Known limits / not covered: <…>
```

---

<a id="brand-and-copy"></a>

## 🏷️ Brand and copy

- ✍️ Product name: **Rakijazios** (capital R, one word). Say **Rakazo** only for the upstream
  project, and `rakijazios` for this repo (formerly `rakazo-online`).
- 🇹🇷 **Turkish suffixes** take an apostrophe, with vowel harmony (as already used in the UI):
  **Rakijazios'a** (to), **Rakijazios'ta** (in/at), **Rakijazios'un** (of).
- 🌍 UI copy: plain, friendly English first. Italian and Turkish must follow for user-facing
  strings.
- 🙂 Be transparent in consent and permission text: say what it does, what can go wrong, and how
  to undo it.

---

<a id="roadmap-and-decisions"></a>

## 🗺️ Roadmap and decisions

| What | Where |
|---|---|
| Roadmap summary / full list | [README → Roadmap](README.md#roadmap) · [docs/roadmap.md](docs/roadmap.md) |
| Share your local AI (M1–M5), decisions D1…, threat model | [docs/share-local-ai.md](docs/share-local-ai.md) |
| M2 plan / M2a as built | [docs/m2-plan.md](docs/m2-plan.md) |
| Device control mode, Live voice mode | [docs/share-local-ai.md §14](docs/share-local-ai.md), [docs/live-voice-mode.md](docs/live-voice-mode.md) |
| Model advisor (hardware → model picks, planner model) | [docs/model-advisor.md](docs/model-advisor.md) |
| Architecture, patches, API | [docs/architecture.md](docs/architecture.md) |
| Live stack, deploys, tests, known limits | [docs/operations.md](docs/operations.md) |
| Runner usage | [runner/README.md](runner/README.md) |

New big idea? Add a design section with **Open questions** in `docs/`, link it from
`docs/roadmap.md` and the README table, and open a PR.
