// Rakijazios: failed-run notices persist in chat history.
//
// Upstream records a failed run's error on the run and streams `run.failed`, which the web shows
// only as a live strip above the composer; after reopening the chat the failed turn showed
// nothing. Right after the executor finalizes a run as failed, it now also writes the notice
// as a `system` message with a `meta` block (the same shape upstream uses for "Created by …"
// notes), so it is part of the thread's history, reaches open chats through the normal
// `thread.message.created` event, and goes away with the thread when it is cleared. No schema
// change: one ordinary message row per failed run.
import type { MessageBlock } from "@rakazo/contracts";
import { runFailureError } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

/**
 * The text kept in history for a failed run, or null when there is nothing worth showing.
 * Readable notices that already name the bot (the share-local-AI ones: offline, reconnecting,
 * model server not answering, went offline during the answer) are kept as they are; anything
 * else gets a short lead-in so a raw error still reads as a sentence. Same 300-char clamp as
 * the live strip.
 */
export function failedRunNoticeText(botName: string, error: string | null | undefined): string | null {
  const shown = runFailureError({ type: "run.failed", payload: { error: error ?? "" } });
  if (!shown) return null;
  const name = botName.trim();
  if (name && shown.startsWith(name)) return shown;
  return `${name || "The bot"} couldn't finish this reply: ${shown}`;
}

export function failedRunNoticeBlocks(
  botName: string,
  error: string | null | undefined,
): MessageBlock[] | null {
  const text = failedRunNoticeText(botName, error);
  return text ? [{ kind: "meta", text }] : null;
}

/**
 * Writes the notice through `publish` (the executor's message writer: message row, event and
 * realtime notify). Delegated requests (`bot_message`) are skipped: their failure already goes
 * back to the asking bot, and upstream hides peer-run failures in the thread. Never throws: a
 * notice that cannot be written must not change the run's outcome.
 */
export async function persistFailedRunNotice(
  publish: (blocks: MessageBlock[]) => Promise<unknown>,
  run: { trigger: string },
  botName: string,
  error: string | null | undefined,
): Promise<boolean> {
  if (run.trigger === "bot_message") return false;
  const blocks = failedRunNoticeBlocks(botName, error);
  if (!blocks) return false;
  try {
    await publish(blocks);
    return true;
  } catch (cause) {
    getLogger().error("failed-run notice", cause);
    return false;
  }
}
