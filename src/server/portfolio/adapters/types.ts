import type { PerpPosition, Position } from "../types";
import type { TransferDb } from "../transferCache";

/**
 * One adapter per chain ecosystem. "evm" fans out internally to all Alchemy
 * EVM networks; future adapters (solana, bitcoin via mempool.space, sui,
 * hyperliquid via its info API) implement the same surface, so swapping or
 * adding a data provider (e.g. Zerion) is a new adapter — not a rewrite.
 * Decision record: docs/portfolio-data-research.md.
 */
export interface ChainAdapter {
  kind: string;
  /** Address syntax check for this ecosystem (0x40-hex for EVM). */
  validateAddress(address: string): boolean;
  /** Live balances with USD prices for one address. */
  getBalances(address: string): Promise<Position[]>;
  /** Open perpetual positions, for venues that have them (Hyperliquid). */
  getPerpPositions?(address: string): Promise<PerpPosition[]>;
  /**
   * Incrementally sync the address's transfer history into wallet_transfers.
   * Must never throw for a single-network failure — report via `errors`.
   */
  syncTransfers(
    db: TransferDb,
    args: { userId: string; wallet: string },
  ): Promise<{ inserted: number; errors: string[] }>;
}
