/**
 * Pure portfolio-valuation math: reconstruct past daily balances from the
 * transfer history and value them with daily closes. No DB, no clock — every
 * function is deterministic on its inputs (vitest target).
 *
 * Reconstruction runs BACKWARDS from the current balances, so the series is
 * anchored to today's true holdings and drift (gas spend missing from
 * transfers, uncovered internal txs) only accumulates going into the past.
 */

export const DAY_MS = 86_400_000;

/** `${chainId}:${lowercase token address | "native"}` */
export type AssetKey = string;

export type CurrentHolding = { key: AssetKey; balance: number };

/** Signed balance change at `ts`: +in / −out / 0 self. */
export type TransferDelta = { key: AssetKey; ts: number; delta: number };

export type DailyBalances = {
  /** UTC day-open ms, ascending. */
  days: number[];
  /** Per key, balance at the END of each day, aligned with `days`. */
  balances: Map<AssetKey, number[]>;
};

export const alignToDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * balance(key, day D) = max(0, current − Σ delta of transfers with ts after
 * the end of D) — one newest→oldest sweep. Clamping happens per recorded
 * value, not on the running total, so one missing inflow can't drag every
 * older day negative.
 */
export function reconstructDailyBalances(
  current: CurrentHolding[],
  transfers: TransferDelta[],
  fromDay: number,
  toDay: number,
): DailyBalances {
  const start = alignToDay(fromDay);
  const end = alignToDay(toDay);
  const days: number[] = [];
  for (let d = start; d <= end; d += DAY_MS) days.push(d);

  const running = new Map<AssetKey, number>();
  for (const h of current) running.set(h.key, (running.get(h.key) ?? 0) + h.balance);
  const keys = new Set<AssetKey>([...running.keys(), ...transfers.map((t) => t.key)]);

  const balances = new Map<AssetKey, number[]>();
  for (const key of keys) balances.set(key, new Array<number>(days.length).fill(0));

  const newestFirst = [...transfers].sort((a, b) => b.ts - a.ts);
  let ti = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const dayEnd = days[i] + DAY_MS;
    // Cross every transfer that happened after this day's end.
    while (ti < newestFirst.length && newestFirst[ti].ts >= dayEnd) {
      const t = newestFirst[ti];
      running.set(t.key, (running.get(t.key) ?? 0) - t.delta);
      ti++;
    }
    for (const key of keys) balances.get(key)![i] = Math.max(0, running.get(key) ?? 0);
  }
  return { days, balances };
}

export type SeriesPoint = { t: number; usd: number; btc: number | null };

export type ValuedSeries = {
  points: SeriesPoint[];
  /** Per display symbol (chains aggregated), USD value per day. */
  perAsset: Map<string, { t: number; usd: number }[]>;
};

/** Day-aligned closes with gaps carried forward; days before the first close map to undefined. */
function carriedCloses(days: number[], closes: Map<number, number>): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(days.length);
  let last: number | undefined;
  for (let i = 0; i < days.length; i++) {
    const c = closes.get(days[i]);
    if (c !== undefined) last = c;
    out[i] = last;
  }
  return out;
}

/**
 * Value the reconstructed balances. Keys absent from `closes` are skipped —
 * the caller decides what to report about them. A key's days before its first
 * known close are valued 0 (the token may predate price coverage).
 */
export function valuePortfolioSeries(
  days: number[],
  balances: Map<AssetKey, number[]>,
  symbols: Map<AssetKey, string>,
  closes: Map<AssetKey, Map<number, number>>,
  btcCloses: Map<number, number>,
): ValuedSeries {
  const usdTotals = new Array<number>(days.length).fill(0);
  const perAsset = new Map<string, { t: number; usd: number }[]>();

  for (const [key, dayBalances] of balances) {
    const keyCloses = closes.get(key);
    if (!keyCloses) continue;
    const prices = carriedCloses(days, keyCloses);
    const symbol = symbols.get(key) ?? key;
    let series = perAsset.get(symbol);
    if (!series) {
      series = days.map((t) => ({ t, usd: 0 }));
      perAsset.set(symbol, series);
    }
    for (let i = 0; i < days.length; i++) {
      const price = prices[i];
      if (price === undefined) continue;
      const usd = dayBalances[i] * price;
      usdTotals[i] += usd;
      series[i].usd += usd;
    }
  }

  const btc = carriedCloses(days, btcCloses);
  const points: SeriesPoint[] = days.map((t, i) => ({
    t,
    usd: usdTotals[i],
    btc: btc[i] !== undefined ? usdTotals[i] / btc[i]! : null,
  }));
  return { points, perAsset };
}

/** Monthly view: the last daily point of each UTC calendar month, always keeping the newest point. */
export function sampleMonthly<T extends { t: number }>(points: T[]): T[] {
  if (points.length === 0) return [];
  const monthOf = (t: number) => {
    const d = new Date(t);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const isLastOfMonth = i === points.length - 1 || monthOf(points[i + 1].t) !== monthOf(points[i].t);
    if (isLastOfMonth) out.push(points[i]);
  }
  return out;
}
