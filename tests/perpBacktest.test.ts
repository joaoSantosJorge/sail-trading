import { describe, expect, it } from "vitest";
import { runBacktest, type BacktestParams } from "@/server/engine/backtest";
import type { StrategyDSL } from "@/server/engine/types";
import type { Candle } from "@/server/market/types";
import { alignFundingToBars } from "@/server/market/fundingCache";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const NO_COSTS: BacktestParams = { feeBps: 0, slippageBps: 0, gasUsd: 0, initialEquity: 10_000 };
const perp = (over: Partial<NonNullable<BacktestParams["perp"]>> = {}) => ({
  leverage: 1,
  maintenanceMarginFraction: 0.005,
  ...over,
});

/** closes drive the threshold signals; opens are distinct for attribution. */
function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i * DAY, o: c - 1, h: c + 2, l: c - 3, c, v: 0 }));
}

const shortDsl: StrategyDSL = {
  version: 1,
  name: "short threshold",
  description: "",
  interval: "1d",
  direction: "short",
  indicators: [],
  // Short when price is weak, cover when it recovers.
  entry: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  exit: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  risk: { positionSizePct: 100 },
};

const longDsl: StrategyDSL = {
  ...shortDsl,
  name: "long threshold",
  direction: "long",
  entry: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  exit: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
};

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

