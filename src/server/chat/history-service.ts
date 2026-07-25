import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { chatMessages, chatThreads } from "@/server/db/schema";

/**
 * Chat-history recall for the MEMORY tools: keyword search over titles,
 * rolling summaries, and message text (current thread excluded), plus a
 * capped text-only transcript reader. Mirrors the tracking app's tools.
 */

export async function searchChatHistory(
  userId: string,
  query: string,
  opts: { excludeThreadId?: string; limit?: number } = {},
): Promise<
  { threadId: string; title: string | null; summary: string | null; updatedAt: string; snippet: string | null }[]
> {
  const limit = Math.min(opts.limit ?? 8, 20);
  const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;

  const rows = await db
    .selectDistinctOn([chatThreads.id], {
      threadId: chatThreads.id,
      title: chatThreads.title,
      summary: chatThreads.summary,
      updatedAt: chatThreads.updatedAt,
      snippet: sql<string | null>`substring(${chatMessages.content} from 1 for 160)`,
    })
    .from(chatThreads)
    .leftJoin(
      chatMessages,
      and(eq(chatMessages.threadId, chatThreads.id), ilike(chatMessages.content, pattern)),
    )
    .where(
      and(
        eq(chatThreads.userId, userId),
        opts.excludeThreadId ? ne(chatThreads.id, opts.excludeThreadId) : undefined,
        or(
          ilike(chatThreads.title, pattern),
          ilike(chatThreads.summary, pattern),
          ilike(chatMessages.content, pattern),
        ),
      ),
    )
    .orderBy(chatThreads.id, desc(chatThreads.updatedAt))
    .limit(limit);

  return rows
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

export async function getChatThreadTranscript(
  userId: string,
  threadId: string,
  limit = 30,
): Promise<{ title: string | null; messages: { role: string; text: string }[] } | null> {
  const [thread] = await db
    .select({ id: chatThreads.id, title: chatThreads.title })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
  if (!thread) return null;

  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);

  return {
    title: thread.title,
    messages: rows
      .reverse()
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => ({ role: r.role, text: r.content.slice(0, 1000) })),
  };
}
