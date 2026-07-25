// Compact indicator snapshots for the AI chat: latest value plus a short tail,
// never full series. Pure — callers pass candles, we pass closes (or candles
// for ATR) to the aligned-array indicators in ./index.
import type { Candle } from "@/server/market/types";
import { atr, bbands, ema, macd, roc, rsi, sma } from "./index";

export const INDICATOR_TYPES = [
  "sma",
  "ema",
  "rsi",
  "macd",
  "bbands",
  "atr",
  "roc",
] as const;
export type IndicatorType = (typeof INDICATOR_TYPES)[number];

export type IndicatorRequest = {
  type: IndicatorType;
  /** sma/ema/bbands default 20, rsi/atr default 14, roc default 10. */
  period?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  stdDev?: number;
};

type SnapshotValue = number | Record<string, number>;

export type IndicatorSnapshot = {
  type: IndicatorType;
  params: Record<string, number>;
  /** Value at the most recent bar. */
  latest?: SnapshotValue;
  /** Values at the 2 bars before `latest`, oldest first. */
  recent?: SnapshotValue[];
  error?: string;
};

/** How many recent bars (before the latest) each snapshot carries. */
const TAIL = 2;

const round6 = (v: number) => Number(v.toPrecision(6));

function seriesSnapshot(
  outputs: Record<string, number[]>,
  bars: number,
  minBars: number,
): { latest: SnapshotValue; recent: SnapshotValue[] } | { error: string } {
  const keys = Object.keys(outputs);
  const at = (i: number): SnapshotValue => {
    if (keys.length === 1 && keys[0] === "value") return round6(outputs.value[i]);
    return Object.fromEntries(keys.map((k) => [k, round6(outputs[k][i])]));
  };
  const validAt = (i: number) => keys.every((k) => !Number.isNaN(outputs[k][i]));
  const last = bars - 1;
  if (last < 0 || !validAt(last)) {
    return {
      error: `needs at least ${minBars} bars of the ${bars} requested — increase lookbackBars`,
    };
  }
  const recent: SnapshotValue[] = [];
  for (let i = Math.max(0, last - TAIL); i < last; i++) {
    if (validAt(i)) recent.push(at(i));
  }
  return { latest: at(last), recent };
}

export function computeIndicatorSnapshots(
  candles: Candle[],
  requests: IndicatorRequest[],
): IndicatorSnapshot[] {
  const closes = candles.map((c) => c.c);
  const bars = candles.length;

  return requests.map((req) => {
    let params: Record<string, number>;
    let outputs: Record<string, number[]>;
    let minBars: number;

    switch (req.type) {
      case "sma": {
        const period = req.period ?? 20;
        params = { period };
        outputs = { value: sma(closes, period) };
        minBars = period;
        break;
      }
      case "ema": {
        const period = req.period ?? 20;
        params = { period };
        outputs = { value: ema(closes, period) };
        minBars = period;
        break;
      }
      case "rsi": {
        const period = req.period ?? 14;
        params = { period };
        outputs = { value: rsi(closes, period) };
        minBars = period + 1; // consumes one bar for the first diff
        break;
      }
      case "macd": {
        const fast = req.fast ?? 12;
        const slow = req.slow ?? 26;
        const signal = req.signal ?? 9;
        params = { fast, slow, signal };
        outputs = macd(closes, fast, slow, signal);
        minBars = slow + signal - 1;
        break;
      }
      case "bbands": {
        const period = req.period ?? 20;
        const stdDev = req.stdDev ?? 2;
        params = { period, stdDev };
        outputs = bbands(closes, period, stdDev);
        minBars = period;
        break;
      }
      case "atr": {
        const period = req.period ?? 14;
        params = { period };
        outputs = { value: atr(candles, period) };
        minBars = period + 1;
        break;
      }
      case "roc": {
        const period = req.period ?? 10;
        params = { period };
        outputs = { value: roc(closes, period) };
        minBars = period + 1;
        break;
      }
    }

    const snap = seriesSnapshot(outputs, bars, minBars);
    return { type: req.type, params, ...snap };
  });
}
