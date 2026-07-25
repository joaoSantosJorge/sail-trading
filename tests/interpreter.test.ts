import { describe, expect, it } from "vitest";
import { computeSignals } from "@/server/engine/interpreter";
import type { StrategyDSL } from "@/server/engine/types";
import type { Candle } from "@/server/market/types";

const mkCandles = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i * 1000, o: c, h: c + 1, l: c - 1, c, v: 100 }));

const baseDsl = (entry: StrategyDSL["entry"], exit: StrategyDSL["exit"]): StrategyDSL => ({
  version: 1,
  name: "t",
  description: "",
  interval: "1d",
  indicators: [{ id: "sma2", type: "sma", params: { period: 2 } }],
  entry,
  exit,
  risk: { positionSizePct: 100 },
});

describe("interpreter", () => {
  it("evaluates crosses_above only on the crossing bar", () => {
    // close: 1,1,3,4 vs sma2: NaN,1,2,3.5 → close>sma only from i=2; cross at i=2.
    const dsl = baseDsl(
      { op: "crosses_above", left: { kind: "price", field: "close" }, right: { kind: "indicator", id: "sma2" } },
      { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: -999 } },
    );
    const signals = computeSignals(dsl, mkCandles([1, 1, 3, 4]));
    expect(signals.map((s) => s.entry)).toEqual([false, false, true, false]);
  });

  it("warm-up NaN can never trigger a signal, even through not()", () => {
    const dsl = baseDsl(
      { op: "not", condition: { op: "gt", left: { kind: "indicator", id: "sma2" }, right: { kind: "const", value: 0 } } },
      { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: -999 } },
    );
    const signals = computeSignals(dsl, mkCandles([5, 5, 5]));
    expect(signals[0].entry).toBe(false); // sma NaN → unknown → no signal
    expect(signals[1].entry).toBe(false); // sma exists and > 0 → not() false
  });

  it("and/or combine correctly", () => {
    const gt = (value: number): StrategyDSL["entry"] => ({
      op: "gt",
      left: { kind: "price", field: "close" },
      right: { kind: "const", value },
    });
    const dsl = baseDsl(
      { op: "and", conditions: [gt(1), { op: "or", conditions: [gt(100), gt(2)] }] },
      gt(999),
    );
    const signals = computeSignals(dsl, mkCandles([3, 1.5]));
    expect(signals[0].entry).toBe(true); // 3>1 and (3>2)
    expect(signals[1].entry).toBe(false); // 1.5>1 but not >2/>100
  });
});
