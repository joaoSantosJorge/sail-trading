import { describe, expect, it } from "vitest";
import { runBacktest, type BacktestParams } from "@/server/engine/backtest";
import type { StrategyDSL } from "@/server/engine/types";
import type { Candle } from "@/server/market/types";

const DAY = 24 * 60 * 60 * 1000;

const NO_COSTS: BacktestParams = { feeBps: 0, slippageBps: 0, gasUsd: 0, initialEquity: 10_000 };

/** Deterministic synthetic series: trend + oscillation, no randomness. */
function syntheticCandles(n: number): Candle[] {
  const out: Candle[] = [];
  let prevClose = 100;
  for (let i = 0; i < n; i++) {
    const c = 100 + 10 * Math.sin(i / 5) + i * 0.05;
    const o = prevClose;
    out.push({ t: i * DAY, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 1000 });
    prevClose = c;
  }
  return out;
}

const thresholdDsl: StrategyDSL = {
  version: 1,
  name: "threshold",
  description: "",
  interval: "1d",
  indicators: [],
  entry: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  exit: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  risk: { positionSizePct: 100 },
};

const crossoverDsl: StrategyDSL = {
  version: 1,
  name: "sma crossover",
  description: "",
  interval: "1d",
  indicators: [
    { id: "fast", type: "sma", params: { period: 3 } },
    { id: "slow", type: "sma", params: { period: 8 } },
  ],
  entry: { op: "crosses_above", left: { kind: "indicator", id: "fast" }, right: { kind: "indicator", id: "slow" } },
  exit: { op: "crosses_below", left: { kind: "indicator", id: "fast" }, right: { kind: "indicator", id: "slow" } },
  risk: { positionSizePct: 100 },
};

describe("backtest engine", () => {
  it("fills at the NEXT bar's open after a signal, with exact accounting at zero cost", () => {
    // closes: 90, 105, 110, 95, 90 — entry signal on bar1, exit signal on bar3.
    const closes = [90, 105, 110, 95, 90];
    const candles: Candle[] = closes.map((c, i) => ({
      t: i * DAY,
      o: c - 1, // distinct open so fills are attributable
      h: c + 2,
      l: c - 3,
      c,
      v: 0,
    }));
    const result = runBacktest(thresholdDsl, candles, NO_COSTS);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryT).toBe(2 * DAY); // signal bar1 → fill bar2 open
    expect(trade.entryPrice).toBe(candles[2].o);
    expect(trade.exitT).toBe(4 * DAY); // signal bar3 → fill bar4 open
    expect(trade.exitPrice).toBe(candles[4].o);
    expect(trade.exitReason).toBe("signal");

    const qty = 10_000 / candles[2].o;
    expect(trade.qty).toBeCloseTo(qty, 10);
    expect(trade.pnlUsd).toBeCloseTo(qty * (candles[4].o - candles[2].o), 8);
    // Final equity = initial + pnl
    const final = result.equityCurve[result.equityCurve.length - 1].equity;
    expect(final).toBeCloseTo(10_000 + trade.pnlUsd, 8);
  });

  it("applies slippage, fees, and gas on both sides", () => {
    const closes = [90, 105, 110, 95, 90];
    const candles: Candle[] = closes.map((c, i) => ({
      t: i * DAY, o: c, h: c + 2, l: c - 3, c, v: 0,
    }));
    const params: BacktestParams = { feeBps: 30, slippageBps: 10, gasUsd: 1, initialEquity: 10_000 };
    const [trade] = runBacktest(thresholdDsl, candles, params).trades;

    expect(trade.entryPrice).toBeCloseTo(candles[2].o * 1.001, 10); // buy pays slippage
    expect(trade.exitPrice).toBeCloseTo(candles[4].o * 0.999, 10); // sell receives less
    // Round trip must cost more than the frictionless version.
    const frictionless = runBacktest(thresholdDsl, candles, NO_COSTS).trades[0];
    expect(trade.pnlUsd).toBeLessThan(frictionless.pnlUsd);
  });

  it("triggers an intrabar stop loss at the stop price", () => {
    const dsl: StrategyDSL = {
      ...thresholdDsl,
      risk: { positionSizePct: 100, stopLossPct: 5 },
      exit: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: -999 } },
    };
    // Enter at bar2 open (100); bar3 low dips to 94 → stop at 95 hit intrabar.
    const candles: Candle[] = [
      { t: 0, o: 90, h: 92, l: 88, c: 101, v: 0 }, // entry signal (close > 100)
      { t: DAY, o: 101, h: 102, l: 99, c: 101, v: 0 }, // wait: signal on bar0 fills at bar1 open
      { t: 2 * DAY, o: 100, h: 101, l: 94, c: 96, v: 0 },
    ];
    const result = runBacktest(dsl, candles, NO_COSTS);
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryT).toBe(DAY);
    expect(trade.entryPrice).toBe(101);
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBeCloseTo(101 * 0.95, 10);
  });

  it("is deterministic: identical inputs produce identical results", () => {
    const candles = syntheticCandles(400);
    const a = runBacktest(crossoverDsl, candles);
    const b = runBacktest(crossoverDsl, candles);
    expect(a).toEqual(b);
    expect(a.trades.length).toBeGreaterThan(2); // the strategy actually trades
  });

  it("has no lookahead: truncating future candles never changes past results", () => {
    const full = syntheticCandles(400);
    const fullResult = runBacktest(crossoverDsl, full);

    for (const cut of [100, 250, 399]) {
      const truncated = runBacktest(crossoverDsl, full.slice(0, cut));
      // Equity curve is identical except the final bar (forced end-of-data close).
      for (let i = 0; i < cut - 1; i++) {
        expect(truncated.equityCurve[i]).toEqual(fullResult.equityCurve[i]);
      }
      // Every completed (non-forced) trade matches the full run's prefix.
      const completed = truncated.trades.filter((t) => t.exitReason !== "end_of_data");
      completed.forEach((t, idx) => expect(t).toEqual(fullResult.trades[idx]));
    }
  });
});
