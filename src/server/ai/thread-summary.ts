import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { chatThreads } from "@/server/db/schema";
import { MODELS } from "./client";

/**
 * Rolling per-thread conversation summary, refreshed after each completed
 * assistant turn from the stream route's onFinish. Feeds the chat-history
 * recall tools (Phase B). Fixed cheap model.
 */
const MAX_INPUT_CHARS = 1_500;
const MAX_SUMMARY_CHARS = 1_000;

const SUMMARY_SYSTEM =
  "You maintain a rolling summary of a crypto research-assistant conversation. " +
  "Merge the previous summary with the latest exchange into an updated summary " +
  "of 2-3 sentences (at most 80 tokens). Capture the assets, strategies, " +
  "backtest results, and decisions discussed. Write in English. Output only " +
  "the summary text, nothing else.";

function clip(value: string): string {
  return value.length > MAX_INPUT_CHARS ? `${value.slice(0, MAX_INPUT_CHARS)}…` : value;
}

export async function updateThreadSummary(opts: {
  threadId: string;
  userId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  if (!opts.assistantText.trim()) return;

  const [thread] = await db
    .select({ title: chatThreads.title, summary: chatThreads.summary })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, opts.threadId), eq(chatThreads.userId, opts.userId)))
    .limit(1);
  if (!thread) return;

  const { text } = await generateText({
    model: anthropic(MODELS.utility),
    system: SUMMARY_SYSTEM,
    prompt: [
      `Conversation title: ${thread.title ?? "Untitled"}`,
      thread.summary
        ? `Previous summary: ${thread.summary}`
        : "Previous summary: (none - this is the first exchange)",
      `Latest user message: ${clip(opts.userText)}`,
      `Latest assistant reply: ${clip(opts.assistantText)}`,
    ].join("\n\n"),
    maxOutputTokens: 120,
  });

  const summary = text.trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return;

  await db.update(chatThreads).set({ summary }).where(eq(chatThreads.id, opts.threadId));
}
