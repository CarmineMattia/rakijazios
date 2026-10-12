# 🏗️ Architecture

How Rakijazios is put together, what lives where in this repo, and what each feature does in
detail. Short version in the [README](../README.md); hands-on rules for coding agents in
[AGENTS.md](../AGENTS.md).

**Contents**

- [How it fits together](#how-it-fits-together)
- [Repository layout](#repository-layout)
- [Patches and overlays](#patches-and-overlays)
- [Features in detail](#features-in-detail)
- [API surface](#api-surface)

## How it fits together

- **Upstream images, our patches.** The app runs from the published Rakazo images
  (`ghcr.io/elie222/rakazo/app` and `…/computer`). We don't fork or rebuild the app.
- **Bind-mounted source files.** `docker-compose.override.yml` mounts single files from
  `patches/` read-only over the matching files inside the image (api, adapters, auth, contracts,
  supervisor). The image runs TypeScript directly, so a restart picks them up.
- **Web UI = patched `dist` + plain-JS overlays.** The whole web `dist` folder is replaced by
  `patches/web/dist`. Its `index.html` loads small overlay scripts that add our UI (magic-link
  login, invites, sharing, …) on top of the minified upstream bundle.
- **Local runner.** `runner/` is a small Node 22 program that connects **outbound** to the api and
  forwards inference to a model on the owner's own computer
  ([share-local-ai.md](share-local-ai.md), [runner/README.md](../runner/README.md)).
- **Services:** web (`:5173`), api (`:3100`), worker, supervisor, postgres, computer.
- **Brand:** the Rakijazios brand is applied across the deployment: page title, PWA manifest,
  Welcome screen, translated UI strings, auth email subjects/bodies and the email sender name.

## Repository layout

- `docker-compose.images.yml` / `docker-compose.override.yml` — image-based run + bind-mounted patches
- `patches/api/` — API modules (`social.ts`, `space-invites.ts` + `.sql`, `group-sharing.ts`,
  `group-access.ts`, `thread-target.ts`, `app.ts`, `router.ts`, computer/sandbox adapters) and tests
- `patches/api/local-runners.ts`, `local-runner-seed.ts`, `shared-local-token.ts`, `index.ts`,
  `pi-local-provider.ts`, `pi-models.ts` — the share-local-AI M1 gateway and `shared-local` provider
- `runner/` — the outbound local runner (Node 22, no dependencies); see [`runner/README.md`](../runner/README.md)
- `patches/auth/index.ts` — Better Auth config (magic link, single-origin callbacks)
- `patches/contracts/` — typed RPC/domain contracts
- `patches/supervisor/` — sandbox supervisor
- `patches/web/dist/` — the full patched web build plus plain-JS overlays
- `computer/` — local computer image bits (e.g. PCManFM, helper launchers)
- `tests/` — DOM tests and the live API smoke test
- `bootstrap-rakazo.sh` / `install-images.sh` — host bootstrap helpers
- `.env.images.example` — copy to `.env` and fill in locally (**never commit `.env`**)
- `patches/web/bot-panel.tsx`, `patches/web/new-index-name.txt` — reference files, not mounted by
  Compose
- `docs/` — design docs and these guides; `docs/assets/` — images (logo)

## Patches and overlays

- **Bind-mounted patches.** `docker-compose.override.yml` mounts each file under `patches/api`,
  `patches/auth`, `patches/contracts` and `patches/supervisor` read-only over the matching source
  file in the image (including `social.ts`, `space-invites.ts`, `group-access.ts`,
  `group-sharing.ts` and `thread-target.ts`).
- **Dist overlays.** The whole patched web `dist` is one read-only mount. Instead of rebuilding the
  minified bundle, `patches/web/dist/index.html` loads plain-JS overlays with `<script defer>`:
  `magic-auth` (`?v=sentfix1`), `invite`, `social`, `stream-watchdog`, `group-sharing`,
  `ui-tweaks`, `account-avatar` and `local-hardware` (Settings → My hardware, shown only when the
  api has `RAKAZO_LOCAL_RUNNERS_UI=1`), in that order. (`computer-settings-overlay.js` and
  `bot-time-prefs.js` are in the tree but not loaded by `index.html`.)
- **Database changes are additive and idempotent.** `space-invites.ts` adds `target_user_id`,
  `declined_at` and an index on first invite/search use (`space-invites.sql` has the same SQL for
  operators who prefer to apply it up front). `group-access.ts` creates `group_shares` and
  `group_message_authors` on demand. `local-runners.ts` creates `local_runner_devices` at api start
  and, since M2a, adds its new columns plus `local_runner_pairings` and `local_runner_models`.
- **Web proxy config.** `patches/web/vite.config.ts` replaces the image's `vite.config.ts` and adds
  one change: the `/api/local-runners` proxy, with WebSocket upgrade and `X-Forwarded-For`. Runners
  then connect through the web origin, so no extra port is opened.
- **Runner bundle.** The repo `runner/` directory is mounted read-only into the api
  (`/app/apps/api/local-runner-bundle`). The installers serve exactly those files, pinned with
  SHA-256. On the live stack, copy `runner/package.json` and `runner/src/*.ts` to
  `<live>/runner/` next to `patches/`.

## Features in detail

### Accounts and auth

- **Magic-link only** for sign-in and sign-up. The upstream password field is hidden, disabled and
  no longer `required`, so native form validation cannot block submission. Existing accounts
  (including former password users) always receive a link. Setting a password is meant to happen
  later, from Settings, after registration (not built yet; see [Roadmap](roadmap.md)).
- After **Send magic link** the button shows "Sending magic link…", then a clear "check your
  email" panel with **Try again** / **Back to sign in**. The sent state is kept in
  `sessionStorage` (15 minutes) so React remounts do not wipe it. SMTP failures are surfaced
  instead of failing silently.
- Magic-link verify URLs and every `callbackURL*` parameter are forced onto one origin.
- Heavy DOM observers are skipped on `/sign-in`, `/sign-up` and `/forgot-password` (fixes a login
  freeze).

### Profiles and people

- **Find registered humans** by `@username` or exact email (authenticated API).
- **Profile photo in Settings → Account**: click the image to upload. Browser uploads are cropped
  to 256×256 WebP and stored in Better Auth's existing nullable `user.image` field (256 KB max).
  An `http(s)` URL is also accepted. Avatars appear in the sidebar, search results and member list.

### Invites and spaces

- **Share → People & invites** creates link invites and lists space members.
- **Targeted human invites** into the active space are supported by the API: the recipient sees the
  pending invitation in their own People panel and can join or decline. `redeem` accepts both link
  and targeted invites and stops a different account from redeeming a targeted one.
- Invite links use the public web origin (`WEB_ORIGIN`, the same origin magic links use). They
  no longer use the internal proxy host (`api:5173`) that the API sees.
- Invites **survive magic-link login**: a signed-out visitor who presses **Join space** gets a
  **Sign in** link to `/sign-in?next=/invite/…`; the return path is kept across sign-in/sign-up switches, existing-account redirects, login errors
  and email verification. Callback paths must resolve to the same origin (protocol-relative and
  backslash host tricks are rejected).
- The in-UI username search, targeted-invite controls ("Invite registered human") and profile
  editing in the People modal are **intentionally hidden**; the share link covers inviting.
- Spaces you joined but don't own are labelled with their owner's name in the sidebar
  (e.g. "Personal · crime"), so they aren't confused with your own "Personal". This is a
  display-only label from the API's space navigation; no data is renamed.
- **Create new Space** is hidden in the `+` menu (only Create new Group remains), and the chat
  header's name / last-access stack is tightened.

### Explicit group sharing

Rakazo models humans at the **space** boundary and bots inside a **chat group**. Joining a space
alone does **not** expose existing conversations, bots or their configuration.

**Share → Groups & bots → Manage sharing** lets a group owner grant named members of the same space
access to that group's conversation (`group-sharing-overlay.js`):

- Shared members open the group from Share, read text history and send text messages to its bots.
- A grant includes the group's existing history and later messages / bot membership.
  No existing groups are shared automatically.
- Messages refresh every two seconds while visible, show authors, support loading older history and
  keep the same request nonce on retry. Sending disables the composer immediately. Bot failures
  and pending owner approval are displayed.
- Revoking clears visible history and disables further sends. It does not cancel a bot run that was
  already accepted.
- Attachments, tool cards and approvals stay in the owner's original group interface. Private bot
  chats, configuration and the native group/bot routes keep their owner restrictions.
- **Bots run as the owner**: the owner's configured models, integrations and computer capabilities
  are used. The sharing dialog explains this before granting access. Shared messages persist the
  real requester's identity and include their name in the prompt/history.
- Grant/revoke and collaborative sends take the same group lock, so a stale target or an old nonce
  cannot bypass a revocation.

### Other UI tweaks

- Composer cyan loader = **model context usage** (tap → modal).
- Bot options panel = **computer RAM / memory**; the mobile options panel scrolls to the bottom.

## API surface

Social routes used by `social-overlay.js` / `account-avatar-overlay.js`:

- `GET /api/users/search?q=@name` (also accepts an exact email address)
- `GET /api/profile`
- `PATCH /api/profile` with `{ "image": "https://…" }`, a bounded raster data URL, or `null`
- `POST /api/space-invites/direct` with `{ "userId": "…" }`
- `GET /api/space-invites/received`
- `POST /api/space-invites/decline` with `{ "token": "…" }`
- `POST /api/space-invites/redeem` (existing route; link and targeted invites)

Typed contract equivalents live in `patches/contracts/rpc.ts` under `users.search`,
`preferences.update` and `spaces.invites.{direct,received,decline}`.

Group sharing routes used by `group-sharing-overlay.js` (all authenticated):

- `/api/group-sharing/groups` — discover groups shared with / owned by the caller
- `/api/group-sharing/groups/:id/people` — owner-managed grants (only current members of the same space)
- `/api/group-sharing/groups/:id/messages` — history and sends

Rules:

- Discovery and profile routes require an authenticated space member. Search returns at most ten
  results, is limited to 30 requests/minute per account, excludes the caller and synthetic
  messaging accounts, and only returns an email when that exact email was queried. Existing or
  pending members are marked so duplicate invites are idempotent.
- Avatar inputs reject scriptable SVG, non-HTTP URLs, embedded credentials and oversized data.
- The user directory is **deployment-wide** by design for this single-host tip: separate
  organizations on one database can discover each other. A multi-tenant deployment needs an
  explicit directory/tenant policy first.
