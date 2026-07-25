import { CONTRACT_PLATFORMS, getTokenPricesByContract } from "../market/coingecko";
import type { Position } from "./types";

/**
 * Second-chance pricing for positions Alchemy returned without a USD price:
 * batch CoinGecko's by-contract lookup per chain and fill the gaps, tagged
 * priceSource "coingecko". Degrades per chain — a CoinGecko failure (or an
 * unknown token) just leaves those rows unpriced; it never fails the sync.
 */

export type ContractPriceFetcher = (
  platform: string,
  addresses: string[],
) => Promise<Record<string, { usd?: number }>>;

// Memo per platform:address (~5 min) so back-to-back syncs of overlapping
// wallets don't burn the shared CoinGecko budget. Mirrors spot.ts.
const TTL_MS = 5 * 60 * 1000;
const memo = new Map<string, { at: number; usd: number | null }>();

/** Test hook — the memo is module-global state. */
export function clearPriceMemo(): void {
  memo.clear();
}

export async function fillMissingPrices(
  positions: Position[],
  fetchPrices: ContractPriceFetcher = getTokenPricesByContract,
  now: () => number = Date.now,
): Promise<Position[]> {
  const byPlatform = new Map<string, string[]>();
  for (const p of positions) {
    const platform = CONTRACT_PLATFORMS[p.chainId];
    if (p.priceUsd !== null || p.tokenAddress === null || !platform) continue;
    const key = `${platform}:${p.tokenAddress.toLowerCase()}`;
    const hit = memo.get(key);
    if (hit && now() - hit.at < TTL_MS) continue; // memo answers this one
    byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), p.tokenAddress.toLowerCase()]);
  }

  for (const [platform, addresses] of byPlatform) {
    try {
      const prices = await fetchPrices(platform, addresses);
      for (const addr of addresses) {
        const usd = prices[addr]?.usd;
        memo.set(`${platform}:${addr}`, {
          at: now(),
          usd: typeof usd === "number" && Number.isFinite(usd) ? usd : null,
        });
      }
    } catch {
      // Leave these rows unpriced; a later sync retries (nothing memoized).
    }
  }

  const filled = positions.map((p) => {
    const platform = CONTRACT_PLATFORMS[p.chainId];
    if (p.priceUsd !== null || p.tokenAddress === null || !platform) return p;
    const usd = memo.get(`${platform}:${p.tokenAddress.toLowerCase()}`)?.usd;
    if (usd === null || usd === undefined) return p;
    return {
      ...p,
      priceUsd: usd,
      valueUsd: Number(p.balance) * usd,
      priceSource: "coingecko" as const,
    };
  });

  filled.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return filled;
}
