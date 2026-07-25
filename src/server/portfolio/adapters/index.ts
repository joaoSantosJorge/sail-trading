import { evmAdapter } from "./evm";
import type { ChainAdapter } from "./types";

/** Registry of chain-ecosystem adapters. Add solana/bitcoin/sui/hyperliquid
 * here (and widen the API route's chain enum) — callers don't change. */
export const adapters = {
  evm: evmAdapter,
} as const satisfies Record<string, ChainAdapter>;

export type ChainKind = keyof typeof adapters;

export function getAdapter(chain: string): ChainAdapter | null {
  return (adapters as Record<string, ChainAdapter>)[chain] ?? null;
}

export type { ChainAdapter } from "./types";
