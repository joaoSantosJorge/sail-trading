import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import {
  getCandles,
  type AssetRow,
  type CandleCacheDeps,
  type MarketDb,
} from "@/server/market/candleCache";
import { CHART_INTERVAL_MS, type Candle, type ChartInterval } from "@/server/market/types";

const HOUR = CHART_INTERVAL_MS["1h"];
// Fixed "now", aligned mid-candle: 2024-01-31T12:30:00Z.
const NOW = Date.parse("2024-01-31T12:30:00Z");
const LAST_CLOSED = Math.floor(NOW / HOUR) * HOUR - HOUR; // 11:00 open

function syntheticCandles(
  interval: ChartInterval,
  fromMs: number,
  toMs: number,
  birthMs = 0,
): Candle[] {
  const ms = CHART_INTERVAL_MS[interval];
  const out: Candle[] = [];
  for (let t = Math.ceil(fromMs / ms) * ms; t <= toMs; t += ms) {
    if (t < birthMs) continue; // asset didn't exist yet
    out.push({ t, o: 100, h: 110, l: 90, c: 105, v: 1000 });
  }
  return out;
}

let db: MarketDb;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let asset: AssetRow;
let calls: { from: number; to: number }[];
let deps: CandleCacheDeps;
let birthMs: number;

beforeEach(async () => {
  const pglite = new PGlite();
  testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as MarketDb;

  const [row] = await testDb
    .insert(schema.assets)
    .values({ coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum", binanceSymbol: "ETHUSDT" })
    .returning();
  asset = row;

  calls = [];
  birthMs = 0;
  deps = {
    fetchBinance: async (_asset, interval, from, to) => {
      calls.push({ from, to });
      return syntheticCandles(interval, from, to, birthMs);
    },
    fetchHyperliquid: async () => {
      throw new Error("hyperliquid should not be called for a Binance asset");
    },
    fetchCoinGecko: async () => {
      throw new Error("coingecko should not be called for a Binance asset");
    },
    now: () => NOW,
  };
});

describe("candleCache", () => {
  it("fetches the full span on a cold cache, then serves entirely from DB", async () => {
    const from = LAST_CLOSED - 99 * HOUR;
    const first = await getCandles(db, asset, "1h", from, LAST_CLOSED, deps);
    expect(calls).toHaveLength(1);
    expect(first.fetched).toEqual([{ from, to: LAST_CLOSED }]);
    expect(first.candles).toHaveLength(100);

    const second = await getCandles(db, asset, "1h", from, LAST_CLOSED, deps);
    expect(calls).toHaveLength(1); // no new upstream call
    expect(second.fetched).toEqual([]);
    expect(second.candles).toHaveLength(100);
  });

  it("fetches only the missing spans when the range extends past coverage", async () => {
    const from = LAST_CLOSED - 49 * HOUR;
    await getCandles(db, asset, "1h", from, LAST_CLOSED, deps);
    expect(calls).toHaveLength(1);

    // Extend 50 candles earlier and keep the same end: only the earlier gap is fetched.
    const earlier = from - 50 * HOUR;
    const result = await getCandles(db, asset, "1h", earlier, LAST_CLOSED, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ from: earlier, to: from - HOUR });
    expect(result.candles).toHaveLength(100);

    // A range inside coverage is a pure cache hit.
    await getCandles(db, asset, "1h", from, LAST_CLOSED - 10 * HOUR, deps);
    expect(calls).toHaveLength(2);
  });

  it("never requests or serves the still-forming candle", async () => {
    const from = LAST_CLOSED - 9 * HOUR;
    const result = await getCandles(db, asset, "1h", from, NOW, deps);
    // Requested `to` clamps to the last closed candle's open time.
    expect(calls[0].to).toBe(LAST_CLOSED);
    expect(Math.max(...result.candles.map((c) => c.t))).toBe(LAST_CLOSED);
  });

  it("routes a Hyperliquid-only asset to the Hyperliquid fetcher and tags the source", async () => {
    const [hlAsset] = await testDb
      .insert(schema.assets)
      .values({
        coingeckoId: "hyperliquid",
        symbol: "HYPE",
        name: "Hyperliquid",
        binanceSymbol: null,
        hyperliquidSymbol: "HYPE",
      })
      .returning();

    const hlCalls: { from: number; to: number }[] = [];
    const hlDeps: CandleCacheDeps = {
      ...deps,
      fetchBinance: async () => {
        throw new Error("binance should not be called for a Hyperliquid-only asset");
      },
      fetchHyperliquid: async (_asset, interval, from, to) => {
        hlCalls.push({ from, to });
        return syntheticCandles(interval, from, to);
      },
    };

    const from = LAST_CLOSED - 9 * HOUR;
    const result = await getCandles(db, hlAsset, "1h", from, LAST_CLOSED, hlDeps);
    expect(hlCalls).toHaveLength(1);
    expect(result.candles).toHaveLength(10);

    const stored = await testDb
      .select({ source: schema.candles.source })
      .from(schema.candles)
      .where(eq(schema.candles.assetId, hlAsset.id));
    expect(new Set(stored.map((r) => r.source))).toEqual(new Set(["hyperliquid"]));
  });

  it("prefers Binance when an asset has both Binance and Hyperliquid symbols", async () => {
    const both = { ...asset, hyperliquidSymbol: "ETH" };
    const from = LAST_CLOSED - 4 * HOUR;
    const result = await getCandles(db, both, "1h", from, LAST_CLOSED, deps);
    // deps.fetchHyperliquid throws, so completing proves Binance was used.
    expect(result.candles).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it("rejects sub-daily intervals for a CoinGecko-only asset", async () => {
    const cgOnly = { ...asset, binanceSymbol: null, hyperliquidSymbol: null };
    await expect(getCandles(db, cgOnly, "1h", LAST_CLOSED - HOUR, LAST_CLOSED, deps)).rejects.toThrow(
      /only 1d candles/,
    );
  });

  it("records requested coverage even when the asset is younger than the range", async () => {
    birthMs = LAST_CLOSED - 9 * HOUR; // only 10 candles of history exist
    const from = LAST_CLOSED - 99 * HOUR;
    const first = await getCandles(db, asset, "1h", from, LAST_CLOSED, deps);
    expect(first.candles).toHaveLength(10);

    // The empty pre-birth history must not be refetched on the next call.
    const second = await getCandles(db, asset, "1h", from, LAST_CLOSED, deps);
    expect(calls).toHaveLength(1);
    expect(second.candles).toHaveLength(10);
  });
});
