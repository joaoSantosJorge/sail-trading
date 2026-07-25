import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/server/db/schema";
import type { MarketDb } from "@/server/market/candleCache";
import {
  getFundingRates,
  type FundingCacheDeps,
  type FundingRate,
} from "@/server/market/fundingCache";

const HOUR = 60 * 60 * 1000;
// Fixed "now" mid-hour, so the last settled funding event is two boundaries back.
const NOW = Date.parse("2024-01-31T12:30:00Z");
const LAST_SETTLED = Math.floor(NOW / HOUR) * HOUR - HOUR;

function syntheticRates(fromMs: number, toMs: number): FundingRate[] {
  const out: FundingRate[] = [];
  for (let t = Math.ceil(fromMs / HOUR) * HOUR; t <= toMs; t += HOUR) {
    out.push({ t, rate: 0.0000125 });
  }
  return out;
}

let db: MarketDb;
let calls: { from: number; to: number }[];
let deps: FundingCacheDeps;

beforeEach(async () => {
  const pglite = new PGlite();
  const testDb = drizzle(pglite, { schema });
  await migrate(testDb, { migrationsFolder: "./drizzle" });
  db = testDb as unknown as MarketDb;
  calls = [];
  deps = {
    fetchFunding: async (_coin, from, to) => {
      calls.push({ from, to });
      return syntheticRates(from, to);
    },
    now: () => NOW,
  };
});

describe("fundingCache", () => {
  it("fetches the full span cold, then serves from the DB", async () => {
    const from = LAST_SETTLED - 99 * HOUR;
    const first = await getFundingRates(db, "HYPE", from, LAST_SETTLED, deps);
    expect(calls).toHaveLength(1);
    expect(first).toHaveLength(100);

    const second = await getFundingRates(db, "HYPE", from, LAST_SETTLED, deps);
    expect(calls).toHaveLength(1); // cache hit — no upstream call
    expect(second).toEqual(first);
  });

  it("fetches only the missing earlier span when the range extends back", async () => {
    const from = LAST_SETTLED - 49 * HOUR;
    await getFundingRates(db, "HYPE", from, LAST_SETTLED, deps);
    const earlier = from - 50 * HOUR;
    const result = await getFundingRates(db, "HYPE", earlier, LAST_SETTLED, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ from: earlier, to: from - HOUR });
    expect(result).toHaveLength(100);
  });

  it("never requests the still-forming funding hour", async () => {
    const from = LAST_SETTLED - 9 * HOUR;
    const result = await getFundingRates(db, "HYPE", from, NOW, deps);
    expect(calls[0].to).toBe(LAST_SETTLED);
    expect(Math.max(...result.map((r) => r.t))).toBe(LAST_SETTLED);
  });

  it("keeps coins isolated", async () => {
    const from = LAST_SETTLED - 9 * HOUR;
    await getFundingRates(db, "HYPE", from, LAST_SETTLED, deps);
    const other = await getFundingRates(db, "BTC", from, LAST_SETTLED, deps);
    expect(calls).toHaveLength(2);
    expect(other).toHaveLength(10);
  });
});
