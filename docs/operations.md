# 🛠️ Operations

Running and changing the live Rakijazios stack on **Host-001**, testing, and known limits.
For a fresh install see [self-hosting.md](self-hosting.md). Coding agents: also read
[AGENTS.md](../AGENTS.md).

**Contents**

- [The live stack](#the-live-stack)
- [Deploying a change](#deploying-a-change)
- [Testing and verification](#testing-and-verification)
- [Known limitations](#known-limitations)
- [Safety](#safety)

## The live stack

- **This checkout is not the running stack.** The live containers on Host-001 bind-mount
  `/home/cr1m3/projects/rakazo/patches`. Changes are copied there and the affected service is
  restarted. Check the mounts before applying changes; editing this repo alone does not update the
  running stack. As of 2026-10-08 the runtime patch files tracked here match the live stack
  (the live tree also keeps local-only `dist.broken/` and `stock-dist/` copies, not tracked).
- **Repo vs folders:** the GitHub repo is **`CarmineMattia/rakijazios`** (renamed from
  `rakazo-online`; old URLs redirect). On Host-001 the git checkout is still
  `~/projects/rakazo-online`, which is fine and doesn't need renaming.
- **Where it runs:** `~/projects/rakazo` on Host-001 (not a git checkout). Containers:
  `rakazo-api-1`, `rakazo-web-1`, `rakazo-worker-1`, `rakazo-postgres-1`,
  `rakazo-supervisor-1`, plus `rakazo-mailpit-1`.
- **Compose command:**
  `docker compose -f docker-compose.images.yml -f docker-compose.override.yml <cmd>`
  (run inside `~/projects/rakazo`).
- **Live-only differences:** the live override also runs **Mailpit** (local email catcher, UI on
  `127.0.0.1:8025`) with its TLS certificate and `NODE_EXTRA_CA_CERTS` for api/worker. Those
  lines are not in this repo; keep them when copying the override.
- `bootstrap-rakazo.sh` is a **Host-001 helper** (Fedora `dnf`, user `cr1m3`, Ollama listening on
  `0.0.0.0:11434` for containers). It is not a general installer.

## Deploying a change

1. Make and test the change **in this repo** first (see below and [AGENTS.md](../AGENTS.md)).
2. **Back up** before touching the live stack:
   `~/projects/rakazo/.backups/<name>-<YYYYMMDD-HHMMSS>/` with the compose files, `patches/`,
   `runner/` (if present) and a data-only dump of any tables you change.
3. Copy only the changed files into `~/projects/rakazo/` (same relative paths).
4. Restart only the affected services (e.g. `… restart api web`) and check
   `docker logs` for errors.
5. Re-run the relevant tests and e2e scripts, then hand the change to QA.

Database changes must be **additive and idempotent** (new tables/columns, `IF NOT EXISTS`); never
drop or rewrite existing data.

## Testing and verification

> Exact, verified commands (typecheck, unit tests in the app image, DOM tests, runner tests) are
> in [AGENTS.md → Build, typecheck, test](../AGENTS.md#build-typecheck-test).

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
- **Local runners (M2a).**
  - macOS and Windows installers are written and unit-checked, but were only tested end to end on
    Linux.
  - Pairing failures are rate-limited per client address (10 per 10 min) and globally (300 per
    10 min). A determined attacker can still delay pairing for others for up to 10 minutes; real
    edge rate limits come with M3.
  - Bots aren't bound to a specific computer until M2b.

## Safety

- Never commit real `.env` values, SMTP keys, auth secrets or API keys. Keep LAN/tunnel origins
  (`WEB_ORIGIN`, `BETTER_AUTH_URL`, `API_URL`, `RAKAZO_HOST`) in the local `.env` only.
- All Rakazo / Host-001 patches belong in this repository.
- Test databases get schema only, never private data.
