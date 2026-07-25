import { env } from "../env";
import { TokenBucket } from "./rateLimiter";
import { INTERVAL_MS, type Candle, type ChartInterval } from "./types";

const BASE = "https://api.coingecko.com/api/v3";

// Demo tier allows 30/min; stay under it. Keyless public access is far lower,
// so without a key expect this to be slow — fine for occasional long-tail use.
const bucket = new TokenBucket(25, 25 / 60);

// TODO(M2+): move the monthly budget counter into the DB (api_usage table) so
// it survives restarts; in-memory is good enough while the only consumer is
// occasional long-tail backfills.
let monthlyCalls = 0;
const MONTHLY_BUDGET = 10_000;

async function cgFetch(path: string): Promise<unknown> {
  await bucket.take();
  monthlyCalls += 1;
  if (monthlyCalls > MONTHLY_BUDGET * 0.8) {
    console.warn(`[coingecko] ${monthlyCalls} calls this process — nearing the 10k/mo budget`);
  }
  const headers: Record<string, string> = {};
  if (env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = env.COINGECKO_API_KEY;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`CoinGecko ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

export async function searchCoins(
  query: string,
): Promise<{ id: string; symbol: string; name: string }[]> {
  const data = (await cgFetch(`/search?query=${encodeURIComponent(query)}`)) as {
    coins: { id: string; symbol: string; name: string }[];
  };
  return data.coins.map(({ id, symbol, name }) => ({ id, symbol, name }));
}

export async function getSimplePrices(
  coingeckoIds: string[],
): Promise<Record<string, { usd: number; usd_24h_change?: number }>> {
  if (coingeckoIds.length === 0) return {};
  const ids = coingeckoIds.map(encodeURIComponent).join(",");
  return (await cgFetch(
    `/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
  )) as Record<string, { usd: number; usd_24h_change?: number }>;
}

/** CoinGecko asset-platform slugs for the EVM chains the portfolio sync covers. */
export const CONTRACT_PLATFORMS: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum-one",
  10: "optimistic-ethereum",
  137: "polygon-pos",
};

/**
 * USD prices by ERC-20 contract address on one platform. Response keys are
 * lowercase contract addresses; tokens CoinGecko doesn't know are simply
 * absent. Chunked to stay within the demo tier's per-call address limit.
 */
export async function getTokenPricesByContract(
  platform: string,
  addresses: string[],
): Promise<Record<string, { usd?: number }>> {
  const out: Record<string, { usd?: number }> = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses
      .slice(i, i + 100)
      .map(encodeURIComponent)
      .join(",");
    Object.assign(
      out,
      (await cgFetch(
        `/simple/token_price/${encodeURIComponent(platform)}?contract_addresses=${chunk}&vs_currencies=usd`,
      )) as Record<string, { usd?: number }>,
    );
  }
  return out;
}

export type ContractCoin = { coingeckoId: string; symbol: string; name: string };

/**
 * Resolve an ERC-20 contract to its CoinGecko coin. Returns null when
 * CoinGecko doesn't know the token (404) — callers negative-cache that.
 */
export async function fetchCoinGeckoContract(
  platform: string,
  address: string,
): Promise<ContractCoin | null> {
  try {
    const data = (await cgFetch(
      `/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(address)}`,
    )) as { id: string; symbol: string; name: string };
    return { coingeckoId: data.id, symbol: data.symbol.toUpperCase(), name: data.name };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("CoinGecko 404 ")) return null;
    throw err;
  }
}

/**
 * Daily pseudo-candles for assets with no Binance pair, built from
 * /market_chart/range price points (hourly ≤90d spans, daily beyond).
 * o/h/l/c are derived from the points inside each UTC day bucket, so candles
 * built from daily-granularity data collapse to o≈h≈l≈c. Good enough for
 * long-tail charting; NOT precision backtest data. Majors use Binance.
 */
export async function fetchCoinGeckoDailyCandles(
  coingeckoId: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const dayMs = INTERVAL_MS["1d"];
  const data = (await cgFetch(
    `/coins/${encodeURIComponent(coingeckoId)}/market_chart/range?vs_currency=usd&from=${Math.floor(
      fromMs / 1000,
    )}&to=${Math.ceil((toMs + dayMs) / 1000)}`,
  )) as { prices: [number, number][]; total_volumes: [number, number][] };

  const buckets = new Map<number, Candle>();
  for (const [ts, price] of data.prices) {
    const t = Math.floor(ts / dayMs) * dayMs;
    const b = buckets.get(t);
    if (!b) {
      buckets.set(t, { t, o: price, h: price, l: price, c: price, v: 0 });
    } else {
      b.h = Math.max(b.h, price);
      b.l = Math.min(b.l, price);
      b.c = price;
    }
  }
  for (const [ts, vol] of data.total_volumes) {
    const b = buckets.get(Math.floor(ts / dayMs) * dayMs);
    if (b) b.v = vol;
  }

  return [...buckets.values()]
    .filter((c) => c.t >= fromMs && c.t <= toMs)
    .sort((a, b) => a.t - b.t);
}

export function coingeckoSupports(interval: ChartInterval): boolean {
  return interval === "1d";
}
