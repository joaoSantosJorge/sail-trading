import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { holdingsSnapshots, wallets } from "@/server/db/schema";
import { type Position } from "./alchemy";
import { adapters, getAdapter, type ChainKind } from "./adapters";
import { fillMissingPrices } from "./prices";
import type { PerpPosition } from "./types";

export async function listWallets(userId: string) {
  return db.select().from(wallets).where(eq(wallets.userId, userId));
}

export async function registerWallet(
  userId: string,
  address: string,
  opts: { chain?: ChainKind; label?: string } = {},
) {
  const normalized = address.toLowerCase();
  await db
    .insert(wallets)
    .values({ userId, address: normalized, chain: opts.chain ?? "evm", label: opts.label ?? null })
    .onConflictDoNothing();
  return normalized;
}

export async function removeWallet(userId: string, address: string): Promise<boolean> {
  const deleted = await db
    .delete(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.address, address.toLowerCase())))
    .returning({ address: wallets.address });
  return deleted.length > 0;
}

/**
 * Fetch live holdings and persist a snapshot, then incrementally sync the
 * wallet's on-chain transfer history. Ownership-checked. Transfer-sync
 * failures are reported, never fatal — balances still land.
 */
export async function syncWallet(
  userId: string,
  address: string,
): Promise<{
  positions: Position[];
  perps: PerpPosition[];
  totalUsd: number;
  takenAt: string;
  transfersInserted: number;
  transferErrors: string[];
}> {
  const normalized = address.toLowerCase();
  const [row] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.address, normalized)));
  if (!row) throw new Error("wallet not registered for this user");

  const adapter = getAdapter(row.chain) ?? adapters.evm;
  const positions = await fillMissingPrices(await adapter.getBalances(normalized));
  const perps = adapter.getPerpPositions ? await adapter.getPerpPositions(normalized) : [];
  const totalUsd = positions.reduce((a, p) => a + (p.valueUsd ?? 0), 0);
  const takenAt = new Date();

  await db.insert(holdingsSnapshots).values({
    userId,
    wallet: normalized,
    positions,
    perps: adapter.getPerpPositions ? perps : null,
  });
  await db
    .update(wallets)
    .set({
      lastSyncedAt: takenAt,
      chainIds: [...new Set(positions.map((p) => p.chainId))],
    })
    .where(and(eq(wallets.userId, userId), eq(wallets.address, normalized)));

  const transfers = await adapter.syncTransfers(db, { userId, wallet: normalized });

  return {
    positions,
    perps,
    totalUsd,
    takenAt: takenAt.toISOString(),
    transfersInserted: transfers.inserted,
    transferErrors: transfers.errors,
  };
}

/** Latest persisted snapshot per registered wallet (for pages + the AI tool). */
export async function latestSnapshots(userId: string) {
  const registered = await listWallets(userId);
  const out: {
    address: string;
    chain: string;
    label: string | null;
    lastSyncedAt: string | null;
    positions: Position[];
    perps: PerpPosition[];
    totalUsd: number;
  }[] = [];
  for (const w of registered) {
    const [snap] = await db
      .select()
      .from(holdingsSnapshots)
      .where(and(eq(holdingsSnapshots.userId, userId), eq(holdingsSnapshots.wallet, w.address)))
      .orderBy(desc(holdingsSnapshots.takenAt))
      .limit(1);
    const positions = (snap?.positions as Position[] | undefined) ?? [];
    out.push({
      address: w.address,
      chain: w.chain,
      label: w.label,
      lastSyncedAt: w.lastSyncedAt?.toISOString() ?? null,
      positions,
      perps: (snap?.perps as PerpPosition[] | null | undefined) ?? [],
      totalUsd: positions.reduce((a, p) => a + (p.valueUsd ?? 0), 0),
    });
  }
  return out;
}
