# M2b end-to-end script

`60-m2b-bind.mjs` runs as the QA account (`RK_QA_EMAIL`, default `qa@rakazo.test`). It needs that
account's bot "QA Tester Bot" and its shared group "QA Group". It pairs a throwaway runner (temp
`HOME`, config dir, service name `rakijazios-runner-e2e-m2b`). It binds the bot in Settings → My
hardware → "Bots on my computer", then runs real chats against the gateway rules (private OK;
shared group, paused, model off and offline refused with notices). It also checks gateway 401s,
that another account can't touch the bot, unbinding, and leaks. At the end it puts the bot back
and removes the throwaway computer.

```bash
cd e2e/m2b && RK_NPM_DIR=/path/with/puppeteer-core node 60-m2b-bind.mjs   # exit 0 = all passed
```

`RK_M2B_MODEL` picks the model to switch on (default `qwen2.5:3b` if offered, else the first one).
Other variables are the same as in [`../m2a/README.md`](../m2a/README.md).

## `61-m2c-grants.mjs` (M2c)

This script uses the same accounts and throwaway runner as `60`. It checks:
- in the shared "QA Group", a message without a grant gets the notice;
- **Allow** in Manage sharing (the real dialog) → the bot answers;
- **Turn off** during a long answer → the stream is cancelled, and the next message gets the notice;
- the private chat still works;
- qa2 sees "runs on rakazo_qa's computer" without device details, and gets 404 for grants;
- anonymous requests get 401;
- 0 secrets in the logs.

At the end it removes the grant, the binding and the computer.

## 62-health.mjs (runner health)

Pairs a throwaway 0.2.3 runner for qa, checks the health report, `POST /devices/:id/check` (API + "Check now" in the UI), 404 for qa2, and "Not reachable" after the runner is stopped. Removes only its own computer and pairing.

Note: `e2e/m2a/50-m2a-pair.mjs` now also removes only what it created (it used to delete every qa computer), and `lib.mjs` `login()` waits and retries when the magic-link endpoint answers 429 (the per-script browser profile already reuses the session).

## 63-m3a-limits.mjs (M3a limits + usage)

This script sets the throwaway computer's rate limit to 1 per minute, then checks:
- the owner is not rate limited;
- usage rows exist per run, with tokens and a matching `usage_records` row;
- qa2's request in the shared group is attributed to qa2, and qa2's second request gets the rate-limit notice;
- the daily cap notice appears for qa2, while the owner still answers;
- qa2 gets 404 on `/limits` and can't see qa's usage;
- the usage API shows the expected numbers, and the chart and the "Save limits" button work in the UI.

It removes its own computer, the bot binding, the grants and the usage rows for that computer.

## 67-output-cap.mjs (shared-local output cap)

Pairs a throwaway runner for qa, binds QA Tester Bot to it, and asks in the private chat for a 20000-word essay. It checks:
- the run **completes** (it does not stream until the 30 min hard timeout);
- every usage row is `ok`, with output tokens > 0 and ≤ the cap + 10% (`RK_CAP_TOKENS`, default 4096, matching the api's `RAKAZO_SHARED_LOCAL_MAX_OUTPUT_TOKENS`);
- the answer is not cut short (≥ 256 output tokens, > 1000 characters), even when the thread history is long;
- the next short question still gets an answer;
- 0 secrets in the logs.

It removes its own computer, binding, grants and usage rows.

## Running on an isolated stack (unmerged branches)

`e2e/iso-full-stack.sh up` starts a throwaway full stack (project `rkfull-*`, own volumes, fresh
database, throwaway secrets, 127.0.0.1-only ports) and seeds the QA fixtures these scripts need.
Then `. <dir>/iso-env.sh` points every script at it (`RK_BASE`, `RK_PG_CONTAINER`, `RK_API_CONTAINER`,
`RK_STACK_PREFIX` for log checks, its own `RK_E2E_LOCK`/`RK_E2E_OUT`, and `RK_LIVE_DIST` = that
stack's web dist for 81). Leave ~20 s between scripts: the auth rate limiter shares one bucket for
all local requests, and back-to-back magic-link logins can get 429. `e2e/iso-full-stack.sh down <dir>`
removes everything.

## 68-usage-csv.mjs (usage CSV export)

Synthetic rows on a fake **revoked** computer owned by qa (raw rows + one rollup row), removed at the end.
Checks the download headers and CSV header, the exact rows for a range, a single day, a rolled-up day,
400 on a reversed or too-long range, that qa2's export never contains qa's computer, and 401 without a
session.
In the browser (Settings → My hardware → Export usage): the picked from/to survive the ~10 s list
refresh and the real download is `rakijazios-usage-<from>_<to>.csv` with exactly those rows; a reversed
or longer-than-366-days range shows an inline error, keeps the link disabled (nothing downloads) and
stays after a refresh; fixing the range re-enables it. Takes ~1 min (waits for two refreshes). Needs no runner. Safe on live with the qa accounts, or on an isolated stack (`iso-env.sh`).

## 70-failed-run-notice.mjs (failed-run notices in history)

Isolated stack only. A throwaway runner on a fake model server; fails four runs (freeze mid-answer,
kill, clean stop, model server dies) and checks that each gets exactly one `system`/`meta` notice in
history right after its user message (DB and `threads.get`), that an open chat shows it live, and
that after reloading the chat every notice is still shown once. Completed runs get no notice.
Removes only the computer and pairing it creates; restores the bot.
