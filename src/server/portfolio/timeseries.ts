import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import { walletTransfers } from "@/server/db/schema";
import type { MarketDb } from "@/server/market/candleCache";
import { getSpotUsd } from "@/server/market/spot";
import { latestSnapshots } from "./service";
import {
  ensureAsset,
  getDailyCloses,
  NATIVE_COINGECKO_ID,
  resolveCoinForContract,
} from "./tokenPrices";
import {
  alignToDay,
  DAY_MS,
  reconstructDailyBalances,
  sampleMonthly,
  valuePortfolioSeries,
  type AssetKey,
  type SeriesPoint,
  type TransferDelta,
} from "./valuation";

/**
 * Portfolio value over time via full reconstruction: current holdings are
 * walked backwards through the cached transfer history and valued with daily
 * closes from the candle cache. Historical values are estimates — gas spend
 * and uncovered transfer types drift the far past; the newest point is always
 * the live snapshot total so the chart agrees with the summary cards.
 */

export type TimeseriesRange = "7d" | "30d" | "90d" | "1y" | "all";

export type PortfolioTimeseries = {
  range: TimeseriesRange;
  granularity: "day" | "month";
  points: SeriesPoint[];
  /** Per-symbol USD series — only populated when `symbols` was requested. */
  perAsset: { symbol: string; points: { t: number; usd: number }[] }[];
  /** Current symbols with aggregated USD value, for the asset filter. */
  available: { symbol: string; valueUsd: number }[];
  /** Held but not in the historical series (dust or no price history). */
  excluded: { symbol: string; valueUsd: number }[];
};

const RANGE_DAYS: Record<Exclude<TimeseriesRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

// Cap CoinGecko work per request: at most this many priced assets, and skip
// holdings below the dust floor entirely (spam airdrops would burn the budget).
const MAX_PRICED_ASSETS = 30;
const DUST_USD = 0.5;

const MEMO_TTL_MS = 10 * 60 * 1000;
const memo = new Map<string, { at: number; value: PortfolioTimeseries }>();

/** Test hook — the memo is module-global state. */
export function clearTimeseriesMemo(): void {
  memo.clear();
}

type KeyAgg = { key: AssetKey; symbol: string; balance: number; valueUsd: number };

export type TimeseriesOpts = {
  range: TimeseriesRange;
  granularity: "day" | "month";
  symbols?: string[];
  /** Restrict to these wallet addresses (lowercase); absent = all wallets. */
  wallets?: string[];
};

export async function getPortfolioTimeseries(
  userId: string,
  opts: TimeseriesOpts,
): Promise<PortfolioTimeseries> {
  const memoKey = `${userId}|${opts.range}|${opts.granularity}|${(opts.symbols ?? []).join(",")}|${(opts.wallets ?? []).join(",")}`;
  const hit = memo.get(memoKey);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;

  const result = await computeTimeseries(userId, opts);
  memo.set(memoKey, { at: Date.now(), value: result });
  return result;
}

