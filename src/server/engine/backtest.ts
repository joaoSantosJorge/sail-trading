import type { Candle } from "../market/types";
import { computeSignals } from "./interpreter";
import { computeMetrics, type Metrics } from "./metrics";
import type { StrategyDSL } from "./types";

export type BacktestParams = {
  feeBps: number; // per side
  slippageBps: number; // per side, applied to fill price
  gasUsd: number; // flat per fill
  initialEquity: number;
};

export const DEFAULT_PARAMS: BacktestParams = {
  feeBps: 30,
  slippageBps: 10,
  gasUsd: 1,
  initialEquity: 10_000,
};

export type Trade = {
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: "signal" | "stop" | "take_profit" | "end_of_data";
};

export type EquityPoint = { t: number; equity: number };

export type BacktestResult = {
  trades: Trade[];
  equityCurve: EquityPoint[];
  metrics: Metrics;
};

/**
 * Deterministic long-only simulation. Signals are evaluated on closed bar i
 * and fill at open[i+1] — never on the signal bar itself (no lookahead).
 * Stops/take-profits are checked intrabar on the current bar's h/l.
 */
export function runBacktest(
  dsl: StrategyDSL,
  candles: Candle[],
  params: BacktestParams = DEFAULT_PARAMS,
): BacktestResult {
  const signals = computeSignals(dsl, candles);
  const { feeBps, slippageBps, gasUsd, initialEquity } = params;

  let cash = initialEquity;
  let qty = 0;
  let entryPrice = 0;
  let entryT = 0;
  let cooldownLeft = 0;
  let pendingEntry = false;
  let pendingExit: Trade["exitReason"] | null = null;

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const buy = (rawPrice: number, t: number) => {
    const price = rawPrice * (1 + slippageBps / 10_000);
    const equity = cash; // flat when buying
    const notional = (equity * dsl.risk.positionSizePct) / 100;
    const fee = notional * (feeBps / 10_000);
    const spend = Math.min(notional + fee + gasUsd, cash);
    const buyNotional = Math.max(spend - fee - gasUsd, 0);
    qty = buyNotional / price;
    cash -= spend;
    entryPrice = price;
    entryT = t;
  };

  const sell = (rawPrice: number, t: number, reason: Trade["exitReason"]) => {
    const price = rawPrice * (1 - slippageBps / 10_000);
    const notional = qty * price;
    const fee = notional * (feeBps / 10_000);
    cash += notional - fee - gasUsd;
    const cost = qty * entryPrice;
    const pnlUsd = notional - fee - gasUsd - cost;
    trades.push({
      entryT,
      entryPrice,
      exitT: t,
      exitPrice: price,
      qty,
      pnlUsd,
      pnlPct: (pnlUsd / cost) * 100,
      exitReason: reason,
    });
    qty = 0;
    cooldownLeft = dsl.risk.cooldownBars ?? 0;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // 1) Fills scheduled from the previous bar's signal execute at this open.
    if (pendingExit && qty > 0) {
      sell(bar.o, bar.t, pendingExit);
    }
    pendingExit = null;
    if (pendingEntry && qty === 0 && cooldownLeft === 0) {
      buy(bar.o, bar.t);
    }
    pendingEntry = false;

    // 2) Intrabar stop / take-profit on the current bar.
    if (qty > 0) {
      const stop = dsl.risk.stopLossPct !== undefined ? entryPrice * (1 - dsl.risk.stopLossPct / 100) : undefined;
      const take =
        dsl.risk.takeProfitPct !== undefined ? entryPrice * (1 + dsl.risk.takeProfitPct / 100) : undefined;
      // Conservative: a gap through the level fills at the open, otherwise at
      // the level itself. If both could hit in one bar, assume the stop hit.
      if (stop !== undefined && bar.l <= stop) {
        sell(Math.min(bar.o, stop), bar.t, "stop");
      } else if (take !== undefined && bar.h >= take) {
        sell(Math.max(bar.o, take), bar.t, "take_profit");
      }
    }

    // 3) Evaluate signals on this (closed) bar; fills happen next bar.
    if (qty > 0 && signals[i].exit) {
      pendingExit = "signal";
    } else if (qty === 0 && signals[i].entry && cooldownLeft === 0) {
      pendingEntry = true;
    }

    if (cooldownLeft > 0 && qty === 0) cooldownLeft -= 1;

    equityCurve.push({ t: bar.t, equity: cash + qty * bar.c });
  }

  // Mark-to-market close of any open position on the final bar.
  if (qty > 0) {
    const last = candles[candles.length - 1];
    sell(last.c, last.t, "end_of_data");
    equityCurve[equityCurve.length - 1] = { t: last.t, equity: cash };
  }

  return {
    trades,
    equityCurve,
    metrics: computeMetrics(equityCurve, trades, candles, params),
  };
}
