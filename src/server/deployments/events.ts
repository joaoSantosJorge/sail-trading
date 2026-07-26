import { and, desc, eq, lt } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { db } from "@/server/db";
import { botEvents } from "@/server/db/schema";

/** Structural db type: accepts the pool db, a transaction, or a PGlite test db. */
export type DbLike = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type BotEventType =
  | "created"
  | "activated"
  | "paused"
  | "resumed"
  | "stopped"
  | "error"
  | "evaluated"
  | "skipped_bars"
  | "paper_entry"
  | "paper_exit"
  | "entry_submitted"
  | "entry_filled"
  | "exit_submitted"
  | "exit_filled"
  | "stop_filled"
  | "tp_filled"
  | "kill_switch"
  | "reconcile_adopt"
  | "reconcile_pause";

export type NewBotEvent = {
  deploymentId: number;
  userId: string;
  type: BotEventType;
  barT?: number;
  signal?: { entry: boolean; exit: boolean };
  detail?: Record<string, unknown>;
};

/**
 * Append an event. "evaluated" rows ride the partial unique index on
 * (deploymentId, barT) — a second worker racing the same bar no-ops instead
 * of duplicating history. Returns false when the conflict skipped the write.
 */
export async function recordEvent(event: NewBotEvent, tx: DbLike = db): Promise<boolean> {
  const inserted = await tx
    .insert(botEvents)
    .values({
      deploymentId: event.deploymentId,
      userId: event.userId,
      type: event.type,
      barT: event.barT,
      signal: event.signal,
      detail: event.detail,
    })
    .onConflictDoNothing()
    .returning({ id: botEvents.id });
  return inserted.length > 0;
}

export type BotEventRow = typeof botEvents.$inferSelect;

/** Cursor-paginated feed, newest first. `before` is the previous page's last id. */
export async function listEvents(
  userId: string,
  deploymentId: number,
  opts: { before?: number; limit?: number } = {},
  tx: DbLike = db,
): Promise<BotEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = [eq(botEvents.userId, userId), eq(botEvents.deploymentId, deploymentId)];
  if (opts.before !== undefined) where.push(lt(botEvents.id, opts.before));
  return tx
    .select()
    .from(botEvents)
    .where(and(...where))
    .orderBy(desc(botEvents.id))
    .limit(limit);
}
