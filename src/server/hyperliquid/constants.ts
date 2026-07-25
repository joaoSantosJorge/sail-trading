/** Network tag used in Position.network, wallet_transfers.network, etc. */
export const HYPERLIQUID_NETWORK = "hyperliquid";

/**
 * Sentinel for Position.chainId, which is non-nullable. Hyperliquid's L1 has
 * no EVM chainId; 1337 is the venue's EIP-712 signing-domain id. A venue tag
 * only — never build an RPC client or viem chain from it.
 */
export const HYPERLIQUID_CHAIN_ID = 1337;
