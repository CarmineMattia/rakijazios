# M2a end-to-end scripts

Browser + shell checks for **Settings → My hardware** and the local runner installer, run on the
machine that hosts the docker stack (they read magic-link tokens from Postgres and run the real
installer). They never print one-time codes, device keys or credential contents. They count how
often those secrets appear in the api/web/runner logs and expect 0.

| Script | What it checks |
|---|---|
| `50-m2a-pair.mjs` | Add a computer (Linux): install without autostart, models off by default, pause/resume, abuse cases (reused/expired/cancelled codes, other account, foreign origin, 10-computer limit), New key with portable Node + systemd, Remove, pairing rate limit |
| `51-m2a-owner-view.mjs` | Read-only: the owner's My hardware lists the M1 computer (`RK_OWNER_EMAIL` required) |
| `52-m2a-migrate.mjs` | Installing over an existing runner: a simulated **M1** install (seeded key + `scripts/start.sh` from `RK_M1_REF`, default `origin/main`) is kept, not re-paired. The M1 process is stopped and only the service runs. A re-install keeps it again. A second `run` is refused. Another account's code is refused (exit 3, nothing changed, code unused), and `--replace` then makes a new computer with a backup. A revoked key pairs again with a backup |

Safety: every runner uses a throwaway `HOME`, `RAKAZO_RUNNER_CONFIG_DIR` and a unique
`RAKAZO_RUNNER_SERVICE` (`rakijazios-runner-e2e*`), so the default `~/.config/rakazo-runner` and the
default service are never touched. The test accounts' computers and pairings are deleted at the
start and at the end.

```bash
npm i --prefix /tmp/rk-e2e-npm puppeteer-core    # once
cd e2e/m2a
node 50-m2a-pair.mjs
node 52-m2a-migrate.mjs                           # exit code 0 = all checks passed
RK_OWNER_EMAIL=you@example.com node 51-m2a-owner-view.mjs
```

Environment (all optional): `RK_BASE`, `RK_API_DIRECT`, `RK_NPM_DIR`, `RK_CHROME`, `RK_E2E_OUT`
(screenshots, profiles, `*-results.json`), `RK_PG_CONTAINER`, `RK_API_CONTAINER`, `RK_QA_EMAIL`,
`RK_QA2_EMAIL`, `RK_REPO`, `RK_M1_REF`. See `lib.mjs`. Run the scripts one at a time, because they
share browser profiles.
