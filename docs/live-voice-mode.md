# Live voice mode — idea note

> **Status: long-term roadmap idea (2026-10-09). Not designed, not scheduled.** Separate from
> Share your local AI and from Device control mode; it only *may* reuse the local runner (see
> open question V1).

## The idea

Next to the chat composer, the bot's **icon/avatar** becomes a button. Clicking it:

1. makes the bot **greet you out loud in its own voice**: a short "ehi", or a short sound that
   fits the bot;
2. opens a **live, interactive voice conversation** with that bot. You talk, it answers by voice,
   with its usual personality, memory and permissions. It's not a separate "voice assistant".

The text chat stays the source of truth. The conversation is shown in the chat as it happens (what
you said and what the bot said), so it can be read back, and the bot can switch between voice and
text.

## What exists today

The web app's **Settings → Voice** already lets a user connect a voice provider ("Speak +
transcribe", cloud providers). Live mode would build on that rather than add a second voice stack.
How far the current provider API supports streaming is to be checked.

## Sketch of the experience

- **Start:** click the avatar. On first use the browser/OS asks for **microphone** permission,
  after a one-line explanation of why.
- **During the call:** a clear indicator that always shows the state:
  - **listening** (mic live);
  - **thinking**;
  - **speaking**;
  - **muted**;
  - **ended**.

  It has a big **mute** button and an **end** button. The mic is never on without the indicator.
- **Interrupting:** you can talk over the bot (barge-in); it stops speaking and listens.
- **End:** click the avatar again, press end, or after a period of silence. The mic is released
  immediately.

### Live transcript (ideal, feasibility to verify)

During a voice conversation the transcript **scrolls live in the chat**, for both sides:

- **You:** your words appear **while you speak**, from interim (partial) speech-to-text results.
- **The bot:** its reply appears **as it is spoken**, in sync with the audio, word by word or in
  short chunks. This uses the word/chunk timing that the text-to-speech engine reports.
- **Interim vs final:** text still being spoken is shown **visually distinct**, for example
  lighter or italic with a small "live" marker. When a turn ends it **becomes a normal chat
  message**, with the same look, history and authorship as typed messages.
- **Groups:** other members see **at least the finalized messages**. Whether they also see the
  live interim text is part of V5.

This is the target experience. Whether the engines can deliver it with good timing is still to be
checked (V9–V13).

## Open questions

| Id | Question |
|---|---|
| **V1** | **Engines and cost:** which STT (speech-to-text) and TTS (text-to-speech) engines, local or cloud, and who pays. Could tie into [Share your local AI](share-local-ai.md): the owner's runner could serve STT/TTS (e.g. Whisper-class STT, a local TTS) next to the model, with the same outbound-only, approval-free inference rules. |
| **V2** | **A voice per bot:** how the owner picks or designs it (preset voices, a provider voice id, local voices), and licensing/consent rules for voices that imitate real people (default: not allowed). |
| **V3** | **Latency and barge-in:** a target end-to-end delay (speech end → first audio back), streaming STT/LLM/TTS, voice activity detection, and how interruptions cancel generation and audio cleanly. |
| **V4** | **Mic permission and indicators:** permission flow on web, desktop and mobile; an always-visible on/off/listening indicator; push-to-talk vs open mic; never listening in the background. |
| **V5** | **Shared groups:** who can start a call with a bot in a group, whether others can join or hear it, whether the bot answers by voice for everyone, and how this shows in the group's text history. |
| **V6** | **Audio privacy and retention:** is audio stored at all (default: no, only the transcript in the chat), where it is processed (cloud provider vs the owner's runner), and what group members and bot owners can see or hear. |
| **V7** | **The greeting:** a spoken "ehi" vs a short sound, per-bot customisation, and respecting a muted device or "no sound" setting. |
| **V8** | **Costs and limits:** per-minute cost of cloud STT/TTS, who pays when someone talks to another owner's bot, and limits to avoid surprise bills. |
| **V9** | **Engines with timing:** which streaming STT and TTS engines (local and cloud) give interim results and **word-level timestamps** (or chunk timing) that the live transcript needs, and at what cost. |
| **V10** | **Interim text without jitter:** how to update or replace interim words smoothly as STT revises them, and what gets stored (default: **only final** messages; interim text is never saved). |
| **V11** | **Latency budget and sync drift:** how much delay is acceptable between speech and on-screen text, and how to keep the bot's text in step with its audio (buffering, clock drift, network jitter). |
| **V12** | **Barge-in and the transcript:** when the user interrupts, **cut the bot's text** at the last word actually spoken, so the transcript matches what was heard (and decide whether the bot's memory keeps the unspoken rest). |
| **V13** | **Accessibility:** screen-reader behaviour for live text (polite live region, no flood of updates), captions for deaf or hard-of-hearing users, font size and contrast for interim text, and reduced-motion scrolling. |
