import { getSimplePrices } from "./coingecko";

/**
 * Memoized spot USD prices by CoinGecko id (module-level, ~5 min TTL) so
 * page renders and router.refresh() churn don't burn the shared CoinGecko
 * budget. Returns null on any upstream failure — callers degrade (UI shows
 * "—"), never block.
 */

const TTL_MS = 5 * 60 * 1000;
const memo = new Map<string, { at: number; usd: number }>();

export async function getSpotUsd(coingeckoId: string): Promise<number | null> {
  const hit = memo.get(coingeckoId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.usd;
  try {
    const prices = await getSimplePrices([coingeckoId]);
    const usd = prices[coingeckoId]?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) return hit?.usd ?? null;
    memo.set(coingeckoId, { at: Date.now(), usd });
    return usd;
  } catch {
    return hit?.usd ?? null; // serve stale on error, like the news cache
  }
}
