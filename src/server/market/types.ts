// t = candle open time, ms since epoch, UTC. A candle with open time t covers
// [t, t + INTERVAL_MS). Only closed candles are ever persisted.
export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export const INTERVALS = ["15m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value);
}

// Chart-only intervals: a superset of the strategy DSL's INTERVALS. The DSL
// (engine/types.ts) stays locked to INTERVALS; only charting uses the rest.
export const CHART_INTERVALS = ["5m", "15m", "1h", "4h", "1d", "1w", "1M"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

// Nominal durations. 1w is exact; 1M is a 30-day approximation good only for
// lookback sizing — period boundaries must go through alignOpen/prev/nextOpen.
export const CHART_INTERVAL_MS: Record<ChartInterval, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

export function isChartInterval(value: string): value is ChartInterval {
  return (CHART_INTERVALS as readonly string[]).includes(value);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 1970-01-01 was a Thursday; Binance weekly candles open Monday 00:00 UTC,
// and 1970-01-05 was the first Monday after the epoch.
const MONDAY_EPOCH_OFFSET = 4 * 24 * 60 * 60 * 1000;

/**
 * Open time of the period containing t, matching Binance's boundaries:
 * fixed-size intervals floor to a multiple of their duration, weeks open
 * Monday 00:00 UTC, months on the 1st 00:00 UTC.
 */
export function alignOpen(t: number, interval: ChartInterval): number {
  if (interval === "1w") {
    return Math.floor((t - MONDAY_EPOCH_OFFSET) / WEEK_MS) * WEEK_MS + MONDAY_EPOCH_OFFSET;
  }
  if (interval === "1M") {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const ms = CHART_INTERVAL_MS[interval];
  return Math.floor(t / ms) * ms;
}

/** Open time of the period before the one containing t. */
export function prevOpen(t: number, interval: ChartInterval): number {
  if (interval === "1M") {
    const d = new Date(alignOpen(t, interval));
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  }
  return alignOpen(t, interval) - CHART_INTERVAL_MS[interval];
}

/** Open time of the period after the one containing t. */
export function nextOpen(t: number, interval: ChartInterval): number {
  if (interval === "1M") {
    const d = new Date(alignOpen(t, interval));
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return alignOpen(t, interval) + CHART_INTERVAL_MS[interval];
}