async function computeTimeseries(
  userId: string,
  opts: TimeseriesOpts,
): Promise<PortfolioTimeseries> {
  let snapshots = await latestSnapshots(userId);
  if (opts.wallets && opts.wallets.length > 0) {
    const wanted = new Set(opts.wallets);
    snapshots = snapshots.filter((w) => wanted.has(w.address));
  }
  const walletAddresses = snapshots.map((w) => w.address);

  // Aggregate current holdings across wallets by asset key.
  const byKey = new Map<AssetKey, KeyAgg>();
  for (const w of snapshots) {
    for (const p of w.positions) {
      const key: AssetKey = `${p.chainId}:${p.tokenAddress?.toLowerCase() ?? "native"}`;
      const agg = byKey.get(key) ?? { key, symbol: p.symbol, balance: 0, valueUsd: 0 };
      agg.balance += Number(p.balance) || 0;
      agg.valueUsd += p.valueUsd ?? 0;
      byKey.set(key, agg);
    }
  }
  const holdings = [...byKey.values()];
  const totalUsdNow = snapshots.reduce((a, w) => a + w.totalUsd, 0);

  const bySymbolValue = new Map<string, number>();
  for (const h of holdings) {
    bySymbolValue.set(h.symbol, (bySymbolValue.get(h.symbol) ?? 0) + h.valueUsd);
  }
  const available = [...bySymbolValue.entries()]
    .map(([symbol, valueUsd]) => ({ symbol, valueUsd }))
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const empty: PortfolioTimeseries = {
    range: opts.range,
    granularity: opts.granularity,
    points: [],
    perAsset: [],
    available,
    excluded: [],
  };
  if (walletAddresses.length === 0 || holdings.length === 0) return empty;

  // Range start. "all" reaches back to the earliest cached transfer.
  const now = Date.now();
  let fromDay: number;
  if (opts.range === "all") {
    const rows = await db
      .select({ ts: walletTransfers.ts })
      .from(walletTransfers)
      .where(and(eq(walletTransfers.userId, userId), inArray(walletTransfers.wallet, walletAddresses)))
      .orderBy(walletTransfers.ts)
      .limit(1);
    fromDay = alignToDay(rows[0]?.ts.getTime() ?? now - 30 * DAY_MS);
  } else {
    fromDay = alignToDay(now - RANGE_DAYS[opts.range] * DAY_MS);
  }
  const toDay = alignToDay(now);

  // Pick which holdings get priced: top by current value, above the dust
  // floor. The rest still exist in the reconstruction but stay unvalued and
  // are reported as excluded.
  const ranked = [...holdings].sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd));
  const candidates = ranked.filter((h) => Math.abs(h.valueUsd) >= DUST_USD).slice(0, MAX_PRICED_ASSETS);
  const excludedAgg = new Map<string, number>();
  for (const h of ranked) {
    if (!candidates.includes(h)) {
      excludedAgg.set(h.symbol, (excludedAgg.get(h.symbol) ?? 0) + h.valueUsd);
    }
  }

  // Resolve each candidate to a CoinGecko-backed asset and load daily closes.
  const marketDb = db as unknown as MarketDb;
  const closes = new Map<AssetKey, Map<number, number>>();
  const symbols = new Map<AssetKey, string>();
  for (const h of holdings) symbols.set(h.key, h.symbol);
  for (const h of candidates) {
    const [chainIdStr, addr] = [h.key.slice(0, h.key.indexOf(":")), h.key.slice(h.key.indexOf(":") + 1)];
    const chainId = Number(chainIdStr);
    const coin =
      addr === "native"
        ? NATIVE_COINGECKO_ID[chainId]
          ? { coingeckoId: NATIVE_COINGECKO_ID[chainId], symbol: h.symbol, name: h.symbol }
          : null
        : await resolveCoinForContract(marketDb, chainId, addr);
    if (!coin) {
      excludedAgg.set(h.symbol, (excludedAgg.get(h.symbol) ?? 0) + h.valueUsd);
      continue;
    }
    try {
      const asset = await ensureAsset(marketDb, coin);
      closes.set(h.key, await getDailyCloses(marketDb, asset, fromDay - DAY_MS, toDay));
    } catch {
      // Price history unavailable (upstream error) — exclude, don't fail.
      excludedAgg.set(h.symbol, (excludedAgg.get(h.symbol) ?? 0) + h.valueUsd);
    }
  }

  // BTC daily closes for the BTC-denominated series (seeded major).
  let btcCloses = new Map<number, number>();
  try {
    const btcAsset = await ensureAsset(marketDb, {
      coingeckoId: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
    });
    btcCloses = await getDailyCloses(marketDb, btcAsset, fromDay - DAY_MS, toDay);
  } catch {
    // btc column degrades to null.
  }

  // Transfer deltas inside the window (reconstruction only needs what's after fromDay).
  const transferRows = await db
    .select()
    .from(walletTransfers)
    .where(
      and(
        eq(walletTransfers.userId, userId),
        inArray(walletTransfers.wallet, walletAddresses),
        gte(walletTransfers.ts, new Date(fromDay)),
      ),
    );
  const deltas: TransferDelta[] = [];
  for (const t of transferRows) {
    if (t.chainId === null || t.amount === null) continue;
    const amount = Number(t.amount);
    if (!Number.isFinite(amount)) continue;
    const key: AssetKey =
      t.category === "external" || t.category === "internal"
        ? `${t.chainId}:native`
        : t.assetAddress
          ? `${t.chainId}:${t.assetAddress.toLowerCase()}`
          : `${t.chainId}:native`;
    const delta = t.direction === "self" ? 0 : t.direction === "in" ? amount : -amount;
    deltas.push({ key, ts: t.ts.getTime(), delta });
  }

  const { days, balances } = reconstructDailyBalances(
    holdings.map((h) => ({ key: h.key, balance: h.balance })),
    deltas,
    fromDay,
    toDay,
  );
  const valued = valuePortfolioSeries(days, balances, symbols, closes, btcCloses);

  // Anchor the right edge to the live snapshot totals (includes excluded
  // holdings), so the chart always matches the summary cards.
  const btcSpot = await getSpotUsd("bitcoin");
  const points = [...valued.points, { t: now, usd: totalUsdNow, btc: btcSpot ? totalUsdNow / btcSpot : null }];

  const wanted = new Set((opts.symbols ?? []).map((s) => s.toUpperCase()));
  let perAsset: PortfolioTimeseries["perAsset"] = [];
  if (wanted.size > 0) {
    perAsset = [...valued.perAsset.entries()]
      .filter(([symbol]) => wanted.has(symbol.toUpperCase()))
      .map(([symbol, series]) => {
        const nowUsd = bySymbolValue.get(symbol) ?? series[series.length - 1]?.usd ?? 0;
        return { symbol, points: [...series, { t: now, usd: nowUsd }] };
      });
  }

  const result: PortfolioTimeseries = {
    range: opts.range,
    granularity: opts.granularity,
    points: opts.granularity === "month" ? sampleMonthly(points) : points,
    perAsset:
      opts.granularity === "month"
        ? perAsset.map((a) => ({ ...a, points: sampleMonthly(a.points) }))
        : perAsset,
    available,
    excluded: [...excludedAgg.entries()]
      .map(([symbol, valueUsd]) => ({ symbol, valueUsd }))
      .sort((a, b) => b.valueUsd - a.valueUsd),
  };
  return result;
}
