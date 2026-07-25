import { db } from "../db";
import type { AssetRow } from "./candleCache";
import { getCandles } from "./candleCache";
import { INTERVAL_MS } from "./types";

export type AssetSnapshot = {
  lastClose: number;
  lastCandleDate: string;
  change24hPct: number | null;
  change7dPct: number | null;
  change30dPct: number | null;
  high90d: number;
  low90d: number;
  distanceFrom90dHighPct: number;
  distanceFrom90dLowPct: number;
};

const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
const round = (v: number, d = 2) => Number(v.toFixed(d));

/** Daily-candle snapshot for one asset (used by pages and the AI tool). */
export async function assetSnapshot(asset: AssetRow): Promise<AssetSnapshot | null> {
  const now = Date.now();
  const day = INTERVAL_MS["1d"];
  const { candles } = await getCandles(db, asset, "1d", now - 91 * day, now);
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const at = (daysAgo: number) => candles[candles.length - 1 - daysAgo]?.c;
  const high90d = Math.max(...candles.map((c) => c.h));
  const low90d = Math.min(...candles.map((c) => c.l));
  return {
    lastClose: last.c,
    lastCandleDate: new Date(last.t).toISOString().slice(0, 10),
    change24hPct: at(1) !== undefined ? round(pct(last.c, at(1)!)) : null,
    change7dPct: at(7) !== undefined ? round(pct(last.c, at(7)!)) : null,
    change30dPct: at(30) !== undefined ? round(pct(last.c, at(30)!)) : null,
    high90d,
    low90d,
    distanceFrom90dHighPct: round(pct(last.c, high90d)),
    distanceFrom90dLowPct: round(pct(last.c, low90d)),
  };
}
