import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import type { MarketDb } from "@/server/market/candleCache";
import type { ContractCoin } from "@/server/market/coingecko";
import { ensureAsset, resolveCoinForContract } from "@/server/portfolio/tokenPrices";

const NOW = Date.parse("2026-07-24T12:00:00Z");
const DAY = 86_400_000;
const ADDR = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COIN: ContractCoin = { coingeckoId: "obscure", symbol: "OBS", name: "Obscure" };

let db: MarketDb;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let calls: string[];

function fetcher(result: ContractCoin | null) {
  return async (_platform: string, address: string) => {
    calls.push(address);
    return result;
  };
}

beforeEach(async () => {
  const pglite = new PGlite();
  testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as MarketDb;
  calls = [];
});

describe("resolveCoinForContract", () => {
  it("fetches once, lowercases the address, then serves from the cache", async () => {
    const first = await resolveCoinForContract(db, 1, ADDR, fetcher(COIN), () => NOW);
    const second = await resolveCoinForContract(db, 1, ADDR, fetcher(COIN), () => NOW + DAY);
    expect(first).toEqual(COIN);
    expect(second).toEqual(COIN);
    expect(calls).toEqual([ADDR.toLowerCase()]);
  });

  it("negative-caches unknown tokens and retries only after 30 days", async () => {
    expect(await resolveCoinForContract(db, 1, ADDR, fetcher(null), () => NOW)).toBeNull();
    expect(await resolveCoinForContract(db, 1, ADDR, fetcher(COIN), () => NOW + DAY)).toBeNull();
    expect(calls).toHaveLength(1); // negative cache answered the second call
    const late = await resolveCoinForContract(db, 1, ADDR, fetcher(COIN), () => NOW + 31 * DAY);
    expect(late).toEqual(COIN);
    expect(calls).toHaveLength(2);
    // The retry upgraded the row — cached positively now.
    await resolveCoinForContract(db, 1, ADDR, fetcher(null), () => NOW + 32 * DAY);
    expect(calls).toHaveLength(2);
  });

  it("returns null without fetching for chains with no CoinGecko platform", async () => {
    expect(await resolveCoinForContract(db, 999, ADDR, fetcher(COIN), () => NOW)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("ensureAsset", () => {
  it("creates a CoinGecko-only asset once and is idempotent", async () => {
    const a = await ensureAsset(db, COIN);
    const b = await ensureAsset(db, COIN);
    expect(a.id).toBe(b.id);
    expect(a.binanceSymbol).toBeNull();
    expect(a.symbol).toBe("OBS");
  });

  it("reuses a seeded major with its Binance pair intact", async () => {
    await testDb
      .insert(schema.assets)
      .values({ coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum", binanceSymbol: "ETHUSDT" });
    const row = await ensureAsset(db, { coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum" });
    expect(row.binanceSymbol).toBe("ETHUSDT");
  });
});
