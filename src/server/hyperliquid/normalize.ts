import type { PerpPosition, Position, Transfer } from "../portfolio/types";
import { HYPERLIQUID_CHAIN_ID, HYPERLIQUID_NETWORK } from "./constants";
import type {
  HlClearinghouseState,
  HlLedgerUpdate,
  HlSpotClearinghouseState,
} from "./info";

/**
 * PURE mappers from raw Hyperliquid info-API payloads to the portfolio
 * shapes. No network, no clock — unit-tested on captured fixtures.
 */

const num = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Perp account state → open positions plus one synthetic USDC Position for
 * the perps account value, so wallet totals and snapshot consumers work
 * without perp-awareness. Returns no margin position for an empty account.
 */
export function normalizePerpState(raw: HlClearinghouseState): {
  marginPosition: Position | null;
  perps: PerpPosition[];
  withdrawable: number;
} {
  const perps: PerpPosition[] = [];
  for (const ap of raw.assetPositions) {
    const p = ap.position;
    const szi = num(p.szi) ?? 0;
    if (szi === 0) continue;
    perps.push({
      venue: "hyperliquid",
      coin: p.coin,
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      notionalUsd: num(p.positionValue) ?? 0,
      entryPx: num(p.entryPx),
      liquidationPx: num(p.liquidationPx),
      leverage: p.leverage.value,
      marginMode: p.leverage.type,
      marginUsed: num(p.marginUsed) ?? 0,
      unrealizedPnl: num(p.unrealizedPnl) ?? 0,
    });
  }

  const accountValue = num(raw.marginSummary.accountValue) ?? 0;
  const marginPosition: Position | null =
    accountValue > 0
      ? {
          chainId: HYPERLIQUID_CHAIN_ID,
          network: HYPERLIQUID_NETWORK,
          tokenAddress: null,
          symbol: "USDC",
          name: "Hyperliquid perps margin",
          decimals: 6,
          balance: raw.marginSummary.accountValue,
          priceUsd: 1,
          valueUsd: accountValue,
          priceSource: "hyperliquid",
        }
      : null;

  return { marginPosition, perps, withdrawable: num(raw.withdrawable) ?? 0 };
}

/**
 * Spot balances → Positions. USDC is $1 by definition; other coins are
 * priced from allMids when the coin has a same-named perp market (HYPE, …).
 * Anything else stays unpriced — the UI and totals tolerate null prices.
 */
export function normalizeSpotBalances(
  raw: HlSpotClearinghouseState,
  mids: Record<string, string>,
): Position[] {
  const out: Position[] = [];
  for (const b of raw.balances) {
    const total = num(b.total) ?? 0;
    if (total <= 0) continue;
    const priceUsd = b.coin === "USDC" ? 1 : num(mids[b.coin]);
    out.push({
      chainId: HYPERLIQUID_CHAIN_ID,
      network: HYPERLIQUID_NETWORK,
      tokenAddress: null,
      symbol: b.coin,
      name: `${b.coin} (Hyperliquid spot)`,
      decimals: 8,
      balance: b.total,
      priceUsd,
      valueUsd: priceUsd !== null ? total * priceUsd : null,
      ...(priceUsd !== null ? { priceSource: "hyperliquid" as const } : {}),
    });
  }
  return out;
}

/** Ledger-update types we map to a transfer direction. */
const IN_TYPES = new Set(["deposit"]);
const OUT_TYPES = new Set(["withdraw"]);

/**
 * Non-funding ledger updates (deposits, withdrawals, transfers) → Transfer
 * rows. `uniqueId` composes hash+time+type because internal updates can share
 * a zero hash. Directions beyond deposit/withdraw depend on the counterparty:
 * transfers TO the address are "in", FROM it are "out", else "self".
 */
export function normalizeLedgerUpdates(raw: HlLedgerUpdate[], address: string): Transfer[] {
  const me = address.toLowerCase();
  return raw.map((u) => {
    const type = u.delta.type;
    const destination = typeof u.delta.destination === "string" ? u.delta.destination.toLowerCase() : null;
    const fromUser = typeof u.delta.user === "string" ? u.delta.user.toLowerCase() : null;
    const direction: Transfer["direction"] = IN_TYPES.has(type)
      ? "in"
      : OUT_TYPES.has(type)
        ? "out"
        : destination === me && fromUser !== null && fromUser !== me
          ? "in"
          : destination !== null && destination !== me
            ? "out"
            : "self";
    const amount = u.delta.usdc ?? u.delta.amount ?? null;
    const assetSymbol = u.delta.usdc !== undefined ? "USDC" : (u.delta.token ?? null);
    return {
      network: HYPERLIQUID_NETWORK,
      chainId: null,
      uniqueId: `${u.hash}:${u.time}:${type}`,
      txHash: u.hash,
      ts: u.time,
      direction,
      category: type,
      assetSymbol,
      assetAddress: null,
      amount,
      counterparty: direction === "in" ? fromUser : destination,
    };
  });
}
