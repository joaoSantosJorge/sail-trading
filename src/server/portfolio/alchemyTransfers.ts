import { env } from "../env";
import { CHAIN_IDS, NETWORKS, AlchemyError, type AlchemyNetwork } from "./alchemy";
import type { Transfer } from "./types";

/**
 * On-chain transfer history via `alchemy_getAssetTransfers` (JSON-RPC per
 * network). One wallet's history = two paginated queries per network
 * (fromAddress / toAddress). Backfill is capped (MAX_PAGES × 1000 per
 * direction) so a whale wallet can't blow the sync route's time budget —
 * the caller persists a block watermark and later syncs are incremental.
 * Docs: https://www.alchemy.com/docs/reference/alchemy-getassettransfers
 */

export const TRANSFER_NETWORKS = NETWORKS;

const MAX_PAGES_PER_DIRECTION = 3;
const PAGE_SIZE_HEX = "0x3e8"; // 1000

// `internal` (trace-derived) transfers are only supported on a subset of
// networks; requesting them elsewhere is a 400.
const CATEGORIES: Record<AlchemyNetwork, string[]> = {
  "eth-mainnet": ["external", "internal", "erc20"],
  "polygon-mainnet": ["external", "internal", "erc20"],
  "base-mainnet": ["external", "erc20"],
  "arb-mainnet": ["external", "erc20"],
  "opt-mainnet": ["external", "erc20"],
};

export type RawAssetTransfer = {
  uniqueId: string;
  hash: string;
  blockNum: string; // hex
  from: string;
  to: string | null;
  value: number | null; // already decimal-adjusted by Alchemy
  asset: string | null; // symbol
  category: string;
  rawContract?: { address?: string | null };
  metadata?: { blockTimestamp?: string };
};

/** Pure: raw Alchemy transfer → normalized Transfer. */
export function normalizeTransfer(
  raw: RawAssetTransfer,
  owner: string,
  network: string,
  chainId: number,
): Transfer {
  const o = owner.toLowerCase();
  const from = raw.from?.toLowerCase() ?? "";
  const to = raw.to?.toLowerCase() ?? null;
  const direction: Transfer["direction"] =
    from === o && to === o ? "self" : from === o ? "out" : "in";
  return {
    network,
    chainId,
    uniqueId: raw.uniqueId,
    txHash: raw.hash,
    ts: raw.metadata?.blockTimestamp ? Date.parse(raw.metadata.blockTimestamp) : 0,
    direction,
    category: raw.category,
    assetSymbol: raw.asset || null,
    assetAddress: raw.rawContract?.address ?? null,
    amount: raw.value === null || raw.value === undefined ? null : String(raw.value),
    counterparty: direction === "out" ? to : from || null,
  };
}

/**
 * Pure spam heuristic for erc20 transfers (mirrors the balances filter in
 * alchemy.ts): zero/absent value or a junk/absent symbol. Transfers have no
 * price data, so symbol shape is all we have — raw rows are kept in the DB
 * for later refinement.
 */
export function isSpamTransfer(t: Pick<Transfer, "category" | "amount" | "assetSymbol">): boolean {
  if (t.category !== "erc20") return false;
  if (t.amount === null || Number(t.amount) === 0) return true;
  if (!t.assetSymbol || t.assetSymbol.length > 12) return true;
  return false;
}

type RpcResult = { transfers?: RawAssetTransfer[]; pageKey?: string };

async function rpcCall(
  network: AlchemyNetwork,
  params: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<RpcResult> {
  const res = await fetchFn(`https://${network}.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [params],
    }),
  });
  if (!res.ok) {
    throw new AlchemyError(`Alchemy ${network} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { result?: RpcResult; error?: { message?: string } };
  if (body.error) {
    throw new AlchemyError(`Alchemy ${network}: ${body.error.message ?? "rpc error"}`);
  }
  return body.result ?? {};
}

/**
 * Fetch one wallet's transfers on one network since `fromBlock` (hex,
 * exclusive of already-seen blocks when the caller passes watermark+1).
 * Returns normalized, spam-filtered transfers plus the highest block seen
 * (hex) for the caller's watermark.
 */
export type TransferWithRaw = Transfer & { raw: unknown };

export async function fetchTransfers(
  network: AlchemyNetwork,
  address: string,
  opts: { fromBlock?: string; fetchFn?: typeof fetch } = {},
): Promise<{ transfers: TransferWithRaw[]; latestBlock: string | null }> {
  if (!env.ALCHEMY_API_KEY) {
    throw new AlchemyError("ALCHEMY_API_KEY is not set — add it to .env.local");
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const fromBlock = opts.fromBlock ?? "0x0";
  const chainId = CHAIN_IDS[network];

  const base = {
    fromBlock,
    toBlock: "latest",
    category: CATEGORIES[network],
    withMetadata: true,
    maxCount: PAGE_SIZE_HEX,
    order: "desc",
    excludeZeroValue: true,
  };

  const raws: RawAssetTransfer[] = [];
  for (const direction of [{ fromAddress: address }, { toAddress: address }]) {
    let pageKey: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_DIRECTION; page++) {
      const result = await rpcCall(
        network,
        { ...base, ...direction, ...(pageKey ? { pageKey } : {}) },
        fetchFn,
      );
      raws.push(...(result.transfers ?? []));
      pageKey = result.pageKey;
      if (!pageKey) break;
    }
  }

  let latestBlock: bigint | null = null;
  const transfers: TransferWithRaw[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (seen.has(raw.uniqueId)) continue; // self-transfers appear in both directions
    seen.add(raw.uniqueId);
    const block = BigInt(raw.blockNum);
    if (latestBlock === null || block > latestBlock) latestBlock = block;
    const t = normalizeTransfer(raw, address, network, chainId);
    if (isSpamTransfer(t)) continue;
    transfers.push({ ...t, raw });
  }

  return {
    transfers,
    latestBlock: latestBlock === null ? null : `0x${latestBlock.toString(16)}`,
  };
}
