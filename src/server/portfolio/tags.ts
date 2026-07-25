import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { historyTags } from "@/server/db/schema";

/**
 * Free-text user tags on history items, keyed by (wallet, txKey) where txKey
 * is the transaction hash (or "exec:<id>" for a hash-less pending execution).
 * setTags uses replace-set semantics: the given list becomes the item's tags,
 * so add and remove are the same call — trivially correct optimistic UI.
 */

export const MAX_TAGS_PER_ITEM = 10;
export const MAX_TAG_LENGTH = 32;

/** Trim, collapse inner whitespace, drop empties/overlong, dedupe case-insensitively. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    const fold = tag.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(tag);
    if (out.length === MAX_TAGS_PER_ITEM) break;
  }
  return out;
}

export async function setTags(
  userId: string,
  wallet: string,
  txKey: string,
  tags: string[],
): Promise<string[]> {
  const normalizedWallet = wallet.toLowerCase();
  const next = normalizeTags(tags);
  await db.transaction(async (tx) => {
    await tx
      .delete(historyTags)
      .where(
        and(
          eq(historyTags.userId, userId),
          eq(historyTags.wallet, normalizedWallet),
          eq(historyTags.txKey, txKey),
        ),
      );
    if (next.length > 0) {
      await tx
        .insert(historyTags)
        .values(next.map((tag) => ({ userId, wallet: normalizedWallet, txKey, tag })));
    }
  });
  return next;
}

/** Distinct tags for a wallet (filter dropdown + editor suggestions), alphabetical. */
export async function listDistinctTags(userId: string, wallet: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tag: historyTags.tag })
    .from(historyTags)
    .where(and(eq(historyTags.userId, userId), eq(historyTags.wallet, wallet.toLowerCase())))
    .orderBy(historyTags.tag);
  return rows.map((r) => r.tag);
}

export async function getTagsForItems(
  userId: string,
  wallet: string,
  txKeys: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (txKeys.length === 0) return out;
  const rows = await db
    .select({ txKey: historyTags.txKey, tag: historyTags.tag })
    .from(historyTags)
    .where(
      and(
        eq(historyTags.userId, userId),
        eq(historyTags.wallet, wallet.toLowerCase()),
        inArray(historyTags.txKey, txKeys),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.txKey) ?? [];
    list.push(r.tag);
    out.set(r.txKey, list);
  }
  return out;
}

/** txKeys carrying a tag (case-insensitive match) — used to filter history. */
export async function txKeysWithTag(
  userId: string,
  wallet: string,
  tag: string,
): Promise<string[]> {
  const rows = await db
    .select({ txKey: historyTags.txKey })
    .from(historyTags)
    .where(
      and(
        eq(historyTags.userId, userId),
        eq(historyTags.wallet, wallet.toLowerCase()),
        sql`lower(${historyTags.tag}) = ${tag.toLowerCase()}`,
      ),
    );
  return rows.map((r) => r.txKey);
}
