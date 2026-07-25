import { and, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { chatThreads } from "@/server/db/schema";

export const CHAT_MODEL = "claude-sonnet-5";
export const CHAT_RETENTION_DAYS = 365;

export type ChatThread = typeof chatThreads.$inferSelect;

/** Delete threads idle past their retention window (cascades messages/audits). */
export async function purgeExpiredThreads(userId: string): Promise<void> {
  await db
    .delete(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, userId),
        lte(
          chatThreads.updatedAt,
          sql`now() - make_interval(days => ${chatThreads.retentionDays})`,
        ),
      ),
    );
}

export async function listChatThreads(userId: string, limit = 25): Promise<ChatThread[]> {
  await purgeExpiredThreads(userId);
  return db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit);
}

export async function getThreadForUser(
  userId: string,
  threadId: string,
): Promise<ChatThread | null> {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createChatThread(userId: string, title: string): Promise<ChatThread> {
  const [row] = await db
    .insert(chatThreads)
    .values({ userId, title, model: CHAT_MODEL, retentionDays: CHAT_RETENTION_DAYS })
    .returning();
  return row;
}

export async function deleteChatThread(userId: string, threadId: string): Promise<boolean> {
  const deleted = await db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });
  return deleted.length > 0;
}
