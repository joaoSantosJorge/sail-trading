import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/server/db/schema";
import { getNews, type NewsDb, type NewsDeps } from "@/server/news/newsCache";
import type { CryptoPanicPost } from "@/server/news/cryptopanic";

// newsConfigured() reads the env at call time — force "configured" for tests.
vi.mock("@/server/news/cryptopanic", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/news/cryptopanic")>();
  return { ...original, newsConfigured: () => true };
});

const NOW = Date.parse("2026-07-22T12:00:00Z");

function post(id: number, title: string, currencies: string[] = []): CryptoPanicPost {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    kind: "news",
    source: { domain: "example.com" },
    published_at: new Date(NOW - id * 60_000).toISOString(),
    currencies: currencies.map((code) => ({ code })),
  };
}

let db: NewsDb;
let fetchCalls: (string[] | undefined)[];
let deps: NewsDeps;
let clock: { now: number };

beforeEach(async () => {
  const pglite = new PGlite();
  const testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as NewsDb;

  fetchCalls = [];
  clock = { now: NOW };
  deps = {
    fetch: async (currencies) => {
      fetchCalls.push(currencies);
      return currencies?.length
        ? [post(10, "ETH pump", ["ETH"]), post(11, "ETH dump", ["ETH"])]
        : [post(1, "BTC news", ["BTC"]), post(2, "ETH news", ["ETH"]), post(3, "Macro news")];
    },
    now: () => clock.now,
  };
});

describe("newsCache", () => {
  it("fetches upstream once per TTL window, then serves from the DB", async () => {
    const first = await getNews(db, {}, deps);
    expect(fetchCalls).toHaveLength(1);
    expect(first.items).toHaveLength(3);
    expect(first.stale).toBe(false);

    clock.now += 5 * 60 * 1000; // within TTL
    const second = await getNews(db, {}, deps);
    expect(fetchCalls).toHaveLength(1); // no new upstream call
    expect(second.items).toHaveLength(3);

    clock.now += 6 * 60 * 1000; // past TTL
    await getNews(db, {}, deps);
    expect(fetchCalls).toHaveLength(2);
  });

  it("tracks separate TTL watermarks per currency filter and filters results", async () => {
    await getNews(db, {}, deps);
    const eth = await getNews(db, { currencies: ["ETH"] }, deps);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]).toEqual(["ETH"]);
    // Every returned item mentions ETH (from both the global and filtered fetches).
    expect(eth.items.length).toBeGreaterThan(0);
    for (const item of eth.items) {
      expect(item.currencies).toContain("ETH");
    }
  });

  it("serves the cache and flags stale when the upstream fails", async () => {
    await getNews(db, {}, deps);
    clock.now += 11 * 60 * 1000;
    deps.fetch = async () => {
      throw new Error("upstream down");
    };
    const result = await getNews(db, {}, deps);
    expect(result.stale).toBe(true);
    expect(result.items).toHaveLength(3); // cached items still served
  });

  it("dedupes by external id across refreshes", async () => {
    await getNews(db, {}, deps);
    clock.now += 11 * 60 * 1000;
    await getNews(db, {}, deps); // same posts again
    const result = await getNews(db, {}, deps);
    expect(result.items).toHaveLength(3); // no duplicates
  });
});
