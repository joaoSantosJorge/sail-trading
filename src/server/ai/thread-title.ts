import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { chatThreads } from "@/server/db/schema";
import { MODELS } from "./client";

/**
 * One-shot thread title, generated from the first exchange and triggered from
 * the stream route's onFinish (after persistence; a failure here must never
 * affect the turn). Runs only on the first user turn, so a thread is titled
 * exactly once. Fixed cheap model regardless of the chat model.
 */
const MAX_INPUT_CHARS = 1_500;
const MAX_TITLE_CHARS = 80;

const TITLE_SYSTEM =
  "You name a crypto research-assistant conversation from its first exchange. " +
  "Produce a concise, specific title of 3-6 words (at most 8). No quotes, " +
  'no trailing punctuation, no emojis. Title Case. Capture the concrete topic (e.g. "ETH RSI Dip Strategy", "BTC Momentum Backtest"). ' +
  "Write in English. Output only the title, nothing else.";

function clip(value: string): string {
  return value.length > MAX_INPUT_CHARS ? `${value.slice(0, MAX_INPUT_CHARS)}…` : value;
}

export async function generateThreadTitle(opts: {
  threadId: string;
  userId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  if (!opts.userText.trim()) return;

  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, opts.threadId), eq(chatThreads.userId, opts.userId)))
    .limit(1);
  if (!thread) return;

  const { text } = await generateText({
    model: anthropic(MODELS.utility),
    system: TITLE_SYSTEM,
    prompt: [
      `User message: ${clip(opts.userText)}`,
      opts.assistantText.trim()
        ? `Assistant reply: ${clip(opts.assistantText)}`
        : "Assistant reply: (none)",
    ].join("\n\n"),
    maxOutputTokens: 30,
  });

  const title = text
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[.\s]+$/, "")
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  if (!title) return;

  await db.update(chatThreads).set({ title }).where(eq(chatThreads.id, opts.threadId));
}
