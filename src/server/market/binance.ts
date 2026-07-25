import { TokenBucket } from "./rateLimiter";
import { nextOpen, type Candle, type ChartInterval } from "./types";

const BASE = "https://api.binance.com/api/v3";

// Binance allows far more, but 10 req/s keeps us nowhere near their IP weight limits.
const bucket = new TokenBucket(10, 10);

type KlineRow = [number, string, string, string, string, string, ...unknown[]];

/**
 * Fetch closed klines for a Binance spot symbol (e.g. "ETHUSDT").
 * from/to are inclusive bounds on candle *open time* in ms. Pages through
 * 1000-candle responses; our interval names match Binance's exactly.
 */
export async function fetchBinanceKlines(
  symbol: string,
  interval: ChartInterval,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = fromMs;

  while (start <= toMs) {
    await bucket.take();
    const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${toMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance klines ${res.status} for ${symbol}: ${await res.text()}`);
    }
    const rows = (await res.json()) as KlineRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      out.push({
        t: row[0],
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: Number(row[5]),
      });
    }
    if (rows.length < 1000) break;
    start = nextOpen(rows[rows.length - 1][0], interval);
  }

  return out.filter((c) => c.t >= fromMs && c.t <= toMs);
}

export type Binance24hTicker = {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
};

type Ticker24hRow = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};

/**
 * 24h rolling stats for a batch of spot symbols in one request. Binance
 * expects the symbols param as a URL-encoded JSON array without spaces.
 */
export async function fetchBinance24hTickers(symbols: string[]): Promise<Binance24hTicker[]> {
  if (symbols.length === 0) return [];
  await bucket.take();
  const url = `${BASE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance 24hr tickers ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = (await res.json()) as Ticker24hRow[];
  return rows.map((r) => ({
    symbol: r.symbol,
    lastPrice: Number(r.lastPrice),
    priceChangePercent: Number(r.priceChangePercent),
    quoteVolume: Number(r.quoteVolume),
  }));
}
