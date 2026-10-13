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
