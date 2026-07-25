// All indicators are pure functions over aligned arrays: output[i] corresponds
// to input[i], with NaN during the warm-up window. That single convention is
// why these are hand-rolled instead of pulled from a library.
import type { Candle } from "@/server/market/types";

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      seedSum += values[i];
    } else if (i === period - 1) {
      prev = (seedSum + values[i]) / period; // seed with SMA
      out[i] = prev;
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's RSI (smoothed averages). */
export function rsi(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

export function macd(
  values: number[],
  fast: number,
  slow: number,
  signalPeriod: number,
): { macd: number[]; signal: number[]; hist: number[] } {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => emaFast[i] - emaSlow[i]);

  // Signal = EMA of the MACD line, starting where the MACD line exists.
  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v));
  const signal = new Array<number>(values.length).fill(NaN);
  if (firstValid >= 0) {
    const seg = ema(macdLine.slice(firstValid), signalPeriod);
    for (let i = 0; i < seg.length; i++) signal[firstValid + i] = seg[i];
  }
  const hist = macdLine.map((v, i) => v - signal[i]);
  return { macd: macdLine, signal, hist };
}

export function bbands(
  values: number[],
  period: number,
  stdDev: number,
): { upper: number[]; mid: number[]; lower: number[] } {
  const mid = sma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (values[j] - mid[i]) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + stdDev * sd;
    lower[i] = mid[i] - stdDev * sd;
  }
  return { upper, mid, lower };
}

/** Wilder's ATR over true range. */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let prev = NaN;
  let seedSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
    if (i <= period) {
      seedSum += tr;
      if (i === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** Rate of change over `period` bars, in percent. */
export function roc(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    out[i] = (values[i] / values[i - period] - 1) * 100;
  }
  return out;
}

/** Rolling max over the trailing `period` bars, current bar included. */
export function highest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) max = Math.max(max, values[j]);
    out[i] = max;
  }
  return out;
}

/** Rolling min over the trailing `period` bars, current bar included. */
export function lowest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - period + 1; j <= i; j++) min = Math.min(min, values[j]);
    out[i] = min;
  }
  return out;
}
