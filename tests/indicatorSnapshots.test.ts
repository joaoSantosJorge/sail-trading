import { describe, expect, it } from "vitest";
import {
  computeIndicatorSnapshots,
  type IndicatorRequest,
} from "@/lib/indicators/snapshots";
import type { Candle } from "@/server/market/types";

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    t: i * 60_000,
    o: c,
    h: c * 1.01,
    l: c * 0.99,
    c,
    v: 100,
  }));
}

describe("computeIndicatorSnapshots", () => {
  it("computes sma latest + 2 prior bars, oldest first", () => {
    const candles = candlesFromCloses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const [snap] = computeIndicatorSnapshots(candles, [{ type: "sma", period: 3 }]);
    expect(snap.error).toBeUndefined();
    expect(snap.params).toEqual({ period: 3 });
    expect(snap.latest).toBe(9); // (8+9+10)/3
    expect(snap.recent).toEqual([7, 8]); // (6+7+8)/3, (7+8+9)/3
  });

  it("applies defaults per indicator type", () => {
    const candles = candlesFromCloses(
      Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10),
    );
    const requests: IndicatorRequest[] = [
      { type: "sma" },
      { type: "ema" },
      { type: "rsi" },
      { type: "macd" },
      { type: "bbands" },
      { type: "atr" },
      { type: "roc" },
    ];
    const snaps = computeIndicatorSnapshots(candles, requests);
    expect(snaps.map((s) => s.params)).toEqual([
      { period: 20 },
      { period: 20 },
      { period: 14 },
      { fast: 12, slow: 26, signal: 9 },
      { period: 20, stdDev: 2 },
      { period: 14 },
      { period: 10 },
    ]);
    for (const s of snaps) {
      expect(s.error).toBeUndefined();
      expect(s.latest).toBeDefined();
    }
  });

  it("returns object values for macd and bbands", () => {
    const candles = candlesFromCloses(
      Array.from({ length: 80 }, (_, i) => 100 + i * 0.5),
    );
    const [m, b] = computeIndicatorSnapshots(candles, [
      { type: "macd" },
      { type: "bbands" },
    ]);
    expect(Object.keys(m.latest as object).sort()).toEqual(["hist", "macd", "signal"]);
    expect(Object.keys(b.latest as object).sort()).toEqual(["lower", "mid", "upper"]);
    const bb = b.latest as Record<string, number>;
    expect(bb.upper).toBeGreaterThan(bb.mid);
    expect(bb.mid).toBeGreaterThan(bb.lower);
  });

  it("reports a per-indicator warm-up error instead of NaN", () => {
    const candles = candlesFromCloses([1, 2, 3, 4, 5]);
    const [ok, tooLong] = computeIndicatorSnapshots(candles, [
      { type: "sma", period: 3 },
      { type: "sma", period: 10 },
    ]);
    expect(ok.latest).toBe(4);
    expect(tooLong.latest).toBeUndefined();
    expect(tooLong.error).toContain("needs at least 10 bars of the 5 requested");
  });

  it("macd warm-up covers the signal line, not just the macd line", () => {
    // 30 bars: macd line valid (slow=26) but signal (9 more bars) is not.
    const candles = candlesFromCloses(
      Array.from({ length: 30 }, (_, i) => 100 + i),
    );
    const [snap] = computeIndicatorSnapshots(candles, [{ type: "macd" }]);
    expect(snap.error).toContain("needs at least 34 bars");
  });

  it("rounds to 6 significant digits (sub-cent prices keep precision)", () => {
    const candles = candlesFromCloses([
      0.00012345678, 0.00012355678, 0.00012365678, 0.00012375678,
    ]);
    const [snap] = computeIndicatorSnapshots(candles, [{ type: "sma", period: 3 }]);
    expect(snap.latest).toBe(0.000123657);
  });
});
