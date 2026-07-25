import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { assets, backtestRuns, strategies } from "@/server/db/schema";
import { DEFAULT_PARAMS, runBacktest, type BacktestParams } from "@/server/engine/backtest";
import { StrategyDSLSchema, warmupBars, type StrategyDSL } from "@/server/engine/types";
import { getCandles } from "@/server/market/candleCache";
import { alignFundingToBars, getFundingRates } from "@/server/market/fundingCache";
import { INTERVAL_MS } from "@/server/market/types";
import type { Metrics } from "@/server/engine/metrics";

/** User-facing perp options; expanded into engine PerpParams by the service. */
export type PerpRunOptions = {
  leverage: number;
  maintenanceMarginFraction: number;
  /** Fetch real Hyperliquid funding history when the asset trades there. */
  includeFunding: boolean;
};

export type RunBacktestInput = {
  strategyId: number;
  assetId: number;
  fromMs?: number;
  toMs?: number;
  params?: Partial<typeof DEFAULT_PARAMS>;
  perp?: PerpRunOptions;
};

export class BacktestError extends Error {}

/** Keep stored equity curves small; the engine can always recompute exactly. */
function downsample<T>(points: T[], max = 2000): T[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

/**
 * Ownership-checked backtest execution: loads the user's strategy, fetches
 * candles through the cache, runs the deterministic engine, persists the run.
 */
export async function executeBacktestRun(
  userId: string,
  input: RunBacktestInput,
): Promise<{ id: number; metrics: Metrics; interval: string; assetSymbol: string }> {
  const [strategy] = await db
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, input.strategyId), eq(strategies.userId, userId)));
  const [asset] = await db.select().from(assets).where(eq(assets.id, input.assetId));
  if (!strategy) throw new BacktestError("strategy not found");
  if (!asset) throw new BacktestError("asset not found");
  const dsl = StrategyDSLSchema.parse(strategy.dsl) as StrategyDSL;
  if (dsl.direction === "short" && !input.perp) {
    throw new BacktestError(
      'this strategy is direction "short" — run it as a perps backtest (pass perp: {leverage, ...})',
    );
  }

  const params: BacktestParams = { ...DEFAULT_PARAMS, ...input.params };
  const ms = INTERVAL_MS[dsl.interval];
  const now = Date.now();
  const to = input.toMs ?? now;
  // Default range: ~2000 bars plus indicator warm-up.
  const from = input.fromMs ?? to - (2000 + warmupBars(dsl)) * ms;

  const [run] = await db
    .insert(backtestRuns)
    .values({
      userId,
      strategyId: strategy.id,
      assetId: asset.id,
      interval: dsl.interval,
      fromT: from,
      toT: to,
      // Store the user-facing options, never the expanded fundingPerBar array.
      params: input.perp ? { ...params, perp: input.perp } : params,
      status: "running",
    })
    .returning({ id: backtestRuns.id });

  try {
    const { candles } = await getCandles(db, asset, dsl.interval, from, to);
    if (candles.length < warmupBars(dsl) + 10) {
      throw new BacktestError(
        `not enough history: ${candles.length} candles for a warm-up of ${warmupBars(dsl)} bars`,
      );
    }

    // Perps mode: expand user options into engine params + real funding data.
    const assumptions: string[] = [];
    if (input.perp) {
      let fundingPerBar: number[] | undefined;
      if (input.perp.includeFunding) {
        if (asset.hyperliquidSymbol !== null && candles.length > 0) {
          const rates = await getFundingRates(
            db,
            asset.hyperliquidSymbol,
            candles[0].t,
            candles[candles.length - 1].t + ms,
          );
          fundingPerBar = alignFundingToBars(rates, candles, ms);
          const covered = rates.length > 0 ? `${rates.length} hourly rates from Hyperliquid` : "none available";
          assumptions.push(
            `funding: ${covered}; bars outside the venue's funding history accrue 0`,
          );
        } else {
          assumptions.push("funding: asset has no Hyperliquid market — modeled as 0");
        }
      } else {
        assumptions.push("funding: excluded by request");
      }
      params.perp = {
        leverage: input.perp.leverage,
        maintenanceMarginFraction: input.perp.maintenanceMarginFraction,
        fundingPerBar,
      };
      assumptions.push(
        `perp model: ${input.perp.leverage}x, cross-margin, liquidation at ${(input.perp.maintenanceMarginFraction * 100).toFixed(2)}% maintenance margin — an approximation of venue mechanics (no tiered margin, no liquidator fee)`,
      );
    }

    const result = runBacktest(dsl, candles, params);
    const metrics: Metrics =
      assumptions.length > 0 ? { ...result.metrics, assumptions } : result.metrics;
    await db
      .update(backtestRuns)
      .set({
        status: "done",
        metrics,
        trades: result.trades,
        equityCurve: downsample(result.equityCurve),
      })
      .where(eq(backtestRuns.id, run.id));
    return { id: run.id, metrics, interval: dsl.interval, assetSymbol: asset.symbol };
  } catch (err) {
    await db
      .update(backtestRuns)
      .set({ status: "failed", metrics: { error: (err as Error).message } })
      .where(eq(backtestRuns.id, run.id));
    throw err instanceof BacktestError ? err : new BacktestError((err as Error).message);
  }
}
