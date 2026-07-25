/**
 * Shared portfolio data shapes. `Position` is what balance adapters produce
 * (persisted as JSONB in holdings_snapshots); `Transfer` is a normalized
 * on-chain transfer (persisted in wallet_transfers); `HistoryItem` is the
 * merged read model served to the UI (on-chain transfers + app executions).
 */

export type Position = {
  chainId: number;
  network: string;
  tokenAddress: string | null; // null = native asset
  symbol: string;
  name: string;
  decimals: number;
  balance: string; // decimal string in token units
  priceUsd: number | null;
  valueUsd: number | null;
  priceSource?: "coingecko"; // absent = priced by Alchemy (or unpriced)
};

export type Transfer = {
  network: string;
  chainId: number | null; // null for future non-EVM chains
  uniqueId: string; // provider-stable dedupe key (txHash for non-EVM)
  txHash: string;
  ts: number; // ms epoch
  direction: "in" | "out" | "self";
  category: string; // external | internal | erc20 (EVM); adapter-defined elsewhere
  assetSymbol: string | null;
  assetAddress: string | null;
  amount: string | null; // decimal string in token units
  counterparty: string | null;
};

export type HistoryItem = {
  ts: number;
  type: "transfer" | "trade";
  direction: "in" | "out" | "self" | null;
  assetSymbol: string | null;
  amount: string | null;
  counterparty: string | null;
  chainId: number | null;
  network: string | null;
  txHash: string | null;
  status: string | null; // executions only: pending | confirmed | failed
  category: string | null;
  /** Stable tag key: txHash, or "exec:<id>" for a hash-less pending execution. */
  txKey: string;
  tags: string[];
};
