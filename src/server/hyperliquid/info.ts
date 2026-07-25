import { env } from "../env";
import { TokenBucket } from "../market/rateLimiter";

/**
 * Keyless client for the Hyperliquid info API (POST /info). Public reads
 * only — account data is queried by address, no signature or key involved.
 * Reused by the portfolio adapter and (later) the perps trade flow.
 */

const BASE = env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz";

// ~1200 weighted req/min per IP; 5 req/s keeps us well under.
const bucket = new TokenBucket(5, 5);

export class HyperliquidError extends Error {}

async function info<T>(body: Record<string, unknown>): Promise<T> {
  await bucket.take();
  const res = await fetch(`${BASE}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HyperliquidError(
      `Hyperliquid info ${String(body.type)} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

// --- Raw response shapes (numbers arrive as strings) -----------------------

export type HlAssetPosition = {
  type: string; // "oneWay"
  position: {
    coin: string;
    szi: string; // signed size; negative = short
    entryPx: string | null;
    positionValue: string; // abs notional in USD
    unrealizedPnl: string;
    liquidationPx: string | null;
    marginUsed: string;
    maxLeverage: number;
    leverage: { type: "cross" | "isolated"; value: number };
    returnOnEquity: string;
  };
};

export type HlClearinghouseState = {
  assetPositions: HlAssetPosition[];
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  withdrawable: string;
  time: number;
};

export type HlSpotBalance = {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
};

export type HlSpotClearinghouseState = { balances: HlSpotBalance[] };

export type HlLedgerUpdate = {
  time: number; // ms epoch
  hash: string;
  delta: {
    type: string; // deposit | withdraw | internalTransfer | spotTransfer | accountClassTransfer | ...
    usdc?: string;
    token?: string;
    amount?: string;
    destination?: string;
    user?: string;
  } & Record<string, unknown>;
};

export type HlPerpMeta = {
  universe: { name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }[];
};

// --- Queries ----------------------------------------------------------------

/** Perp positions + margin summary for an address. */
export function clearinghouseState(address: string): Promise<HlClearinghouseState> {
  return info({ type: "clearinghouseState", user: address });
}

/** Spot balances for an address. */
export function spotClearinghouseState(address: string): Promise<HlSpotClearinghouseState> {
  return info({ type: "spotClearinghouseState", user: address });
}

/** Current mid price per coin (perp coin names; spot pairs appear as "@<index>"). */
export function allMids(): Promise<Record<string, string>> {
  return info({ type: "allMids" });
}

/** Perps universe metadata (coin names, size decimals, max leverage). */
export function perpMeta(): Promise<HlPerpMeta> {
  return info({ type: "meta" });
}

export type HlAssetCtx = {
  markPx: string;
  midPx?: string | null;
  funding: string;
  openInterest: string;
  oraclePx: string;
} & Record<string, unknown>;

/** Universe metadata zipped with live per-asset context (mark px, funding, OI). */
export function metaAndAssetCtxs(): Promise<[HlPerpMeta, HlAssetCtx[]]> {
  return info({ type: "metaAndAssetCtxs" });
}

export type HlExtraAgent = { address: string; name: string; validUntil: number };

/** Agent wallets the address has approved (trade-only keys). */
export function extraAgents(address: string): Promise<HlExtraAgent[]> {
  return info({ type: "extraAgents", user: address });
}

export type HlFundingEntry = {
  coin: string;
  fundingRate: string; // hourly rate fraction, positive = longs pay
  premium: string;
  time: number; // ms epoch
};

/**
 * Hourly funding history for a perp coin in [startMs, endMs], ascending.
 * Paged by time until a page comes back empty (per-request cap is ~500).
 */
export async function fundingHistory(
  coin: string,
  startMs: number,
  endMs: number,
): Promise<HlFundingEntry[]> {
  const out: HlFundingEntry[] = [];
  let start = startMs;
  for (let page = 0; page < 200; page++) {
    const batch = await info<HlFundingEntry[]>({
      type: "fundingHistory",
      coin,
      startTime: start,
      endTime: endMs,
    });
    if (batch.length === 0) break;
    out.push(...batch);
    const next = batch[batch.length - 1].time + 1;
    if (next <= start || next > endMs) break;
    start = next;
  }
  return out;
}

export type HlOrderStatus =
  | { status: "order"; order: { order: Record<string, unknown>; status: string; statusTimestamp: number } }
  | { status: "unknownOid" };

/** Status of one order by numeric oid. */
export function orderStatus(address: string, oid: number): Promise<HlOrderStatus> {
  return info({ type: "orderStatus", user: address, oid });
}

/**
 * Relay a client-signed action to the exchange endpoint. The server NEVER
 * signs — it forwards {action, signature, nonce} exactly as the browser
 * produced them (the signature makes the payload tamper-proof) after
 * verifying the action against the server-minted quote.
 */
export async function relayExchangeAction(payload: {
  action: Record<string, unknown>;
  signature: { r: string; s: string; v: number };
  nonce: number;
}): Promise<Record<string, unknown>> {
  await bucket.take();
  const res = await fetch(`${BASE}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || body === null) {
    throw new HyperliquidError(
      `Hyperliquid exchange ${res.status}: ${JSON.stringify(body)?.slice(0, 300) ?? "no body"}`,
    );
  }
  return body;
}

/** True when HYPERLIQUID_API_URL points at the testnet (affects signing domains). */
export function hyperliquidIsTestnet(): boolean {
  return BASE.includes("testnet");
}

/**
 * Deposits/withdrawals/transfers (everything except funding) since startTime,
 * ascending. Paged by time: the per-request cap is undocumented in practice
 * (docs say 500, mainnet returns 2000), so keep fetching until a page comes
 * back empty. MAX_PAGES bounds pathological accounts (vaults with millions of
 * ledger rows) — hitting it truncates the tail until the next sync.
 */
const MAX_LEDGER_PAGES = 40;

export async function userNonFundingLedgerUpdates(
  address: string,
  startTimeMs: number,
): Promise<HlLedgerUpdate[]> {
  const out: HlLedgerUpdate[] = [];
  let start = startTimeMs;
  for (let page = 0; page < MAX_LEDGER_PAGES; page++) {
    const batch = await info<HlLedgerUpdate[]>({
      type: "userNonFundingLedgerUpdates",
      user: address,
      startTime: start,
    });
    if (batch.length === 0) break;
    out.push(...batch);
    const next = batch[batch.length - 1].time + 1;
    if (next <= start) break; // safety: no forward progress
    start = next;
  }
  return out;
}
