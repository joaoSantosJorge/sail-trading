import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { renderCondition, renderIndicators, renderRisk } from "@/lib/dslRender";
import { db } from "@/server/db";
import { assets, backtestRuns, strategies } from "@/server/db/schema";
import type { Metrics } from "@/server/engine/metrics";
import type { StrategyDSL } from "@/server/engine/types";
import {
  computeIndicatorSnapshots,
  INDICATOR_TYPES,
  type IndicatorRequest,
} from "@/lib/indicators/snapshots";
import { getCandles, type AssetRow } from "@/server/market/candleCache";
import { INTERVAL_MS, type Candle, type Interval } from "@/server/market/types";

/**
 * Read-tool registry: zod input schema + description + run(userId, input).
 * Every run is scoped to the session-bound userId (market data is global;
 * strategies/backtests are per-user). Tools never throw across the bridge —
 * sdk-tools converts throws into { error } results.
 */

export type ReadToolCtx = { userId: string; currentThreadId?: string };

export type ReadToolEntry = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (ctx: ReadToolCtx, input: never) => Promise<unknown>;
};

const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
const round = (v: number, d = 2) => Number(v.toFixed(d));

async function assetById(assetId: number): Promise<AssetRow | null> {
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId));
  return row ?? null;
}

async function snapshotForAsset(asset: AssetRow) {
  const now = Date.now();
  const day = INTERVAL_MS["1d"];
  const { candles } = await getCandles(db, asset, "1d", now - 91 * day, now);
  if (candles.length === 0) return { assetId: asset.id, symbol: asset.symbol, error: "no data" };
  const last = candles[candles.length - 1];
  const at = (daysAgo: number) => candles[candles.length - 1 - daysAgo]?.c;
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const hi90 = Math.max(...highs);
  const lo90 = Math.min(...lows);
  return {
    assetId: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    lastClose: last.c,
    lastCandleDate: new Date(last.t).toISOString().slice(0, 10),
    change24hPct: at(1) !== undefined ? round(pct(last.c, at(1)!)) : null,
    change7dPct: at(7) !== undefined ? round(pct(last.c, at(7)!)) : null,
    change30dPct: at(30) !== undefined ? round(pct(last.c, at(30)!)) : null,
    volume30dAvg: round(
      candles.slice(-30).reduce((a, c) => a + c.v, 0) / Math.min(30, candles.length),
    ),
    distanceFrom90dHighPct: round(pct(last.c, hi90)),
    distanceFrom90dLowPct: round(pct(last.c, lo90)),
  };
}

