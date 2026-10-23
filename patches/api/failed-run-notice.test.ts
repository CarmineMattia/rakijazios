// Rakijazios: failed-run notices persist in chat history (mounted next to executor.ts in adapters).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { failedRunNoticeBlocks, failedRunNoticeText, persistFailedRunNotice } from "./failed-run-notice.js";

const BOT = "QA Tester Bot";
const shareLocal = [
  "QA Tester Bot runs on user_qa's computer, which is offline right now. Try again later.",
  "QA Tester Bot runs on user_qa's computer, which lost its connection a moment ago and is reconnecting. Try again in a minute.",
  "QA Tester Bot runs on user_qa's computer, which is online, but its model server (Ollama, LM Studio, llama.cpp…) isn't answering. user_qa can check it in Settings → My hardware.",
  "QA Tester Bot stopped because user_qa's computer went offline during the answer. Try again when it's back online.",
];

describe("failedRunNoticeText", () => {
  it("keeps the share-local-AI notices word for word", () => {
    for (const notice of shareLocal) expect(failedRunNoticeText(BOT, notice)).toBe(notice);
  });
  it("gives any other error a short lead-in", () => {
    expect(failedRunNoticeText(BOT, "Connect a model in Settings before running bots.")).toBe(
      "QA Tester Bot couldn't finish this reply: Connect a model in Settings before running bots.",
    );
    expect(failedRunNoticeText("  ", "boom")).toBe("The bot couldn't finish this reply: boom");
  });
  it("clamps a huge error like the live strip and skips empty ones", () => {
    const text = failedRunNoticeText(BOT, `x${"y".repeat(5000)}`)!;
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(400);
    expect(failedRunNoticeText(BOT, "")).toBeNull();
    expect(failedRunNoticeText(BOT, "   ")).toBeNull();
    expect(failedRunNoticeText(BOT, null)).toBeNull();
  });
  it("is a system meta block", () => {
    expect(failedRunNoticeBlocks(BOT, shareLocal[0])).toEqual([{ kind: "meta", text: shareLocal[0] }]);
    expect(failedRunNoticeBlocks(BOT, "")).toBeNull();
  });
});

describe("persistFailedRunNotice", () => {
  it("publishes the notice once for a user run", async () => {
    const publish = vi.fn(async () => undefined);
    expect(await persistFailedRunNotice(publish, { trigger: "user" }, BOT, shareLocal[1])).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith([{ kind: "meta", text: shareLocal[1] }]);
  });
  it("skips delegated bot_message runs and empty errors", async () => {
    const publish = vi.fn(async () => undefined);
    expect(await persistFailedRunNotice(publish, { trigger: "bot_message" }, BOT, shareLocal[0])).toBe(false);
    expect(await persistFailedRunNotice(publish, { trigger: "user" }, BOT, "")).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
  it("never throws when the write fails (the run outcome stands)", async () => {
    const publish = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(persistFailedRunNotice(publish, { trigger: "routine" }, BOT, "boom")).resolves.toBe(false);
  });
});

describe("executor wiring", () => {
  // Every failed finalize in the executor (setup/offline preflight and mid-answer failure) must
  // write the notice as a system message right after the run is finalized.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const calls = src.split("deps.events.finalizeRun(").slice(1);
  it("covers each failed finalizeRun", () => {
    const failed = calls.filter((c) => /^[\s\S]*?outcome: "failed"/.test(c.split("});")[0]!));
    expect(failed.length).toBe(2);
    for (const call of failed) {
      const after = call.slice(0, 900);
      expect(after).toMatch(/if \(!failed\) return;\s*\/\/[^\n]*\n\s*await persistFailedRunNotice\(/);
      expect(after).toMatch(/"system",\s*blocks/);
    }
  });
});
