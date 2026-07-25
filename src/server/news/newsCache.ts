import { desc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { newsItems, newsSync } from "../db/schema";
import { fetchPosts, newsConfigured, type CryptoPanicPost } from "./cryptopanic";

/**
 * Fetch-through news cache, mirroring the candle-cache pattern: a TTL
 * watermark per upstream filter; within TTL every request is served from the
 * DB, past it one upstream fetch refreshes the cache. Quota-insensitive by
 * construction — upstream is hit at most once per filter per TTL window.
 */

export type NewsDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const TTL_MS = 10 * 60 * 1000;

export type NewsQuery = {
  /** Uppercase currency codes, e.g. ["ETH"]. Empty/omitted = global feed. */
  currencies?: string[];
  limit?: number;
};

export type NewsItem = typeof newsItems.$inferSelect;

export type NewsDeps = {
  fetch: (currencies?: string[]) => Promise<CryptoPanicPost[]>;
  now: () => number;
};

const defaultDeps: NewsDeps = { fetch: fetchPosts, now: Date.now };

function filterKey(currencies?: string[]): string {
  return currencies?.length ? `currency:${[...currencies].sort().join(",")}` : "all";
}

async function upsertPosts(db: NewsDb, posts: CryptoPanicPost[]): Promise<void> {
  if (posts.length === 0) return;
  const values = posts.map((p) => ({
    source: "cryptopanic",
    externalId: String(p.id),
    title: p.title,
    url: p.url ?? `https://cryptopanic.com/news/${p.id}/`,
    kind: p.kind ?? null,
    sourceDomain: p.source?.domain ?? p.domain ?? null,
    currencies: (p.currencies ?? []).map((c) => c.code.toUpperCase()),
    publishedAt: new Date(p.published_at),
    panicScore: p.panic_score ?? null,
    raw: p as unknown as Record<string, unknown>,
  }));
  await db.insert(newsItems).values(values).onConflictDoNothing();
}

/**
 * Serve news for the query, refreshing from upstream when the filter's TTL
 * expired. Returns { items, stale }: stale=true when the key is missing so
 * the upstream was never fetched (unconfigured) or the refresh failed.
 */
export async function getNews(
  db: NewsDb,
  query: NewsQuery,
  deps: NewsDeps = defaultDeps,
): Promise<{ items: NewsItem[]; stale: boolean; configured: boolean }> {
  const key = filterKey(query.currencies);
  const limit = Math.min(query.limit ?? 30, 50);
  const configured = newsConfigured();
  let stale = !configured;

  if (configured) {
    const [row] = await db.select().from(newsSync).where(eq(newsSync.filterKey, key));
    const expired = !row || deps.now() - row.fetchedAt.getTime() > TTL_MS;
    if (expired) {
      try {
        const posts = await deps.fetch(query.currencies);
        await upsertPosts(db, posts);
        await db
          .insert(newsSync)
          .values({ filterKey: key, fetchedAt: new Date(deps.now()) })
          .onConflictDoUpdate({
            target: newsSync.filterKey,
            set: { fetchedAt: new Date(deps.now()) },
          });
      } catch (err) {
        console.error("[news] upstream refresh failed; serving cache", err);
        stale = true;
      }
    }
  }

  const rows = query.currencies?.length
    ? await db
        .select()
        .from(newsItems)
        .where(
          // jsonb array containment: item.currencies ⊇ any of the requested codes.
          sql`${newsItems.currencies} ?| array[${sql.join(
            query.currencies.map((c) => sql`${c.toUpperCase()}`),
            sql`, `,
          )}]`,
        )
        .orderBy(desc(newsItems.publishedAt))
        .limit(limit)
    : await db.select().from(newsItems).orderBy(desc(newsItems.publishedAt)).limit(limit);

  return { items: rows, stale, configured };
}
