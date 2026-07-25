import { and, asc, between, eq } from "drizzle-orm";
import { fundingRates, fundingSync } from "../db/schema";
import { fundingHistory } from "../hyperliquid/info";
import type { MarketDb } from "./candleCache";
import type { Candle } from "./types";

/**
 * Fetch-through cache for hourly perp funding rates (Hyperliquid), mirroring
 * candleCache: contiguous [earliestT, latestT] coverage per coin, at most two
 * missing spans fetched per call. Watermarks record the REQUESTED span even
 * when the venue returned fewer rows (history depth is venue-bounded), so
 * empty history isn't refetched.
 */

const HOUR_MS = 60 * 60 * 1000;

export type FundingRate = { t: number; rate: number };

export type FundingFetcher = (coin: string, fromMs: number, toMs: number) => Promise<FundingRate[]>;

export type FundingCacheDeps = {
  fetchFunding: FundingFetcher;
  now: () => number;
};

const defaultDeps: FundingCacheDeps = {
  fetchFunding: async (coin, from, to) =>
    (await fundingHistory(coin, from, to)).map((e) => ({ t: e.time, rate: Number(e.fundingRate) })),
  now: Date.now,
};

export async function getFundingRates(
  db: MarketDb,
  coin: string,
  fromMs: number,
  toMs: number,
  deps: FundingCacheDeps = defaultDeps,
): Promise<FundingRate[]> {
  const from = Math.floor(Math.min(fromMs, toMs) / HOUR_MS) * HOUR_MS;
  // Only settled (past) funding events; the current hour is still forming.
  const to = Math.min(Math.floor(toMs / HOUR_MS) * HOUR_MS, Math.floor(deps.now() / HOUR_MS) * HOUR_MS - HOUR_MS);
  if (to < from) return [];

  const [sync] = await db.select().from(fundingSync).where(eq(fundingSync.coin, coin));

  const missing: { from: number; to: number }[] = [];
  if (!sync) {
    missing.push({ from, to });
  } else {
    if (from < sync.earliestT) missing.push({ from, to: Math.min(to, sync.earliestT - HOUR_MS) });
    if (to > sync.latestT) missing.push({ from: Math.max(from, sync.latestT + HOUR_MS), to });
  }

  for (const span of missing) {
    const fetched = await deps.fetchFunding(coin, span.from, span.to);
    for (let i = 0; i < fetched.length; i += 5000) {
      const chunk = fetched.slice(i, i + 5000).map((r) => ({ coin, t: r.t, rate: r.rate }));
      if (chunk.length > 0) await db.insert(fundingRates).values(chunk).onConflictDoNothing();
    }
  }

  if (missing.length > 0) {
    const earliestT = Math.min(from, sync?.earliestT ?? from);
    const latestT = Math.max(to, sync?.latestT ?? to);
    await db
      .insert(fundingSync)
      .values({ coin, earliestT, latestT })
      .onConflictDoUpdate({ target: [fundingSync.coin], set: { earliestT, latestT } });
  }

  return db
    .select({ t: fundingRates.t, rate: fundingRates.rate })
    .from(fundingRates)
    .where(and(eq(fundingRates.coin, coin), between(fundingRates.t, from, to)))
    .orderBy(asc(fundingRates.t));
}

/**
 * PURE: sum hourly funding events into a per-bar series aligned 1:1 with the
 * candles (event t falls in [bar.t, bar.t + intervalMs)). Bars outside the
 * fetched funding history simply get 0 — the engine treats missing data as
 * no funding, and the run service surfaces that as an assumption.
 */
export function alignFundingToBars(
  rates: FundingRate[],
  candles: Candle[],
  intervalMs: number,
): number[] {
  const out = new Array<number>(candles.length).fill(0);
  if (candles.length === 0 || rates.length === 0) return out;
  let bar = 0;
  for (const r of rates) {
    while (bar < candles.length && r.t >= candles[bar].t + intervalMs) bar++;
    if (bar >= candles.length) break;
    if (r.t >= candles[bar].t) out[bar] += r.rate;
  }
  return out;
}
