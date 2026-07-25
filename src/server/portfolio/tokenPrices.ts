import { and, eq } from "drizzle-orm";
import { assets, contractCoinMap } from "@/server/db/schema";
import type { AssetRow, MarketDb } from "@/server/market/candleCache";
import { getCandles } from "@/server/market/candleCache";
import {
  CONTRACT_PLATFORMS,
  fetchCoinGeckoContract,
  type ContractCoin,
} from "@/server/market/coingecko";

/**
 * Contract → CoinGecko coin resolution and daily historical closes for
 * portfolio valuation. Resolution is a fetch-through over contract_coin_map;
 * a NULL coingecko_id row is a negative cache (CoinGecko doesn't list the
 * token) retried only after RETRY_NEGATIVE_MS.
 */

const RETRY_NEGATIVE_MS = 30 * 86_400_000;

/** CoinGecko id for a chain's native asset (no contract address). */
export const NATIVE_COINGECKO_ID: Record<number, string> = {
  1: "ethereum",
  8453: "ethereum",
  42161: "ethereum",
  10: "ethereum",
  137: "polygon-ecosystem-token",
};

export type ContractCoinFetcher = (
  platform: string,
  address: string,
) => Promise<ContractCoin | null>;

export async function resolveCoinForContract(
  db: MarketDb,
  chainId: number,
  address: string,
  fetchCoin: ContractCoinFetcher = fetchCoinGeckoContract,
  now: () => number = Date.now,
): Promise<ContractCoin | null> {
  const platform = CONTRACT_PLATFORMS[chainId];
  if (!platform) return null;
  const normalized = address.toLowerCase();

  const [row] = await db
    .select()
    .from(contractCoinMap)
    .where(and(eq(contractCoinMap.chainId, chainId), eq(contractCoinMap.address, normalized)));
  if (row) {
    const negativeExpired =
      row.coingeckoId === null && now() - row.resolvedAt.getTime() > RETRY_NEGATIVE_MS;
    if (!negativeExpired) {
      return row.coingeckoId === null
        ? null
        : { coingeckoId: row.coingeckoId, symbol: row.symbol ?? "", name: row.name ?? "" };
    }
  }

  const coin = await fetchCoin(platform, normalized);
  await db
    .insert(contractCoinMap)
    .values({
      chainId,
      address: normalized,
      coingeckoId: coin?.coingeckoId ?? null,
      symbol: coin?.symbol ?? null,
      name: coin?.name ?? null,
      resolvedAt: new Date(now()),
    })
    .onConflictDoUpdate({
      target: [contractCoinMap.chainId, contractCoinMap.address],
      set: {
        coingeckoId: coin?.coingeckoId ?? null,
        symbol: coin?.symbol ?? null,
        name: coin?.name ?? null,
        resolvedAt: new Date(now()),
      },
    });
  return coin;
}

/**
 * Get-or-create the assets row for a CoinGecko coin. New rows are inserted
 * with binanceSymbol null (CoinGecko-only ⇒ 1d candles); seeded majors with a
 * Binance pair are reused untouched via the coingecko_id unique constraint.
 */
export async function ensureAsset(db: MarketDb, coin: ContractCoin): Promise<AssetRow> {
  await db
    .insert(assets)
    .values({
      coingeckoId: coin.coingeckoId,
      symbol: coin.symbol,
      name: coin.name,
      binanceSymbol: null,
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(assets).where(eq(assets.coingeckoId, coin.coingeckoId));
  return row;
}

/** Daily closes keyed by UTC day-open ms, via the permanent candle cache. */
export async function getDailyCloses(
  db: MarketDb,
  asset: AssetRow,
  fromMs: number,
  toMs: number,
): Promise<Map<number, number>> {
  const { candles } = await getCandles(db, asset, "1d", fromMs, toMs);
  return new Map(candles.map((c) => [c.t, c.c]));
}
