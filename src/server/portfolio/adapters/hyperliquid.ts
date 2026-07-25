import { and, eq } from "drizzle-orm";
import { walletTransfers, walletTransferSync } from "@/server/db/schema";
import { HYPERLIQUID_NETWORK } from "@/server/hyperliquid/constants";
import {
  allMids,
  clearinghouseState,
  spotClearinghouseState,
  userNonFundingLedgerUpdates,
} from "@/server/hyperliquid/info";
import {
  normalizeLedgerUpdates,
  normalizePerpState,
  normalizeSpotBalances,
} from "@/server/hyperliquid/normalize";
import type { PerpPosition, Position } from "../types";
import type { TransferDb } from "../transferCache";
import type { ChainAdapter } from "./types";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function getBalances(address: string): Promise<Position[]> {
  const [perpState, spotState, mids] = await Promise.all([
    clearinghouseState(address),
    spotClearinghouseState(address),
    allMids(),
  ]);
  const { marginPosition } = normalizePerpState(perpState);
  const spot = normalizeSpotBalances(spotState, mids);
  return marginPosition ? [marginPosition, ...spot] : spot;
}

async function getPerpPositions(address: string): Promise<PerpPosition[]> {
  return normalizePerpState(await clearinghouseState(address)).perps;
}

/**
 * Ledger-update sync mirroring the EVM transfer cache: the per-(wallet,
 * network) watermark row stores the last update time in ms (as text, in the
 * latestBlock column — it predates non-block chains). Single ecosystem, so
 * unlike EVM there's one network and one failure domain.
 */
async function syncTransfers(
  db: TransferDb,
  { userId, wallet }: { userId: string; wallet: string },
): Promise<{ inserted: number; errors: string[] }> {
  try {
    const [mark] = await db
      .select()
      .from(walletTransferSync)
      .where(
        and(
          eq(walletTransferSync.userId, userId),
          eq(walletTransferSync.wallet, wallet),
          eq(walletTransferSync.network, HYPERLIQUID_NETWORK),
        ),
      );

    const fromMs = mark ? Number(mark.latestBlock) + 1 : 0;
    const updates = await userNonFundingLedgerUpdates(wallet, fromMs);
    const transfers = normalizeLedgerUpdates(updates, wallet);

    let inserted = 0;
    if (transfers.length > 0) {
      const rows = transfers.map((t) => ({
        userId,
        wallet,
        network: t.network,
        chainId: t.chainId,
        uniqueId: t.uniqueId,
        txHash: t.txHash,
        ts: new Date(t.ts),
        direction: t.direction,
        category: t.category,
        assetSymbol: t.assetSymbol,
        assetAddress: t.assetAddress,
        amount: t.amount,
        counterparty: t.counterparty,
        raw: null,
      }));
      const result = await db
        .insert(walletTransfers)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: walletTransfers.id });
      inserted = result.length;
    }

    const latest = updates.length > 0 ? Math.max(...updates.map((u) => u.time)) : null;
    if (latest !== null) {
      const latestBlock = String(latest);
      await db
        .insert(walletTransferSync)
        .values({ userId, wallet, network: HYPERLIQUID_NETWORK, latestBlock, fetchedAt: new Date() })
        .onConflictDoUpdate({
          target: [walletTransferSync.userId, walletTransferSync.wallet, walletTransferSync.network],
          set: { latestBlock, fetchedAt: new Date() },
        });
    }
    return { inserted, errors: [] };
  } catch (err) {
    return {
      inserted: 0,
      errors: [`hyperliquid: ${err instanceof Error ? err.message : "sync failed"}`],
    };
  }
}

/** Hyperliquid via its keyless info API: perps margin + spot balances,
 * open perp positions, and deposit/withdraw/transfer history. */
export const hyperliquidAdapter: ChainAdapter = {
  kind: "hyperliquid",
  validateAddress: (address) => ADDRESS_RE.test(address),
  getBalances,
  getPerpPositions,
  syncTransfers,
};
