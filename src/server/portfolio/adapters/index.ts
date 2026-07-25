import { evmAdapter } from "./evm";
import { hyperliquidAdapter } from "./hyperliquid";
import type { ChainAdapter } from "./types";

/** Registry of chain-ecosystem adapters. Add solana/bitcoin/sui
 * here (and widen the API route's chain enum) — callers don't change. */
export const adapters = {
  evm: evmAdapter,
  hyperliquid: hyperliquidAdapter,
} as const satisfies Record<string, ChainAdapter>;

export type ChainKind = keyof typeof adapters;

export function getAdapter(chain: string): ChainAdapter | null {
  return (adapters as Record<string, ChainAdapter>)[chain] ?? null;
}

export type { ChainAdapter } from "./types";