function candleStats(candlesArr: Candle[], interval: Interval) {
  const first = candlesArr[0];
  const last = candlesArr[candlesArr.length - 1];
  const high = Math.max(...candlesArr.map((c) => c.h));
  const low = Math.min(...candlesArr.map((c) => c.l));
  // Realized volatility: stdev of per-bar log returns, annualized.
  const rets: number[] = [];
  for (let i = 1; i < candlesArr.length; i++) {
    rets.push(Math.log(candlesArr[i].c / candlesArr[i - 1].c));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
  const barsPerYear = (365 * 24 * 60 * 60 * 1000) / INTERVAL_MS[interval];
  return {
    bars: candlesArr.length,
    from: new Date(first.t).toISOString(),
    to: new Date(last.t).toISOString(),
    open: first.o,
    close: last.c,
    high,
    low,
    changePct: round(pct(last.c, first.o)),
    realizedVolAnnualPct: round(Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100),
    lastCandles: candlesArr.slice(-10),
  };
}

function headlineMetrics(metrics: Metrics | null) {
  if (!metrics) return null;
  return {
    totalReturnPct: round(metrics.totalReturnPct),
    buyHoldReturnPct: round(metrics.buyHoldReturnPct),
    maxDrawdownPct: round(metrics.maxDrawdownPct),
    sharpe: round(metrics.sharpe, 3),
    winRatePct: round(metrics.winRatePct, 1),
    tradeCount: metrics.tradeCount,
  };
}

export const READ_TOOLS: ReadToolEntry[] = [
  {
    name: "list_assets",
    description:
      "List the assets available for analysis and backtesting: id, symbol, name, and data source. Call this before referring to any asset id.",
    schema: z.object({}),
    run: async () => {
      const rows = await db.select().from(assets).orderBy(assets.id);
      return {
        assets: rows.map((a) => ({
          id: a.id,
          symbol: a.symbol,
          name: a.name,
          source: a.binanceSymbol ? "binance" : a.hyperliquidSymbol ? "hyperliquid" : "coingecko",
        })),
      };
    },
  },
  {
    name: "get_market_snapshot",
    description:
      "Current market snapshot per asset: last daily close, 24h/7d/30d % change, 30d average volume, distance from 90d high/low. Computed from cached daily candles (last CLOSED bar, not live). Omit assetIds for all assets.",
    schema: z.object({
      assetIds: z.array(z.number().int()).max(10).optional(),
    }),
    run: async (_ctx, input: { assetIds?: number[] }) => {
      let rows = await db.select().from(assets).orderBy(assets.id);
      if (input.assetIds?.length) {
        rows = rows.filter((a) => input.assetIds!.includes(a.id));
      }
      if (rows.length === 0) return { error: "no matching assets" };
      const snapshots = [];
      for (const asset of rows) {
        snapshots.push(await snapshotForAsset(asset));
      }
      return { snapshots };
    },
  },
  {
    name: "get_ohlcv_summary",
    description:
      "Price-action summary for one asset over a lookback window: open/close/high/low, % change, annualized realized volatility, and the last 10 candles. Optionally computes indicator snapshots (sma/ema/rsi/macd/bbands/atr/roc — latest value plus the 2 prior bars) over the same window; defaults: sma/ema/bbands period 20, rsi/atr 14, roc 10, macd 12/26/9, stdDev 2. Ensure lookbackBars comfortably exceeds the longest period. Use for grounding any price discussion. Never returns full raw series.",
    schema: z.object({
      assetId: z.number().int(),
      interval: z.enum(["15m", "1h", "4h", "1d"]),
      lookbackBars: z.number().int().min(30).max(500).default(180),
      indicators: z
        .array(
          z.object({
            type: z.enum(INDICATOR_TYPES),
            period: z.number().int().min(2).max(200).optional(),
            fast: z.number().int().min(2).max(100).optional(),
            slow: z.number().int().min(3).max(200).optional(),
            signal: z.number().int().min(2).max(100).optional(),
            stdDev: z.number().min(0.1).max(10).optional(),
          }),
        )
        .max(6)
        .optional(),
    }),
    run: async (
      _ctx,
      input: {
        assetId: number;
        interval: Interval;
        lookbackBars: number;
        indicators?: IndicatorRequest[];
      },
    ) => {
      const asset = await assetById(input.assetId);
      if (!asset) return { error: "asset not found" };
      const ms = INTERVAL_MS[input.interval];
      const now = Date.now();
      const { candles } = await getCandles(
        db,
        asset,
        input.interval,
        now - input.lookbackBars * ms,
        now,
      );
      if (candles.length === 0) return { error: "no candle data for this range" };
      return {
        symbol: asset.symbol,
        interval: input.interval,
        ...candleStats(candles, input.interval),
        ...(input.indicators?.length
          ? { indicatorSnapshots: computeIndicatorSnapshots(candles, input.indicators) }
          : {}),
      };
    },
  },
  {
    name: "list_strategies",
    description:
      "List the user's saved strategies with a one-line rules summary. Use before referencing or backtesting a strategy.",
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    run: async ({ userId }, input: { limit: number }) => {
      const rows = await db
        .select()
        .from(strategies)
        .where(eq(strategies.userId, userId))
        .orderBy(desc(strategies.createdAt))
        .limit(input.limit);
      return {
        strategies: rows.map((s) => {
          const dsl = s.dsl as StrategyDSL;
          return {
            id: s.id,
            name: s.name,
            interval: dsl.interval,
            source: s.source,
            createdAt: s.createdAt.toISOString(),
            entry: renderCondition(dsl.entry),
            exit: renderCondition(dsl.exit),
          };
        }),
      };
    },
  },
  {
    name: "get_strategy",
    description:
      "Full detail of one saved strategy: the DSL, human-readable rules, risk settings, and how many backtests exist for it.",
    schema: z.object({ strategyId: z.number().int() }),
    run: async ({ userId }, input: { strategyId: number }) => {
      const [row] = await db
        .select()
        .from(strategies)
        .where(and(eq(strategies.id, input.strategyId), eq(strategies.userId, userId)));
      if (!row) return { error: "strategy not found" };
      const dsl = row.dsl as StrategyDSL;
      const runs = await db
        .select({ id: backtestRuns.id })
        .from(backtestRuns)
        .where(and(eq(backtestRuns.strategyId, row.id), eq(backtestRuns.userId, userId)));
      return {
        id: row.id,
        name: row.name,
        source: row.source,
        interval: dsl.interval,
        description: dsl.description,
        indicators: renderIndicators(dsl),
        entry: renderCondition(dsl.entry),
        exit: renderCondition(dsl.exit),
        risk: renderRisk(dsl),
        dsl,
        backtestCount: runs.length,
      };
    },
  },
  {
    name: "list_backtests",
    description:
      "List the user's backtest runs (optionally filtered by strategy or asset) with headline metrics.",
    schema: z.object({
      strategyId: z.number().int().optional(),
      assetId: z.number().int().optional(),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    run: async (
      { userId },
      input: { strategyId?: number; assetId?: number; limit: number },
    ) => {
      const conds = [eq(backtestRuns.userId, userId)];
      if (input.strategyId) conds.push(eq(backtestRuns.strategyId, input.strategyId));
      if (input.assetId) conds.push(eq(backtestRuns.assetId, input.assetId));
      const rows = await db
        .select({
          run: backtestRuns,
          strategyName: strategies.name,
          assetSymbol: assets.symbol,
        })
        .from(backtestRuns)
        .innerJoin(strategies, eq(backtestRuns.strategyId, strategies.id))
        .innerJoin(assets, eq(backtestRuns.assetId, assets.id))
        .where(and(...conds))
        .orderBy(desc(backtestRuns.createdAt))
        .limit(input.limit);
      return {
        backtests: rows.map(({ run, strategyName, assetSymbol }) => ({
          runId: run.id,
          strategy: strategyName,
          strategyId: run.strategyId,
          asset: assetSymbol,
          interval: run.interval,
          from: new Date(run.fromT).toISOString().slice(0, 10),
          to: new Date(run.toT).toISOString().slice(0, 10),
          status: run.status,
          metrics: headlineMetrics(run.metrics as Metrics | null),
        })),
      };
    },
  },
  {
    name: "get_backtest",
    description:
      "Full result of one backtest run: parameters, all metrics vs buy-and-hold, and the first/last five trades. Cite runId when discussing results.",
    schema: z.object({ runId: z.number().int() }),
    run: async ({ userId }, input: { runId: number }) => {
      const [row] = await db
        .select({
          run: backtestRuns,
          strategyName: strategies.name,
          assetSymbol: assets.symbol,
        })
        .from(backtestRuns)
        .innerJoin(strategies, eq(backtestRuns.strategyId, strategies.id))
        .innerJoin(assets, eq(backtestRuns.assetId, assets.id))
        .where(and(eq(backtestRuns.id, input.runId), eq(backtestRuns.userId, userId)));
      if (!row) return { error: "backtest run not found" };
      const { run, strategyName, assetSymbol } = row;
      const trades = (run.trades as unknown[] | null) ?? [];
      return {
        runId: run.id,
        strategy: strategyName,
        asset: assetSymbol,
        interval: run.interval,
        from: new Date(run.fromT).toISOString(),
        to: new Date(run.toT).toISOString(),
        status: run.status,
        params: run.params,
        metrics: run.metrics,
        tradeCount: trades.length,
        firstTrades: trades.slice(0, 5),
        lastTrades: trades.slice(-5),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Phase B read tools: portfolio, news, chat-history memory.
// ---------------------------------------------------------------------------

import { latestSnapshots } from "@/server/portfolio/service";
import { getNews } from "@/server/news/newsCache";
import { newsConfigured } from "@/server/news/cryptopanic";
import { getChatThreadTranscript, searchChatHistory } from "@/server/chat/history-service";
import { getMacroSeries } from "@/server/macro/macroCache";
import { MACRO_SLUGS } from "@/server/macro/registry";
import { computeMacroDeltas } from "@/server/macro/snapshot";
import { listSavedCharts } from "@/server/charts/savedCharts";

READ_TOOLS.push(
  {
    name: "get_portfolio",
    description:
      "The user's wallet holdings from the LATEST persisted snapshot per registered wallet (token, chain, balance, USD value, total). Data is as of each wallet's lastSyncedAt — flag staleness and suggest a sync from the Wallets page when it matters. Returns empty when no wallet is registered.",
    schema: z.object({}),
    run: async ({ userId }) => {
      const snapshots = await latestSnapshots(userId);
      if (snapshots.length === 0) {
        return { wallets: [], note: "No wallets registered — connect one on the Wallets page." };
      }
      return {
        wallets: snapshots.map((s) => ({
          address: s.address,
          lastSyncedAt: s.lastSyncedAt,
          totalUsd: Number(s.totalUsd.toFixed(2)),
          positions: s.positions.slice(0, 25).map((p) => ({
            symbol: p.symbol,
            chainId: p.chainId,
            balance: p.balance,
            valueUsd: p.valueUsd !== null ? Number(p.valueUsd.toFixed(2)) : null,
          })),
        })),
      };
    },
  },
  {
    name: "get_market_news",
    description:
      "Recent crypto market news headlines (CryptoPanic aggregator, served from a 10-minute cache). Optionally filter by uppercase currency codes like [\"ETH\"]. Cite the source domain and published time when quoting.",
    schema: z.object({
      currencies: z.array(z.string().min(2).max(10)).max(5).optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    run: async (_ctx, input: { currencies?: string[]; limit: number }) => {
      if (!newsConfigured()) {
        return { error: "news is not configured (CRYPTOPANIC_API_KEY missing)" };
      }
      const { items, stale } = await getNews(db, {
        currencies: input.currencies,
        limit: input.limit,
      });
      return {
        stale,
        items: items.map((n) => ({
          title: n.title,
          source: n.sourceDomain,
          url: n.url,
          currencies: n.currencies,
          publishedAt: n.publishedAt.toISOString(),
        })),
      };
    },
  },
  {
    name: "get_macro_series",
    description:
      "US macro-economic series (FRED/DBnomics, 6h cache): cpi-yoy, core-cpi-yoy, fed-funds, treasury-10y, fed-balance-sheet, m2, unemployment, dxy. Returns the last ~120 observations plus the latest value. Use when the user asks about inflation, rates, QE, liquidity, or the macro backdrop.",
    schema: z.object({
      slug: z.enum(MACRO_SLUGS as [string, ...string[]]),
    }),
    run: async (_ctx, input: { slug: string }) => {
      const result = await getMacroSeries(db, input.slug);
      if (!result) return { error: "unknown macro series" };
      if (result.observations.length === 0) {
        return {
          error:
            "no data available for this series (upstream unreachable or FRED_API_KEY missing for a FRED-only series)",
        };
      }
      const observations = result.observations.slice(-120);
      const latest = observations[observations.length - 1];
      return {
        series: result.def.name,
        unit: result.def.unit,
        source: result.source,
        stale: result.stale,
        latest,
        observations,
      };
    },
  },
  {
    name: "list_saved_charts",
    description:
      "List the user's saved chart layouts from the Analyse Assets page: name, asset symbol, interval, indicators shown (MA/EMA/BOLL/VOL/RSI/MACD), drawing count, last updated. Use when the user refers to 'my chart' or their setup, or to see what they've been watching. Follow up with get_ohlcv_summary on the same asset (chart-only intervals like 1w aren't available there).",
    schema: z.object({}),
    run: async ({ userId }) => {
      const charts = await listSavedCharts(db, userId);
      return {
        charts: charts.map((c) => ({
          id: c.id,
          name: c.name,
          symbol: c.symbol,
          assetId: c.assetId,
          interval: c.interval,
          indicators: c.indicatorNames,
          drawingCount: c.drawingCount,
          updatedAt: c.updatedAt.toISOString(),
        })),
      };
    },
  },
  {
    name: "get_macro_snapshot",
    description:
      "Compact macro dashboard: latest value plus ~3-month and ~12-month change (in the series' own unit) for all 8 US macro series at once (cpi-yoy, core-cpi-yoy, fed-funds, treasury-10y, fed-balance-sheet, m2, unemployment, dxy). Use for the macro backdrop of a trade thesis; use get_macro_series when you need a full history. First call after a cache expiry can be slow.",
    schema: z.object({}),
    run: async () => {
      const results = await Promise.all(
        MACRO_SLUGS.map(async (slug) => {
          const result = await getMacroSeries(db, slug);
          const deltas = result ? computeMacroDeltas(result.observations) : null;
          if (!result || !deltas) return { slug, error: "no data" };
          return {
            slug,
            name: result.def.name,
            unit: result.def.unit,
            latest: deltas.latest,
            delta3m: deltas.delta3m,
            delta12m: deltas.delta12m,
            stale: result.stale,
            source: result.source,
          };
        }),
      );
      return { series: results };
    },
  },
  {
    name: "search_chat_history",
    description:
      "Search the user's PREVIOUS conversations with you (titles, summaries, message text; the current thread is excluded). Use only when the user references an earlier conversation ('as we discussed', 'last time'). Follow up with get_chat_thread to read a transcript.",
    schema: z.object({ query: z.string().min(2).max(200) }),
    run: async ({ userId, currentThreadId }, input: { query: string }) => {
      const results = await searchChatHistory(userId, input.query, {
        excludeThreadId: currentThreadId,
      });
      return { results };
    },
  },
  {
    name: "get_chat_thread",
    description:
      "Read a past conversation's transcript (most recent 30 user/assistant messages, text only) by threadId from search_chat_history. Figures in past conversations may be stale — re-verify with live tools.",
    schema: z.object({ threadId: z.string().uuid() }),
    run: async ({ userId }, input: { threadId: string }) => {
      const transcript = await getChatThreadTranscript(userId, input.threadId);
      return transcript ?? { error: "thread not found" };
    },
  },
);
