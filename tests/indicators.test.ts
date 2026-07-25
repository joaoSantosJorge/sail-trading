import { describe, expect, it } from "vitest";
import {
  atr,
  bbands,
  ema,
  highest,
  lowest,
  macd,
  roc,
  rsi,
  sma,
} from "@/server/engine/indicators";
import type { Candle } from "@/server/market/types";

const closeTo = (actual: number[], expected: number[]) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => {
    if (Number.isNaN(expected[i])) expect(v).toBeNaN();
    else expect(v).toBeCloseTo(expected[i], 8);
  });
};

describe("indicators (hand-verified golden values)", () => {
  it("sma", () => {
    closeTo(sma([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  });

  it("ema seeds with SMA then smooths", () => {
    // period 3 → k = 0.5; seed at i=2 is SMA=2; then 4*.5+2*.5=3; 5*.5+3*.5=4
    closeTo(ema([1, 2, 3, 4, 5], 3), [NaN, NaN, 2, 3, 4]);
  });

  it("rsi (Wilder)", () => {
    // changes: +1, +1, -1. After 2 gains RSI=100; then avgGain=0.5, avgLoss=0.5 → 50.
    closeTo(rsi([1, 2, 3, 2], 2), [NaN, NaN, 100, 50]);
  });

  it("roc", () => {
    closeTo(roc([100, 110, 121], 1), [NaN, 10, 10]);
  });

  it("highest / lowest include the current bar", () => {
    closeTo(highest([1, 3, 2, 5, 4], 2), [NaN, 3, 3, 5, 5]);
    closeTo(lowest([1, 3, 2, 5, 4], 2), [NaN, 1, 2, 2, 4]);
  });

  it("bbands", () => {
    // period 2, k=2 on [1,3]: mid 2, population sd 1 → upper 4, lower 0
    const { upper, mid, lower } = bbands([1, 3], 2, 2);
    closeTo(mid, [NaN, 2]);
    closeTo(upper, [NaN, 4]);
    closeTo(lower, [NaN, 0]);
  });

  it("atr (Wilder)", () => {
    const candles: Candle[] = [
      { t: 0, o: 1.5, h: 2, l: 1, c: 1.5, v: 0 },
      { t: 1, o: 2.5, h: 3, l: 2, c: 2.5, v: 0 },
      { t: 2, o: 3.5, h: 4, l: 3, c: 3.5, v: 0 },
    ];
    // TR1 = max(1, |3-1.5|, |2-1.5|) = 1.5 ; TR2 = max(1, |4-2.5|, |3-2.5|) = 1.5
    closeTo(atr(candles, 2), [NaN, NaN, 1.5]);
  });

  it("macd = emaFast - emaSlow, hist = macd - signal", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const { macd: line, signal, hist } = macd(values, 2, 3, 2);
    const f = ema(values, 2);
    const s = ema(values, 3);
    for (let i = 0; i < values.length; i++) {
      if (i < 2) {
        expect(line[i]).toBeNaN();
      } else {
        expect(line[i]).toBeCloseTo(f[i] - s[i], 8);
      }
      if (!Number.isNaN(signal[i])) {
        expect(hist[i]).toBeCloseTo(line[i] - signal[i], 8);
      }
    }
    // Signal needs `signalPeriod` valid MACD values before it exists.
    expect(signal[2]).toBeNaN();
    expect(signal[3]).not.toBeNaN();
  });
});
