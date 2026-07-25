/** Block-explorer tx links per EVM chain id. Pure + client-safe. */

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  10: "https://optimistic.etherscan.io",
  137: "https://polygonscan.com",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
};

export function txUrl(chainId: number | null, txHash: string | null): string | null {
  if (chainId === null || !txHash) return null;
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${txHash}` : null;
}

export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  // Venue sentinel, not an EVM chain (see server/hyperliquid/constants.ts).
  1337: "Hyperliquid",
};

export function chainName(chainId: number | null): string {
  if (chainId === null) return "—";
  return CHAIN_NAMES[chainId] ?? String(chainId);
}
