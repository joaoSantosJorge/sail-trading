import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { walletTransfers, walletTransferSync } from "../db/schema";
import {
  fetchTransfers,
  TRANSFER_NETWORKS,
  type TransferWithRaw,
} from "./alchemyTransfers";
import type { AlchemyNetwork } from "./alchemy";

/**
 * Fetch-through transfer-history cache, mirroring candle/news caches: a
 * per-(wallet, network) block watermark; each sync fetches only blocks past
 * it and upserts with onConflictDoNothing on the provider's uniqueId. A
 * failing network is recorded and skipped — one flaky chain never fails the
 * whole sync (stale-tolerant, like the news cache).
 */

export type TransferDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type TransferDeps = {
  fetch: (
    network: AlchemyNetwork,
    address: string,
    fromBlock?: string,
  ) => Promise<{ transfers: TransferWithRaw[]; latestBlock: string | null }>;
  now: () => number;
};

const defaultDeps: TransferDeps = {
  fetch: (network, address, fromBlock) => fetchTransfers(network, address, { fromBlock }),
  now: Date.now,
};

function nextBlock(hexBlock: string): string {
  return `0x${(BigInt(hexBlock) + 1n).toString(16)}`;
}

/**
 * Sync one wallet's transfers across all EVM networks. Returns per-network
 * insert counts and any per-network errors (never throws for a single
 * network failure).
 */
export async function syncTransfers(
  db: TransferDb,
  { userId, wallet }: { userId: string; wallet: string },
  deps: TransferDeps = defaultDeps,
): Promise<{ inserted: number; errors: string[] }> {
  let inserted = 0;
  const errors: string[] = [];

  for (const network of TRANSFER_NETWORKS) {
    try {
      const [mark] = await db
        .select()
        .from(walletTransferSync)
        .where(
          and(
            eq(walletTransferSync.userId, userId),
            eq(walletTransferSync.wallet, wallet),
            eq(walletTransferSync.network, network),
          ),
        );

      const fromBlock = mark ? nextBlock(mark.latestBlock) : undefined;
      const { transfers, latestBlock } = await deps.fetch(network, wallet, fromBlock);

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
          raw: t.raw as Record<string, unknown> | null,
        }));
        const result = await db
          .insert(walletTransfers)
          .values(rows)
          .onConflictDoNothing()
          .returning({ id: walletTransfers.id });
        inserted += result.length;
      }

      if (latestBlock !== null) {
        await db
          .insert(walletTransferSync)
          .values({ userId, wallet, network, latestBlock, fetchedAt: new Date(deps.now()) })
          .onConflictDoUpdate({
            target: [walletTransferSync.userId, walletTransferSync.wallet, walletTransferSync.network],
            set: { latestBlock, fetchedAt: new Date(deps.now()) },
          });
      }
    } catch (err) {
      errors.push(`${network}: ${err instanceof Error ? err.message : "sync failed"}`);
    }
  }

  return { inserted, errors };
}

/** Stored transfer count for a wallet (UI badge / debugging). */
export async function countTransfers(db: TransferDb, userId: string, wallet: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletTransfers)
    .where(and(eq(walletTransfers.userId, userId), eq(walletTransfers.wallet, wallet)));
  return row?.count ?? 0;
}
