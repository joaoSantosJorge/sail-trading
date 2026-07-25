import { env } from "../env";
import { TokenBucket } from "./rateLimiter";
import { nextOpen, type Candle, type ChartInterval } from "./types";

const BASE = env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz";

// The info endpoint allows ~1200 weighted req/min per IP; 5 req/s stays far under.
const bucket = new TokenBucket(5, 5);

// candleSnapshot item: t/T are open/close time ms, prices and volume are strings.
type HlCandle = {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
};

/**
 * Fetch closed candles for a Hyperliquid perp coin (e.g. "HYPE", "BTC").
 * from/to are inclusive bounds on candle *open time* in ms. Interval names and
 * week/month boundaries match Binance's, so the shared alignment helpers apply.
 *
 * Venue limit: Hyperliquid keeps only the most recent 5000 candles per
 * coin/interval — older history simply doesn't exist upstream. Prices are
 * perp-market prices, which is fine for charting and backtesting.
 */
export async function fetchHyperliquidCandles(
  coin: string,
  interval: ChartInterval,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let start = fromMs;

  while (start <= toMs) {
    await bucket.take();
    const res = await fetch(`${BASE}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval, startTime: start, endTime: toMs },
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Hyperliquid candleSnapshot ${res.status} for ${coin}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const rows = (await res.json()) as HlCandle[];
    if (rows.length === 0) break;

    for (const row of rows) {
      out.push({
        t: row.t,
        o: Number(row.o),
        h: Number(row.h),
        l: Number(row.l),
        c: Number(row.c),
        v: Number(row.v),
      });
    }
    if (rows.length < 5000) break;
    start = nextOpen(rows[rows.length - 1].t, interval);
  }

  return out.filter((c) => c.t >= fromMs && c.t <= toMs);
}
