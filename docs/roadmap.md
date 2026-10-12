# 🗺️ Roadmap (full)

The README has a one-line summary per item; this is the full list. Items are **planned, not
done** unless ticked. Bigger items have a design doc in `docs/` with an **Open questions** list.

> 🚧 **Merge order:** #7 (M2a) → #8 (Device control + Live voice) → #10 (Model advisor) → #9 (this
> restructure). Their roadmap entries are **already ported** into this file. Links to
> `m2-plan.md`, `live-voice-mode.md` and `model-advisor.md` resolve once those PRs are merged.


## Next steps

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

## Conversation model

- [ ] Keep **both** conversation types as first-class:
  - **Mixed groups** of humans and bots.
  - **Private 1:1 chats** between one human and one bot.

  This is explicitly *not* a groups-only model.

## Bot visibility

- [ ] Bots are **private by default**: a private bot is only reachable inside its own group or
      private chat and never appears in search.
- [ ] The owner can **publish** a bot (and unpublish it). Published bots appear in search for
      everyone.

## Share your local AI

- [ ] Let any user offer models that run on **their own computer** (Ollama / llama.cpp /
      OpenAI-compatible on localhost) as the backend for their bots, including in shared
      groups — without opening inbound ports. A small outbound runner pairs with a code;
      Rakazo only sends inference requests. Design: [`docs/share-local-ai.md`](share-local-ai.md).
  - [x] **M1 — same-host prototype (owner only):** outbound runner ([`runner/`](../runner/README.md)),
        api gateway, and a `shared-local` provider for one operator test bot. No pairing UI yet.
        See [`docs/share-local-ai.md` → M1 as built](share-local-ai.md#m1-as-built-2026-10-08).
  - [x] **M2a —** Settings → My hardware: OS-aware one-step install + pairing code, several
        computers per account (max 10), model switches, pause, rename, new key, remove.
        Runner 0.2.x with model-server auto-detection; WebSocket through the web origin. Plan and
        as-built notes: [`m2-plan.md`](m2-plan.md).
  - [ ] **M2b —** choose a computer + model for a bot in its settings.
  - [ ] **M2c —** grants for shared groups.
  - [ ] **M3 —** limits and usage.

## Bot marketplace

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

## Model advisor (after M2)

- [ ] **"What can my computer run?"** The runner detects the hardware (opt-in, coarse). The server
      recommends up-to-date GGUF models from a curated Hugging Face catalog with fit tiers,
      one-click verified install, and an optional small planner/router model. Proposal:
      [`model-advisor.md`](model-advisor.md).

## Device node app (M5, long-term)

- [ ] An installable **Rakijazios app** for Linux/Windows/macOS (desktop) and Android/iOS: chat client
      + one-click local model (bundled llama.cpp, model chosen by device RAM) + the built-in runner
      that pairs the device to a Rakijazios server. Each device becomes a node running its owner's
      bots, so groups can mix humans and bots running on different hardware. Phones are mainly chat
      clients and light nodes while in the foreground. Vision:
      [`docs/share-local-ai.md` §13](share-local-ai.md#13-vision-rakijazios-app-as-a-device-node-m5).

## Device control mode (long-term, after M5)

- [ ] **Opt-in help on your own computer.** Today a bot can't open a terminal or touch files on the
      owner's desktop: bots only have their sandbox shell, and the runner only shares inference.
      Later, a bot could help fix problems on the owner's computer **through the runner**, but only
      when the owner opts in, and only safely:
  - **Two separate toggles in the chat composer** (next to **+**, dimmed when off, lit when on):
    **Browser** (globe: open pages, click, type) and **Computer** (monitor: files and shell). Both
    are **off by default**, enabled per device **and** per bot, and only after a plain-language
    explanation modal and confirmation on the device.
  - The owner chooses which bots and groups may use it. Shared-group members never get it by default.
  - **Every** command or file action needs explicit approval from the owner, **on that device**.
    An allowlist or a read-only mode are options.
  - A full audit log, an instant kill switch and revocation. No silent background execution.
  - A clear UI and group badges, e.g. "can use {owner}'s browser".
  - A threat model covering prompt injection from group messages, exfiltration, privilege
    escalation, approval fatigue and a compromised server pushing commands. Inference stays
    separate from control.

  Design notes and open questions:
  [`share-local-ai.md` §14](share-local-ai.md#14-long-term-device-control-mode).

## Live voice mode (long-term)

- [ ] **Talk to a bot live.** Clicking the bot's icon/avatar next to the composer makes the bot
      greet you out loud in its own voice (a short "ehi" or a sound). It then opens a live,
      interactive voice conversation with that bot and its personality, with a clear
      listening/speaking indicator and a live transcript in the chat. Separate from Device control
      mode. Open questions:
  - STT/TTS engines, local vs cloud, and cost. The local runner could serve STT/TTS (link with
    Share your local AI).
  - A voice per bot.
  - Latency and barge-in (interrupting the bot).
  - Mic permission and a clear on/off/listening indicator.
  - How it works in shared groups.
  - Audio privacy and retention.

  Idea note: [`live-voice-mode.md`](live-voice-mode.md).
