import { and, asc, between, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { candles, candleSync, type assets } from "../db/schema";
import { fetchBinanceKlines } from "./binance";
import { coingeckoSupports, fetchCoinGeckoDailyCandles } from "./coingecko";
import { fetchHyperliquidCandles } from "./hyperliquid";
import { alignOpen, nextOpen, prevOpen, type Candle, type ChartInterval } from "./types";

// Loose db type so both the node-postgres app db and the PGlite test db fit.
export type MarketDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type AssetRow = typeof assets.$inferSelect;

export type CandleFetcher = (
  asset: AssetRow,
  interval: ChartInterval,
  fromMs: number,
  toMs: number,
) => Promise<Candle[]>;

export type CandleCacheDeps = {
  fetchBinance: CandleFetcher;
  fetchHyperliquid: CandleFetcher;
  fetchCoinGecko: CandleFetcher;
  now: () => number;
};

const defaultDeps: CandleCacheDeps = {
  fetchBinance: (asset, interval, from, to) =>
    fetchBinanceKlines(asset.binanceSymbol!, interval, from, to),
  fetchHyperliquid: (asset, interval, from, to) =>
    fetchHyperliquidCandles(asset.hyperliquidSymbol!, interval, from, to),
  fetchCoinGecko: (asset, _interval, from, to) =>
    fetchCoinGeckoDailyCandles(asset.coingeckoId, from, to),
  now: Date.now,
};

export type CandleSource = "binance" | "hyperliquid" | "coingecko";

/**
 * Provider priority: binance > hyperliquid > coingecko. One source per asset
 * per interval — the candles PK has no source component. Throws when the only
 * available source (CoinGecko) can't serve the interval.
 */
export function resolveCandleSource(asset: AssetRow, interval: ChartInterval): CandleSource {
  if (asset.binanceSymbol !== null) return "binance";
  if (asset.hyperliquidSymbol !== null) return "hyperliquid";
  if (!coingeckoSupports(interval)) {
    throw new Error(
      `Asset ${asset.symbol} has no Binance or Hyperliquid listing; only 1d candles are available via CoinGecko`,
    );
  }
  return "coingecko";
}

/** True when the asset has a source that can serve sub-daily intervals. */
export function hasIntradaySource(asset: AssetRow): boolean {
  return asset.binanceSymbol !== null || asset.hyperliquidSymbol !== null;
}

export type Span = { from: number; to: number };

export type GetCandlesResult = {
  candles: Candle[];
  /** Spans actually fetched from an upstream API (empty on a full cache hit). */
  fetched: Span[];
};

/**
 * Fetch-through OHLCV cache. Serves [fromMs, toMs] (bounds on candle open
 * time) from the DB, fetching only spans outside the recorded coverage
 * watermark. Closed candles are immutable; the currently-forming candle is
 * never requested or persisted. Alignment is calendar-aware: weeks open
 * Monday 00:00 UTC and months on the 1st, matching Binance.
 */
export async function getCandles(
  db: MarketDb,
  asset: AssetRow,
  interval: ChartInterval,
  fromMs: number,
  toMs: number,
  deps: CandleCacheDeps = defaultDeps,
): Promise<GetCandlesResult> {
  // Highest open time of a fully closed candle right now.
  const lastClosedOpen = prevOpen(deps.now(), interval);
  const from = alignOpen(Math.min(fromMs, toMs), interval);
  const to = Math.min(alignOpen(toMs, interval), lastClosedOpen);
  if (to < from) return { candles: [], fetched: [] };

  const source = resolveCandleSource(asset, interval);
  const fetcher = {
    binance: deps.fetchBinance,
    hyperliquid: deps.fetchHyperliquid,
    coingecko: deps.fetchCoinGecko,
  }[source];

  const [sync] = await db
    .select()
    .from(candleSync)
    .where(and(eq(candleSync.assetId, asset.id), eq(candleSync.interval, interval)));

  // Coverage is always contiguous [earliestT, latestT], so at most two
  // missing spans: before it and after it.
  const missing: Span[] = [];
  if (!sync) {
    missing.push({ from, to });
  } else {
    if (from < sync.earliestT) {
      missing.push({ from, to: Math.min(to, prevOpen(sync.earliestT, interval)) });
    }
    if (to > sync.latestT) {
      missing.push({ from: Math.max(from, nextOpen(sync.latestT, interval)), to });
    }
  }

  for (const span of missing) {
    const fetchedCandles = await fetcher(asset, interval, span.from, span.to);
    for (let i = 0; i < fetchedCandles.length; i += 5000) {
      const chunk = fetchedCandles.slice(i, i + 5000).map((c) => ({
        assetId: asset.id,
        interval,
        source,
        ...c,
      }));
      await db.insert(candles).values(chunk).onConflictDoNothing();
    }
  }

  if (missing.length > 0) {
    // Watermarks record the *requested* span even if the API returned fewer
    // candles (asset younger than `from`), so empty history isn't refetched.
    const earliestT = Math.min(from, sync?.earliestT ?? from);
    const latestT = Math.max(to, sync?.latestT ?? to);
    await db
      .insert(candleSync)
      .values({ assetId: asset.id, interval, earliestT, latestT })
      .onConflictDoUpdate({
        target: [candleSync.assetId, candleSync.interval],
        set: { earliestT, latestT },
      });
  }

  const rows = await db
    .select({
      t: candles.t,
      o: candles.o,
      h: candles.h,
      l: candles.l,
      c: candles.c,
      v: candles.v,
    })
    .from(candles)
    .where(
      and(eq(candles.assetId, asset.id), eq(candles.interval, interval), between(candles.t, from, to)),
    )
    .orderBy(asc(candles.t));

  return { candles: rows, fetched: missing };
}
