import { env } from "../env";
import type { Position } from "./types";

/**
 * Alchemy Portfolio API — token balances with prices across chains in one
 * call. Docs: https://www.alchemy.com/docs/reference/portfolio-apis
 */

export const NETWORKS = [
  "eth-mainnet",
  "base-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "polygon-mainnet",
] as const;

export type AlchemyNetwork = (typeof NETWORKS)[number];

// Response rows may use Alchemy's legacy Polygon name ("matic-mainnet")
// even when the request said "polygon-mainnet" — map both (live-verified
// 2026-07-23: the Portfolio API echoes matic-mainnet).
export const CHAIN_IDS: Record<string, number> = {
  "eth-mainnet": 1,
  "base-mainnet": 8453,
  "arb-mainnet": 42161,
  "opt-mainnet": 10,
  "polygon-mainnet": 137,
  "matic-mainnet": 137,
};

/** Native-asset symbol per network (tokenAddress === null rows). */
const NATIVE_SYMBOLS: Record<string, string> = {
  "eth-mainnet": "ETH",
  "base-mainnet": "ETH",
  "arb-mainnet": "ETH",
  "opt-mainnet": "ETH",
  "polygon-mainnet": "POL",
  "matic-mainnet": "POL",
};

// Re-export so existing imports (`wallets-panel`, AI tools) keep working.
export type { Position } from "./types";

type AlchemyTokenRow = {
  address: string;
  network: string;
  tokenAddress: string | null;
  tokenBalance: string; // hex
  tokenMetadata?: { symbol?: string | null; name?: string | null; decimals?: number | null };
  tokenPrices?: { currency: string; value: string }[];
};

export class AlchemyError extends Error {}

function hexToDecimalString(hex: string, decimals: number): string {
  const value = BigInt(hex);
  if (value === 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 8);
  return `${whole}.${fracStr}`;
}

/**
 * Fetch token positions (native + ERC-20, with USD prices) for one address
 * across Ethereum/Base/Arbitrum. Spam filtering: drops tokens without a price
 * AND without a plausible symbol, plus zero balances.
 */
export async function getPortfolio(address: string): Promise<Position[]> {
  if (!env.ALCHEMY_API_KEY) {
    throw new AlchemyError("ALCHEMY_API_KEY is not set — add it to .env.local");
  }

  const res = await fetch(
    `https://api.g.alchemy.com/data/v1/${env.ALCHEMY_API_KEY}/assets/tokens/by-address`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addresses: [{ address, networks: NETWORKS }],
        withMetadata: true,
        withPrices: true,
      }),
    },
  );
  if (!res.ok) {
    throw new AlchemyError(`Alchemy ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { data?: { tokens?: AlchemyTokenRow[] } };
  const rows = data.data?.tokens ?? [];

  const positions: Position[] = [];
  for (const row of rows) {
    const network = row.network as AlchemyNetwork;
    const decimals = row.tokenMetadata?.decimals ?? 18;
    const symbol =
      row.tokenMetadata?.symbol ??
      (row.tokenAddress === null ? (NATIVE_SYMBOLS[network] ?? "ETH") : "");
    const balance = hexToDecimalString(row.tokenBalance, decimals);
    if (balance === "0") continue;

    const priceRow = row.tokenPrices?.find((p) => p.currency.toLowerCase() === "usd");
    const priceUsd = priceRow ? Number(priceRow.value) : null;
    // Spam heuristic: unpriced token with a junk/absent symbol.
    if (priceUsd === null && (!symbol || symbol.length > 12)) continue;

    positions.push({
      chainId: CHAIN_IDS[network] ?? 0,
      network: row.network,
      tokenAddress: row.tokenAddress,
      symbol: symbol || "?",
      name: row.tokenMetadata?.name ?? symbol ?? "Unknown",
      decimals,
      balance,
      priceUsd,
      valueUsd: priceUsd !== null ? Number(balance) * priceUsd : null,
    });
  }

  positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return positions;
}
