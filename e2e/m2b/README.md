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
