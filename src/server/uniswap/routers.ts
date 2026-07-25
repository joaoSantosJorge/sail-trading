/**
 * Hardcoded per-chain allowlist of contracts a swap transaction may target.
 * The Uniswap Trading API returns the `to` address for the transaction; we
 * NEVER forward a target that is not on this list — if the API (or anything
 * between) ever returns an unknown address, the trade is blocked.
 *
 * Sources: Uniswap deployment registry (UniversalRouter v1/v2, Permit2).
 * Permit2 is deployed at the same address on every chain.
 */

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const ALLOWED_TARGETS: Record<number, Set<string>> = {
  // Ethereum mainnet
  1: new Set([
    PERMIT2,
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // UniversalRouter
    "0x66a9893cc07d91d95644aedd05d03f95e1dba8af", // UniversalRouter v2 (v4)
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", // V2 SwapRouter02 legacy
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // SwapRouter02
  ]),
  // Base
  8453: new Set([
    PERMIT2,
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", // UniversalRouter
    "0x6ff5693b99212da76ad316178a184ab56d299b43", // UniversalRouter v2 (v4)
    "0x2626664c2603336e57b271c5c0b26f421741e481", // SwapRouter02
  ]),
  // Arbitrum One
  42161: new Set([
    PERMIT2,
    "0x5e325eda8064b456f4781070c0738d849c824258", // UniversalRouter
    "0xa51afafe0263b40edaef0df8781ea9aa03e381a3", // UniversalRouter v2 (v4)
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", // SwapRouter02
  ]),
};

export const SUPPORTED_CHAIN_IDS = Object.keys(ALLOWED_TARGETS).map(Number);

export function isAllowedTarget(chainId: number, to: string): boolean {
  return ALLOWED_TARGETS[chainId]?.has(to.toLowerCase()) ?? false;
}

/**
 * Well-known tradeable tokens per chain (output side of proposals). The input
 * side comes from the user's wallet snapshot. Addresses are canonical;
 * decimals verified against the token contracts.
 */
export type KnownToken = {
  symbol: string;
  name: string;
  address: string | null; // null = native ETH
  decimals: number;
};

export const KNOWN_TOKENS: Record<number, KnownToken[]> = {
  1: [
    { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
    { symbol: "WETH", name: "Wrapped Ether", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18 },
    { symbol: "USDC", name: "USD Coin", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    { symbol: "USDT", name: "Tether USD", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 },
    { symbol: "DAI", name: "Dai", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
    { symbol: "WBTC", name: "Wrapped BTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  ],
  8453: [
    { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
    { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    { symbol: "USDC", name: "USD Coin", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    { symbol: "DAI", name: "Dai", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", decimals: 18 },
    { symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8 },
  ],
  42161: [
    { symbol: "ETH", name: "Ether", address: null, decimals: 18 },
    { symbol: "WETH", name: "Wrapped Ether", address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", decimals: 18 },
    { symbol: "USDC", name: "USD Coin", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
    { symbol: "USDT", name: "Tether USD", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 },
    { symbol: "WBTC", name: "Wrapped BTC", address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", decimals: 8 },
  ],
};

export function findKnownToken(chainId: number, symbolOrAddress: string): KnownToken | null {
  const list = KNOWN_TOKENS[chainId] ?? [];
  const needle = symbolOrAddress.toLowerCase();
  return (
    list.find(
      (t) => t.symbol.toLowerCase() === needle || (t.address !== null && t.address === needle),
    ) ?? null
  );
}

export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
};
