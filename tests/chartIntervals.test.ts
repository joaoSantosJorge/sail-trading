import { PGlite } from "@electric-sql/pglite";
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
import {
  alignOpen,
  nextOpen,
  prevOpen,
  type Candle,
  type ChartInterval,
} from "@/server/market/types";

const ts = (iso: string) => Date.parse(iso);

describe("calendar-aware alignment", () => {
  it("floors fixed intervals to a multiple of their duration", () => {
    expect(alignOpen(ts("2024-01-31T12:34:56Z"), "5m")).toBe(ts("2024-01-31T12:30:00Z"));
    expect(alignOpen(ts("2024-01-31T12:34:56Z"), "4h")).toBe(ts("2024-01-31T12:00:00Z"));
    expect(prevOpen(ts("2024-01-31T12:34:56Z"), "1d")).toBe(ts("2024-01-30T00:00:00Z"));
    expect(nextOpen(ts("2024-01-31T12:34:56Z"), "1h")).toBe(ts("2024-01-31T13:00:00Z"));
  });

  it("aligns weeks to Monday 00:00 UTC", () => {
    // 2024-01-31 is a Wednesday; that week's Monday is the 29th.
    expect(alignOpen(ts("2024-01-31T12:30:00Z"), "1w")).toBe(ts("2024-01-29T00:00:00Z"));
    // A Monday aligns to itself.
    expect(alignOpen(ts("2024-01-29T00:00:00Z"), "1w")).toBe(ts("2024-01-29T00:00:00Z"));
    // Sunday belongs to the week that started the previous Monday.
    expect(alignOpen(ts("2023-12-31T23:59:59Z"), "1w")).toBe(ts("2023-12-25T00:00:00Z"));
    // Across the year boundary: 2024-01-01 is a Monday.
    expect(nextOpen(ts("2023-12-27T00:00:00Z"), "1w")).toBe(ts("2024-01-01T00:00:00Z"));
    expect(prevOpen(ts("2024-01-03T00:00:00Z"), "1w")).toBe(ts("2023-12-25T00:00:00Z"));
  });

  it("aligns months to the 1st 00:00 UTC, handling irregular lengths", () => {
    expect(alignOpen(ts("2024-01-31T23:59:59Z"), "1M")).toBe(ts("2024-01-01T00:00:00Z"));
    expect(nextOpen(ts("2024-01-31T00:00:00Z"), "1M")).toBe(ts("2024-02-01T00:00:00Z"));
    // Leap February.
    expect(nextOpen(ts("2024-02-01T00:00:00Z"), "1M")).toBe(ts("2024-03-01T00:00:00Z"));
    expect(alignOpen(ts("2024-02-29T12:00:00Z"), "1M")).toBe(ts("2024-02-01T00:00:00Z"));
    // Year boundaries in both directions.
    expect(nextOpen(ts("2023-12-15T00:00:00Z"), "1M")).toBe(ts("2024-01-01T00:00:00Z"));
    expect(prevOpen(ts("2024-01-15T00:00:00Z"), "1M")).toBe(ts("2023-12-01T00:00:00Z"));
  });
});

// Candles at every Binance-aligned open inside [fromMs, toMs].
function alignedCandles(interval: ChartInterval, fromMs: number, toMs: number): Candle[] {
  const out: Candle[] = [];
  let t = alignOpen(fromMs, interval);
  if (t < fromMs) t = nextOpen(t, interval);
  for (; t <= toMs; t = nextOpen(t, interval)) {
    out.push({ t, o: 100, h: 110, l: 90, c: 105, v: 1000 });
  }
  return out;
}

describe("candleCache with calendar intervals", () => {
  let db: MarketDb;
  let asset: AssetRow;
  let calls: { from: number; to: number }[];
  const deps = (now: number): CandleCacheDeps => ({
    fetchBinance: async (_asset, interval, from, to) => {
      calls.push({ from, to });
      return alignedCandles(interval, from, to);
    },
    fetchCoinGecko: async () => {
      throw new Error("coingecko should not be called for a Binance asset");
    },
    now: () => now,
  });

  beforeEach(async () => {
    const pglite = new PGlite();
    const testDb = drizzle(pglite, { schema });
    await migrate(testDb, { migrationsFolder: "./drizzle" });
    db = testDb as unknown as MarketDb;
    const [row] = await testDb
      .insert(schema.assets)
      .values({ coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum", binanceSymbol: "ETHUSDT" })
      .returning();
    asset = row;
    calls = [];
  });

  it("1w: never requests the forming week and aligns spans to Mondays", async () => {
    // Wednesday mid-week: the forming candle opened Monday 2024-01-29.
    const now = ts("2024-01-31T12:30:00Z");
    const lastClosed = ts("2024-01-22T00:00:00Z");

    const from = ts("2023-11-01T00:00:00Z"); // a Wednesday — must align down to Monday Oct 30
    const result = await getCandles(db, asset, "1w", from, now, deps(now));

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe(ts("2023-10-30T00:00:00Z"));
    expect(calls[0].to).toBe(lastClosed);
    expect(Math.max(...result.candles.map((c) => c.t))).toBe(lastClosed);
    for (const c of result.candles) {
      expect(alignOpen(c.t, "1w")).toBe(c.t);
    }

    // Second call is a pure cache hit.
    const second = await getCandles(db, asset, "1w", from, now, deps(now));
    expect(calls).toHaveLength(1);
    expect(second.fetched).toEqual([]);
  });

  it("1M: never requests the forming month and extends coverage by calendar months", async () => {
    // Mid-January: the forming candle opened 2024-01-01; last closed is Dec.
    const now = ts("2024-01-31T12:30:00Z");
    const lastClosed = ts("2023-12-01T00:00:00Z");

    const from = ts("2023-06-15T00:00:00Z");
    const first = await getCandles(db, asset, "1M", from, now, deps(now));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ from: ts("2023-06-01T00:00:00Z"), to: lastClosed });
    expect(first.candles.map((c) => c.t)).toEqual([
      ts("2023-06-01T00:00:00Z"),
      ts("2023-07-01T00:00:00Z"),
      ts("2023-08-01T00:00:00Z"),
      ts("2023-09-01T00:00:00Z"),
      ts("2023-10-01T00:00:00Z"),
      ts("2023-11-01T00:00:00Z"),
      ts("2023-12-01T00:00:00Z"),
    ]);

    // Extend the range earlier: only the missing months are fetched, and the
    // gap boundary steps back one *calendar* month (May 1), not 30 days.
    const earlier = ts("2023-02-10T00:00:00Z");
    const second = await getCandles(db, asset, "1M", earlier, now, deps(now));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ from: ts("2023-02-01T00:00:00Z"), to: ts("2023-05-01T00:00:00Z") });
    expect(second.candles).toHaveLength(11);
  });

  it("1M: a month later, only the newly closed month is fetched", async () => {
    const from = ts("2023-06-01T00:00:00Z");
    await getCandles(db, asset, "1M", from, ts("2024-01-31T12:30:00Z"), deps(ts("2024-01-31T12:30:00Z")));
    expect(calls).toHaveLength(1);

    // Now it's mid-February: January has closed.
    const later = ts("2024-02-15T09:00:00Z");
    const result = await getCandles(db, asset, "1M", from, later, deps(later));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ from: ts("2024-01-01T00:00:00Z"), to: ts("2024-01-01T00:00:00Z") });
    expect(Math.max(...result.candles.map((c) => c.t))).toBe(ts("2024-01-01T00:00:00Z"));
  });
});