describe("perp backtest engine", () => {
  it("refuses short strategies on the spot engine", () => {
    expect(() => runBacktest(shortDsl, candlesFromCloses([110, 90, 95, 110, 115]), NO_COSTS)).toThrow(
      /shorts run only on the perps engine/,
    );
  });

  it("shorts with exact accounting: entry at next open, profit when price falls", () => {
    // closes: 110, 90 (entry signal), 85, 80, 110 (exit signal), 105
    const candles = candlesFromCloses([110, 90, 85, 80, 110, 105]);
    const result = runBacktest(shortDsl, candles, { ...NO_COSTS, perp: perp() });

    expect(result.trades).toHaveLength(1);
    const t = result.trades[0];
    expect(t.direction).toBe("short");
    expect(t.entryT).toBe(2 * DAY); // signal bar1 → fill bar2 open
    expect(t.entryPrice).toBe(candles[2].o); // 84
    expect(t.exitT).toBe(5 * DAY); // signal bar4 → fill bar5 open
    expect(t.exitPrice).toBe(candles[5].o); // 104
    const qty = 10_000 / candles[2].o;
    expect(t.qty).toBeCloseTo(qty, 10);
    // Short: pnl = qty × (entry − exit) — a LOSS here (covered higher).
    expect(t.pnlUsd).toBeCloseTo(qty * (candles[2].o - candles[5].o), 8);
    expect(t.pnlUsd).toBeLessThan(0);
    const final = result.equityCurve[result.equityCurve.length - 1].equity;
    expect(final).toBeCloseTo(10_000 + t.pnlUsd, 8);
  });

  it("leverage scales PnL linearly at zero cost", () => {
    const candles = candlesFromCloses([90, 105, 110, 95, 90]);
    const p1 = runBacktest(longDsl, candles, { ...NO_COSTS, perp: perp({ leverage: 1 }) }).trades[0];
    const p3 = runBacktest(longDsl, candles, { ...NO_COSTS, perp: perp({ leverage: 3 }) }).trades[0];
    expect(p3.pnlUsd).toBeCloseTo(3 * p1.pnlUsd, 8);
    expect(p3.qty).toBeCloseTo(3 * p1.qty, 10);
  });

  it("longs pay positive funding, shorts receive it", () => {
    const closes = [90, 105, 110, 110, 110, 90, 95];
    const candles = candlesFromCloses(closes);
    const rate = 0.0001;
    const funding = candles.map(() => rate);
    const noFunding = runBacktest(longDsl, candles, { ...NO_COSTS, perp: perp() });
    const withFunding = runBacktest(longDsl, candles, {
      ...NO_COSTS,
      perp: perp({ fundingPerBar: funding }),
    });
    // Entry signal bar1 → open at bar2's open; exit signal bar5 → close at
    // bar6's open. Funding accrues on every bar the position is open: 2,3,4,5.
    const expectedPaid =
      rate * (10_000 / candles[2].o) * (closes[2] + closes[3] + closes[4] + closes[5]);
    const diff =
      noFunding.equityCurve.at(-1)!.equity - withFunding.equityCurve.at(-1)!.equity;
    expect(diff).toBeCloseTo(expectedPaid, 8);

    // The mirrored short RECEIVES the same funding while open.
    const shortCloses = [110, 90, 85, 85, 85, 110, 105];
    const shortCandles = candlesFromCloses(shortCloses);
    const sNo = runBacktest(shortDsl, shortCandles, { ...NO_COSTS, perp: perp() });
    const sWith = runBacktest(shortDsl, shortCandles, {
      ...NO_COSTS,
      perp: perp({ fundingPerBar: shortCandles.map(() => rate) }),
    });
    expect(sWith.equityCurve.at(-1)!.equity).toBeGreaterThan(sNo.equityCurve.at(-1)!.equity);
  });

  it("liquidates a leveraged long intrabar at the solved liquidation price", () => {
    // Enter 10x long at bar2 open (99). A ~10% drop wipes the margin.
    const candles: Candle[] = [
      { t: 0, o: 100, h: 103, l: 99, c: 101, v: 0 }, // entry signal
      { t: DAY, o: 101, h: 102, l: 100, c: 101, v: 0 }, // wait bar
      { t: 2 * DAY, o: 99, h: 100, l: 97, c: 98, v: 0 },
      { t: 3 * DAY, o: 98, h: 99, l: 85, c: 90, v: 0 }, // crash through liquidation
    ];
    const dsl: StrategyDSL = {
      ...longDsl,
      // Never exit on signal — only the liquidation can close it.
      exit: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: -1 } },
    };
    const mmf = 0.005;
    const result = runBacktest(dsl, candles, { ...NO_COSTS, perp: perp({ leverage: 10, maintenanceMarginFraction: mmf }) });
    // Wait bar fills at bar1? Signal on bar0 → fill at bar1 open (101).
    expect(result.trades).toHaveLength(1);
    const t = result.trades[0];
    expect(t.exitReason).toBe("liquidation");
    // Solved liq price: cash = 10000 (no costs), q = 100000/101×... entry at 101, notional 100k, q = 990.099
    const q = (10_000 * 10) / 101;
    const pLiq = (q * 101 - 10_000) / (q * (1 - mmf));
    expect(t.exitPrice).toBeCloseTo(pLiq, 8);
    // Account is floored at zero on liquidation — never negative equity.
    const final = result.equityCurve.at(-1)!.equity;
    expect(final).toBeGreaterThanOrEqual(0);
  });

  it("liquidates a short when price gaps up", () => {
    const candles: Candle[] = [
      { t: 0, o: 110, h: 111, l: 95, c: 96, v: 0 }, // short signal (close < 100)
      { t: DAY, o: 96, h: 97, l: 94, c: 95, v: 0 }, // fill at open 96
      { t: 2 * DAY, o: 100, h: 120, l: 99, c: 118, v: 0 }, // squeeze through liq
    ];
    const dsl: StrategyDSL = {
      ...shortDsl,
      exit: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 1e9 } },
    };
    const result = runBacktest(dsl, candles, {
      ...NO_COSTS,
      perp: perp({ leverage: 10, maintenanceMarginFraction: 0.005 }),
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("liquidation");
    expect(result.equityCurve.at(-1)!.equity).toBeGreaterThanOrEqual(0);
  });

  it("mirrors stop-loss and take-profit for shorts", () => {
    const dsl: StrategyDSL = {
      ...shortDsl,
      risk: { positionSizePct: 100, stopLossPct: 5, takeProfitPct: 10 },
      exit: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 1e9 } },
    };
    // Stop: short entry 100, bar rallies to 106 → stop at 105 hit.
    const stopCandles: Candle[] = [
      { t: 0, o: 101, h: 102, l: 94, c: 95, v: 0 },
      { t: DAY, o: 100, h: 101, l: 99, c: 99, v: 0 }, // fill at 100
      { t: 2 * DAY, o: 101, h: 106, l: 100, c: 104, v: 0 },
    ];
    const stopped = runBacktest(dsl, stopCandles, { ...NO_COSTS, perp: perp() }).trades[0];
    expect(stopped.exitReason).toBe("stop");
    expect(stopped.exitPrice).toBeCloseTo(105, 10);

    // Take-profit: short entry 100, bar dumps to 88 → take at 90 hit.
    const tpCandles: Candle[] = [
      { t: 0, o: 101, h: 102, l: 94, c: 95, v: 0 },
      { t: DAY, o: 100, h: 101, l: 99, c: 99, v: 0 },
      { t: 2 * DAY, o: 99, h: 100, l: 88, c: 89, v: 0 },
    ];
    const taken = runBacktest(dsl, tpCandles, { ...NO_COSTS, perp: perp() }).trades[0];
    expect(taken.exitReason).toBe("take_profit");
    expect(taken.exitPrice).toBeCloseTo(90, 10);
  });

  it("applies slippage in the correct direction for shorts", () => {
    const candles = candlesFromCloses([110, 90, 85, 80, 110, 105]);
    const costs: BacktestParams = {
      feeBps: 0,
      slippageBps: 10,
      gasUsd: 0,
      initialEquity: 10_000,
      perp: perp(),
    };
    const t = runBacktest(shortDsl, candles, costs).trades[0];
    // Short entry SELLS (receives less), exit BUYS back (pays more).
    expect(t.entryPrice).toBeCloseTo(candles[2].o * 0.999, 10);
    expect(t.exitPrice).toBeCloseTo(candles[5].o * 1.001, 10);
  });

  it("is deterministic and lookahead-free in perp mode", () => {
    const full = syntheticCandles(400);
    const params: BacktestParams = {
      ...NO_COSTS,
      feeBps: 10,
      perp: perp({ leverage: 2, fundingPerBar: full.map((_, i) => (i % 7 === 0 ? 0.0002 : 0.00005)) }),
    };
    const crossover: StrategyDSL = {
      ...longDsl,
      indicators: [
        { id: "fast", type: "sma", params: { period: 3 } },
        { id: "slow", type: "sma", params: { period: 8 } },
      ],
      entry: { op: "crosses_above", left: { kind: "indicator", id: "fast" }, right: { kind: "indicator", id: "slow" } },
      exit: { op: "crosses_below", left: { kind: "indicator", id: "fast" }, right: { kind: "indicator", id: "slow" } },
    };

    const a = runBacktest(crossover, full, params);
    const b = runBacktest(crossover, full, params);
    expect(a).toEqual(b);
    expect(a.trades.length).toBeGreaterThan(2);

    for (const cut of [100, 250, 399]) {
      const truncated = runBacktest(crossover, full.slice(0, cut), {
        ...params,
        perp: { ...params.perp!, fundingPerBar: params.perp!.fundingPerBar!.slice(0, cut) },
      });
      for (let i = 0; i < cut - 1; i++) {
        expect(truncated.equityCurve[i]).toEqual(a.equityCurve[i]);
      }
      const completed = truncated.trades.filter((t) => t.exitReason !== "end_of_data");
      completed.forEach((t, idx) => expect(t).toEqual(a.trades[idx]));
    }
  });

  it("rejects fundingPerBar that is misaligned with the candles", () => {
    const candles = candlesFromCloses([90, 105, 110]);
    expect(() =>
      runBacktest(longDsl, candles, { ...NO_COSTS, perp: perp({ fundingPerBar: [0] }) }),
    ).toThrow(/must match candles length/);
  });
});

describe("alignFundingToBars", () => {
  it("sums hourly events into their containing bars and zero-fills gaps", () => {
    const candles: Candle[] = [0, 1, 2].map((i) => ({
      t: i * 4 * HOUR,
      o: 1, h: 1, l: 1, c: 1, v: 0,
    }));
    const rates = [
      { t: 0, rate: 0.001 },
      { t: HOUR, rate: 0.002 }, // same bar 0
      { t: 4 * HOUR, rate: 0.004 }, // bar 1
      { t: 13 * HOUR, rate: 0.008 }, // beyond bar 2's span (ends 12h) — dropped
    ];
    expect(alignFundingToBars(rates, candles, 4 * HOUR)).toEqual([0.003, 0.004, 0]);
  });

  it("ignores events before the first bar", () => {
    const candles: Candle[] = [{ t: 10 * HOUR, o: 1, h: 1, l: 1, c: 1, v: 0 }];
    expect(alignFundingToBars([{ t: 0, rate: 0.5 }], candles, HOUR)).toEqual([0]);
  });
});
