import type { Candle } from "../market/types";
import type { BacktestParams, EquityPoint, Trade } from "./backtest";

export type Metrics = {
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  winRatePct: number;
  profitFactor: number;
  tradeCount: number;
  avgTradePnlUsd: number;
  timeInMarketPct: number;
  buyHoldReturnPct: number;
  /** Perp-mode modeling caveats, filled by the run service (never by the engine). */
  assumptions?: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeMetrics(
  equityCurve: EquityPoint[],
  trades: Trade[],
  candles: Candle[],
  params: BacktestParams,
): Metrics {
  const initial = params.initialEquity;
  const final = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initial;
  const totalReturnPct = (final / initial - 1) * 100;

  const spanMs =
    equityCurve.length > 1 ? equityCurve[equityCurve.length - 1].t - equityCurve[0].t : 0;
  const years = spanMs / (365 * DAY_MS);
  const cagrPct = years > 0 ? ((final / initial) ** (1 / years) - 1) * 100 : 0;

  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - p.equity) / peak) * 100);
  }

  // Sharpe on daily-resampled equity (last point per UTC day), rf = 0.
  const daily = new Map<number, number>();
  for (const p of equityCurve) daily.set(Math.floor(p.t / DAY_MS), p.equity);
  const dailyEquity = [...daily.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  const dailyReturns: number[] = [];
  for (let i = 1; i < dailyEquity.length; i++) {
    dailyReturns.push(dailyEquity[i] / dailyEquity[i - 1] - 1);
  }
  let sharpe = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
  }

  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0));

  let inMarketMs = 0;
  for (const t of trades) inMarketMs += t.exitT - t.entryT;

  const buyHoldReturnPct =
    candles.length > 1 ? (candles[candles.length - 1].c / candles[0].c - 1) * 100 : 0;

  return {
    totalReturnPct,
    cagrPct,
    maxDrawdownPct,
    sharpe,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    tradeCount: trades.length,
    avgTradePnlUsd: trades.length > 0 ? trades.reduce((a, t) => a + t.pnlUsd, 0) / trades.length : 0,
    timeInMarketPct: spanMs > 0 ? (inMarketMs / spanMs) * 100 : 0,
    buyHoldReturnPct,
  };
}
