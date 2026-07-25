import { and, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/server/db";
import { executions, tradeProposals, walletTransfers } from "@/server/db/schema";
import { getTagsForItems, txKeysWithTag } from "./tags";
import type { HistoryItem } from "./types";

/**
 * Merged wallet history: cached on-chain transfers + this platform's own
 * trade executions. A platform trade also lands on-chain, so the same tx
 * can appear in both sources — mergeHistory dedupes by txHash preferring the
 * execution row (it carries status + trade semantics).
 *
 * Filters apply server-side (pagination lives here; client-side filtering
 * would silently miss matches beyond the loaded page).
 */

export type HistoryFilters = {
  limit?: number;
  before?: number;
  /** Case-insensitive exact tag. */
  tag?: string;
  /** Asset symbol, case-insensitive substring. */
  asset?: string;
  direction?: "in" | "out" | "self";
  type?: "transfer" | "trade";
};

/** Pure merge: trades win txHash collisions; newest first; sliced to limit. */
export function mergeHistory(
  transfers: HistoryItem[],
  trades: HistoryItem[],
  limit: number,
): HistoryItem[] {
  const tradeHashes = new Set(trades.map((t) => t.txHash).filter(Boolean) as string[]);
  return [...trades, ...transfers.filter((t) => !t.txHash || !tradeHashes.has(t.txHash))]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

type ProposalJson = {
  tokenIn?: { symbol?: string };
  tokenOut?: { symbol?: string };
  amountIn?: string;
};

export async function getWalletHistory(
  userId: string,
  wallet: string,
  { limit = 50, before, tag, asset, direction, type }: HistoryFilters = {},
): Promise<HistoryItem[]> {
  const normalized = wallet.toLowerCase();

  // A tag filter becomes a txKey allowlist up front.
  let tagHashes: string[] | null = null;
  let tagExecIds: number[] | null = null;
  if (tag !== undefined) {
    const keys = await txKeysWithTag(userId, normalized, tag);
    tagHashes = keys.filter((k) => !k.startsWith("exec:"));
    tagExecIds = keys
      .filter((k) => k.startsWith("exec:"))
      .map((k) => Number(k.slice(5)))
      .filter(Number.isInteger);
  }

  let transfers: HistoryItem[] = [];
  if (type !== "trade" && (tagHashes === null || tagHashes.length > 0)) {
    const conds: SQL[] = [
      eq(walletTransfers.userId, userId),
      eq(walletTransfers.wallet, normalized),
    ];
    if (before) conds.push(lt(walletTransfers.ts, new Date(before)));
    if (tagHashes !== null) conds.push(inArray(walletTransfers.txHash, tagHashes));
    if (asset) conds.push(ilike(walletTransfers.assetSymbol, `%${asset}%`));
    if (direction) conds.push(eq(walletTransfers.direction, direction));
    // Over-fetch slightly so trade-row dedupe can't shrink a full page.
    const transferRows = await db
      .select()
      .from(walletTransfers)
      .where(and(...conds))
      .orderBy(desc(walletTransfers.ts))
      .limit(limit + 20);
    transfers = transferRows.map((r) => ({
      ts: r.ts.getTime(),
      type: "transfer",
      direction: r.direction as HistoryItem["direction"],
      assetSymbol: r.assetSymbol,
      amount: r.amount,
      counterparty: r.counterparty,
      chainId: r.chainId,
      network: r.network,
      txHash: r.txHash,
      status: null,
      category: r.category,
      txKey: r.txHash,
      tags: [],
    }));
  }

  let trades: HistoryItem[] = [];
  // Trades are always "out" swaps; an in/self direction filter excludes them.
  if (type !== "transfer" && (direction === undefined || direction === "out")) {
    const conds: SQL[] = [eq(executions.userId, userId), eq(executions.userWallet, normalized)];
    if (before) conds.push(lt(executions.createdAt, new Date(before)));
    if (tagHashes !== null || tagExecIds !== null) {
      const keyConds: SQL[] = [];
      if (tagHashes && tagHashes.length > 0) keyConds.push(inArray(executions.txHash, tagHashes));
      if (tagExecIds && tagExecIds.length > 0) keyConds.push(inArray(executions.id, tagExecIds));
      if (keyConds.length === 0) conds.push(sql`false`);
      else conds.push(or(...keyConds)!);
    }
    const execRows = await db
      .select({ execution: executions, proposal: tradeProposals.proposal })
      .from(executions)
      .leftJoin(tradeProposals, eq(executions.proposalId, tradeProposals.id))
      .where(and(...conds))
      .orderBy(desc(executions.createdAt))
      .limit(limit);
    trades = execRows.map(({ execution: e, proposal }) => {
      const p = (proposal ?? {}) as ProposalJson;
      const pair =
        p.tokenIn?.symbol && p.tokenOut?.symbol ? `${p.tokenIn.symbol}→${p.tokenOut.symbol}` : null;
      return {
        ts: e.createdAt.getTime(),
        type: "trade" as const,
        direction: "out" as const,
        assetSymbol: pair ?? p.tokenIn?.symbol ?? null,
        amount: p.amountIn ?? null,
        counterparty: null,
        chainId: e.chainId,
        network: null,
        txHash: e.txHash,
        status: e.status,
        category: "swap",
        txKey: e.txHash ?? `exec:${e.id}`,
        tags: [],
      };
    });
    // The asset filter matches the swap pair label for trades.
    if (asset) {
      const needle = asset.toLowerCase();
      trades = trades.filter((t) => t.assetSymbol?.toLowerCase().includes(needle));
    }
  }

  const merged = mergeHistory(transfers, trades, limit);
  const tagsByKey = await getTagsForItems(
    userId,
    normalized,
    merged.map((i) => i.txKey),
  );
  for (const item of merged) item.tags = tagsByKey.get(item.txKey) ?? [];
  return merged;
}
