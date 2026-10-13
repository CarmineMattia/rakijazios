# Rakazo Online

Rakazo Online is our self-hosted, customized **Rakazo** running on Host-002. The goal is a more
**social** product: people find each other by `@handle` or email, have profile pictures, join
shared conversations with humans and bots, and invite others with a share link.

Upstream app images still come from the published Rakazo stack. This repository holds **our
patches and overlays** (API, auth, contracts, supervisor, web `dist` UI, computer image) plus the
Compose helpers, so we can evolve the social features without waiting on upstream.

The deployment is branded **Rakijazios**: page title, PWA manifest, Welcome screen, translated UI
strings, auth email subjects/bodies and the email sender name.

**Contents**

- [Features](#features)
- [Repository layout](#repository-layout)
- [Deployment](#deployment)
- [API surface](#api-surface)
- [Testing and verification](#testing-and-verification)
- [Known limitations](#known-limitations)
- [Safety](#safety)
- [Roadmap](#roadmap)

## Features

### Accounts and auth

- **Magic-link only** for sign-in and sign-up. The upstream password field is hidden, disabled and
  no longer `required`, so native form validation cannot block submission. Existing accounts
  (including former password users) always receive a link. Setting a password is meant to happen
  later, from Settings, after registration (not built yet; see [Roadmap](#roadmap)).
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

## Repository layout

- `docker-compose.images.yml` / `docker-compose.override.yml` — image-based run + bind-mounted patches
- `patches/api/` — API modules (`social.ts`, `space-invites.ts` + `.sql`, `group-sharing.ts`,
  `group-access.ts`, `thread-target.ts`, `app.ts`, `router.ts`, computer/sandbox adapters) and tests
- `patches/api/local-runners.ts`, `local-runner-seed.ts`, `shared-local-token.ts`, `index.ts`,
  `pi-local-provider.ts`, `pi-models.ts` — the share-local-AI M1 gateway and `shared-local` provider
- `runner/` — the outbound local runner (Node 22, no dependencies); see [`runner/README.md`](runner/README.md)
- `patches/auth/index.ts` — Better Auth config (magic link, single-origin callbacks)
- `patches/contracts/` — typed RPC/domain contracts
- `patches/supervisor/` — sandbox supervisor
- `patches/web/dist/` — the full patched web build plus plain-JS overlays
- `computer/` — local computer image bits (e.g. PCManFM, helper launchers)
- `tests/` — DOM tests and the live API smoke test
- `bootstrap-rakazo.sh` / `install-images.sh` — host bootstrap helpers
- `.env.images.example` — copy to `.env` and fill in locally (**never commit `.env`**)

## Deployment

```bash
cp .env.images.example .env
# edit .env: BETTER_AUTH_*, WEB_ORIGIN, API_URL, RAKAZO_HOST, SMTP_URL, EMAIL_FROM, ...
./install-images.sh   # or follow bootstrap-rakazo.sh
docker compose -f docker-compose.images.yml -f docker-compose.override.yml up -d
```

Web UI on `:5173`, API on `:3100`. Services: web, api, worker, supervisor, postgres, computer.

- **Bind-mounted patches.** `docker-compose.override.yml` mounts each file under `patches/api`,
  `patches/auth`, `patches/contracts` and `patches/supervisor` read-only over the matching source
  file in the image (including `social.ts`, `space-invites.ts`, `group-access.ts`,
  `group-sharing.ts` and `thread-target.ts`).
- **Dist overlays.** The whole patched web `dist` is one read-only mount. Instead of rebuilding the
  minified bundle, `patches/web/dist/index.html` loads plain-JS overlays with `<script defer>`:
  `magic-auth`, `invite`, `social`, `group-sharing`, `ui-tweaks` and `account-avatar`.
  (`computer-settings-overlay.js` and `bot-time-prefs.js` are in the tree but not loaded by
  `index.html`.)
- **Database changes are additive and idempotent.** `space-invites.ts` adds `target_user_id`,
  `declined_at` and an index on first invite/search use (`space-invites.sql` has the same SQL for
  operators who prefer to apply it up front). `group-access.ts` creates `group_shares` and
  `group_message_authors` on demand. `local-runners.ts` creates `local_runner_devices` at api start.
- **This checkout is not the running stack.** The live containers on Host-002 bind-mount
  `/home/cr1m3/projects/rakazo/patches`. Changes are copied there and the affected service is
  restarted. Check the mounts before applying changes; editing this repo alone does not update the
  running stack. As of 2026-10-08 the runtime patch files tracked here match the live stack
  (the live tree also keeps local-only `dist.broken/` and `stock-dist/` copies, not tracked).

## Share your local AI — running M1

Owner-only, same-host prototype: one bot answers via a model on the owner's machine, through an
outbound runner (no inbound port). Details: [`docs/share-local-ai.md` → M1 as built](docs/share-local-ai.md#m1-as-built-2026-10-08).

1. Compose already sets `RAKAZO_SHARED_LOCAL_GATEWAY_URL` / `RAKAZO_SHARED_LOCAL_MODELS` and mounts
   the gateway/provider patches for `api` and `worker`.
2. Seed a device token into a `0600` file (never printed) — see [`runner/README.md`](runner/README.md#1-seed-a-device-token-operator-once).
3. `runner/scripts/start.sh` (stop: `runner/scripts/stop.sh`; log: `~/.config/rakazo-runner/runner.log`).
4. Point one bot at it (operator SQL; no UI in M1):
   `UPDATE bots SET "modelProvider"='shared-local', "modelId"='gemma4:26b-a4b-it-q4_K_M' WHERE id='<bot>';`

If the runner is offline the bot's reply fails with *"{Bot} runs on {owner}'s computer, which is
offline right now. Try again later."* — no fallback model (decision D1).

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

## Testing and verification

### Automated

```bash
# Auth / invite navigation DOM tests (jsdom required; mocks email, sends no mail)
node --test tests/auth-invite-navigation.test.mjs
#   RAKAZO_JSDOM_PATH=<jsdom package>  RAKAZO_AUTH_OVERLAY=<overlay under test>

# Group sharing DOM tests
node --test tests/group-sharing-ui.test.mjs
#   RAKAZO_JSDOM_PATH=<jsdom package>  RAKAZO_SHARING_OVERLAY=<overlay under test>

# Live two-account API smoke test against a local stack with registrations open
node tests/social-smoke.mjs
RAKAZO_TEST_URL=http://127.0.0.1:5173 node tests/social-smoke.mjs
```

- `social-smoke.mjs` creates disposable `example.invalid` accounts and removes them afterwards. Use
  a local test stack with email delivery disabled; it does not test magic-link delivery or the
  browser. It covers signup, sign-in, username search without exposing email, targeted invite,
  duplicate-invite protection, acceptance, shared membership and repeated acceptance, plus link
  invites: public preview, unauthenticated and self-acceptance rejection, recipient acceptance,
  no duplicate members and rejection of an already-used preview.
- `patches/api/social.test.ts` covers pure validation/search helpers; copy it beside `social.ts` in
  the matching upstream source tree.
- `patches/api/group-sharing.postgres.test.ts` runs in the matching upstream source tree:
  `pnpm exec vitest run apps/api/src/group-sharing.postgres.test.ts` with `VERIFY_DATABASE=1`,
  `VERIFY_GROUP_SHARING=true` and `DATABASE_URL` pointing specifically to `/rakazo_sharing_test`
  (the test asserts that database name before writing fixtures). Clone **only the schema** into it,
  never private data, and drop it afterwards. No worker or external model calls are made.

### Manual browser test (link invites)

1. Start the stack with both Compose files and sign in as account A.
2. Open **Share → People & invites**, create an invitation and copy its link.
3. Open the link as account B. If signed out, choose **Sign in**; switching to **Sign up** and back
   must keep the invitation in the `next` query. Complete the emailed magic-link login.
4. Accept and check both people appear under **In this space**. Existing chats and bots stay
   private to their owners.
5. Accept again and check no second membership is created.

### Verification log (2026-10-08)

- **Social API:** fixed two failures reproduced on the running stack — the nested Prisma email
  filter rejected `mode` (case-insensitive mode now applies at the outer email filter), and
  deserializing the advisory lock's PostgreSQL `void` result broke direct invites (the lock now
  runs without deserializing). Four helper tests and the live two-account API check passed.
- **Invite login navigation:** three DOM tests passed (login destinations, registration
  destinations, unsafe redirects). In the browser, sign-in ↔ sign-up switching kept the invite;
  Share listed members, created an invitation, reported copying and opened a valid preview with
  inviter and space name. The Share panel text now describes the real ownership behaviour.
- **Magic-link form:** the auth DOM tests use a required password fixture, assert native form
  validity and submit with `requestSubmit()`. All passed; the browser confirmed the password input
  is disabled and optional. The user confirmed inbox delivery and a completed magic-link sign-in.
- **Group sharing:** API TypeScript check, 21 existing thread-target tests, three DOM interaction
  tests and the PostgreSQL integration flow passed (private/unshared rejection, explicit sharing,
  same history for owner/member, message authorship, owner execution identity, idempotent sends,
  revocation and stale-request rejection, lost membership, archived groups). Bot replies are
  simulated in that test. The owner's live browser was checked for group discovery, history and
  sharing controls.
- **Group sharing, live end to end:** on the running stack, with two headless Chrome sessions (the
  owner plus a second account, `rakazo.test2@example.com` / "Test Two"). The second account
  redeemed a link invite into the owner's space. Before the grant it saw no groups. The owner then
  used **Manage sharing → Share group**, and the member opened the group, saw the full history and
  sent a message from the composer. `bot1` answered with a real model call (OpenRouter, billed to
  the owner's configuration). Authors were correct on both sides. After **Revoke access**, the open
  dialog cleared and disabled itself, and history, sends and group listing were refused (404 /
  empty). This run found and fixed two display bugs: native owner messages were labelled
  "Member", and shared messages repeated the stored `@Name: ` prompt prefix.
- **Invite page, live end to end:** a fresh account (`rakazo.test3@example.com` / "Test Three")
  opened the owner's invite link signed out and saw the preview ("crime invited you to
  “Personal”"). **Join space** asked it to sign in, and it switched to sign-up with `next` kept.
  The real form sent the magic-link request with the invite as `callbackURL` and
  `newUserCallbackURL`. The link (token taken from the database, because Resend test mode cannot
  deliver to that address) landed back on the invite, and **Join space** added the member and
  opened `/app` in that space. Re-opening the used link showed "Invite already used". An existing
  member (Test Two) opening a fresh invite did not get a duplicate membership.

## Known limitations

- **Email sender / domain.** Resend has no verified domain yet. With the test sender
  (`onboarding@resend.dev`), magic links are only delivered to the Resend account owner's address;
  other recipients are rejected. Real multi-user sign-up needs a verified domain and `EMAIL_FROM`.
- **No password flow for magic-only users** yet (planned in Settings).

## Safety

- Never commit real `.env` values, SMTP keys, auth secrets or API keys. Keep LAN/tunnel origins
  (`WEB_ORIGIN`, `BETTER_AUTH_URL`, `API_URL`, `RAKAZO_HOST`) in the local `.env` only.
- All Rakazo / Host-002 patches belong in this repository.
- Test databases get schema only, never private data.

## Roadmap

Items below are **planned, not done**.

### Next steps

- [x] Bring the live runtime back in sync: move the **Rakijazios** rebrand and the newer magic-auth
      overlay (`?v=sentfix1`) from `~/projects/rakazo` into this repo.
- [x] Commit the group sharing work and open a PR from `codex/fix-social-invites` to `main`
      (merge still pending).
- [x] Test group sharing for real: a second user in a real browser, talking to a real bot with a
      real model reply.
- [x] Verify link-invite acceptance through the `/invite/…` page by a second browser account
      (signed-out → magic link → back on the invite → joined).
- [ ] **Set password** flow in Settings for magic-only users (login and sign-up stay magic-link only).
- [ ] Verified email domain for Resend and a matching `EMAIL_FROM`, so magic links reach every user.

### Conversation model

- [ ] Keep **both** conversation types as first-class:
  - **Mixed groups** of humans and bots.
  - **Private 1:1 chats** between one human and one bot.

  This is explicitly *not* a groups-only model.

### Bot visibility

- [ ] Bots are **private by default**: a private bot is only reachable inside its own group or
      private chat and never appears in search.
- [ ] The owner can **publish** a bot (and unpublish it). Published bots appear in search for
      everyone.

### Share your local AI

- [ ] Let any user offer models that run on **their own computer** (Ollama / llama.cpp /
      OpenAI-compatible on localhost) as the backend for their bots, including in shared
      groups — without opening inbound ports. A small outbound runner pairs with a code;
      Rakazo only sends inference requests. Design: [`docs/share-local-ai.md`](docs/share-local-ai.md).
  - [x] **M1 — same-host prototype (owner only):** outbound runner ([`runner/`](runner/README.md)),
        api gateway, and a `shared-local` provider for one operator test bot. No pairing UI yet.
        See [`docs/share-local-ai.md` → M1 as built](docs/share-local-ai.md#m1-as-built-2026-10-08).
  - [ ] **M2 —** pairing UI, revoke/rotate, grants for shared groups.
  - [ ] **M3 —** limits and usage.

### Bot marketplace

- [ ] A **marketplace of published bots**, with everything that follows:
  - Listing and discovery (browse and search published bots).
  - Publish / unpublish controls for owners.
  - Adding a public bot to your own private chat or group.

  Open design questions:
  - Whose models, integrations and computer run a public bot when someone else uses it? Today a
    shared bot always runs as its owner.
  - Who pays for usage: the owner, the user, or a quota/limit set by the owner?
  - What permissions and approvals apply when a public bot runs in someone else's chat
    (tools, computer access, memory and credentials)?
  - What happens to existing chats/groups using a bot when its owner unpublishes or changes it?

### Device node app (M5, long-term)

- [ ] An installable **Rakijazios app** for Linux/Windows/macOS (desktop) and Android/iOS: chat client
      + one-click local model (bundled llama.cpp, model chosen by device RAM) + the built-in runner
      that pairs the device to a Rakijazios server. Each device becomes a node running its owner's
      bots, so groups can mix humans and bots running on different hardware. Phones are mainly chat
      clients and light nodes while in the foreground. Vision:
      [`docs/share-local-ai.md` §13](docs/share-local-ai.md#13-vision-rakijazios-app-as-a-device-node-m5).
