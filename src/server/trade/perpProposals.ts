import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { researchReports, tradeProposals } from "@/server/db/schema";
import {
  perpProposalInputSchema,
  type PerpProposalInput,
  type ProposedAction,
} from "@/lib/ai/action-schemas";
import { formatPx, formatSz, roundedSz } from "@/lib/hyperliquid/format";
import { metaAndAssetCtxs } from "@/server/hyperliquid/info";
import { latestSnapshots } from "@/server/portfolio/service";
import { ProposalError } from "./proposals";

/**
 * Perp order proposals — the Hyperliquid sibling of clampProposal. Same
 * invariants: clampPerpProposal is PURE (all venue/account data passed in),
 * unit-tested, and NEVER bypassed; nothing here signs or sends anything.
 * Execution happens only on the trade page where the user's browser-held
 * agent key signs the order.
 */

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Limit prices may deviate at most this much from the mark (fat-finger guard). */
export const MAX_PX_BAND_PCT = 20;
/** Stop/take-profit triggers may deviate at most this much from the entry price. */
export const MAX_TRIGGER_BAND_PCT = 80;

function maxProposalUsd(): number {
  return Number(process.env.MAX_PROPOSAL_USD) || 1000;
}
function maxProposalPct(): number {
  return Number(process.env.MAX_PROPOSAL_PCT) || 25;
}
function maxPerpLeverage(): number {
  return Number(process.env.MAX_PERP_LEVERAGE) || 5;
}

/** Per-address perp account facts, derived from the latest snapshot. */
export type PerpAccountLike = {
  address: string;
  /** Perps account value in USD (margin + uPnL). */
  accountValue: number;
  /** Margin already committed to open positions, USD. */
  totalMarginUsed: number;
  positions: { coin: string; side: "long" | "short"; size: number }[];
};

/** One tradeable perp market: venue metadata + a reference price. */
export type PerpMarketLike = {
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
};

export type PerpCaps = { maxUsd: number; maxPct: number; maxLeverage: number };

export type ValidatedPerpProposal = {
  kind: "perp";
  venue: "hyperliquid";
  walletAddress: string;
  coin: string;
  side: "long" | "short";
  /** Size rounded to the venue's szDecimals — the wire string and its value. */
  size: string;
  szDecimals: number;
  leverage: number;
  orderType: "market" | "limit";
  /** Rounded wire price for limit orders; null for market (priced at quote time). */
  limitPx: string | null;
  tif: "Gtc" | "Ioc";
  reduceOnly: boolean;
  /** Rounded wire price of the stop-loss trigger; null when not set. */
  stopLossPx: string | null;
  /** Rounded wire price of the take-profit trigger; null when not set. */
  takeProfitPx: string | null;
  /** Notional at the validation-time mark price. */
  notionalUsd: number;
  markPxAtProposal: number;
  maxSlippageBps: number;
  rationale: string;
  risks: string[];
  confidence: "low" | "medium" | "high";
  invalidation: string;
  reportId: number | null;
  source: "ai" | "manual";
};

/**
 * Pure clamp logic for perp orders. Throws ProposalError with a
 * model-repairable message on any violation.
 */
export function clampPerpProposal(
  raw: unknown,
  accounts: PerpAccountLike[],
  markets: PerpMarketLike[],
  caps: PerpCaps,
): ValidatedPerpProposal {
  const parsed = perpProposalInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProposalError(
      `invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const input: PerpProposalInput = parsed.data;

  const wallet = input.walletAddress.toLowerCase();
  const account = accounts.find((a) => a.address === wallet);
  if (!account) {
    throw new ProposalError(
      `wallet ${input.walletAddress} is not a registered Hyperliquid wallet with a synced snapshot — available: ${accounts.map((a) => a.address).join(", ") || "none (register one on the Portfolio page and sync it)"}`,
    );
  }

  const market = markets.find((m) => m.coin.toLowerCase() === input.coin.toLowerCase());
  if (!market) {
    throw new ProposalError(
      `coin ${input.coin} is not a Hyperliquid perp market — check the exact coin name (e.g. BTC, ETH, SOL, HYPE)`,
    );
  }

  const leverageCap = Math.min(market.maxLeverage, caps.maxLeverage);
  if (input.leverage > leverageCap) {
    throw new ProposalError(
      `leverage ${input.leverage}x exceeds the cap of ${leverageCap}x (venue max ${market.maxLeverage}x, MAX_PERP_LEVERAGE=${caps.maxLeverage})`,
    );
  }

  const size = roundedSz(Number(input.size), market.szDecimals);
  if (size <= 0) {
    throw new ProposalError(
      `size ${input.size} rounds to zero at ${market.szDecimals} size decimals for ${market.coin}`,
    );
  }

  // Limit price: required for limit orders, inside the fat-finger band.
  let limitPx: string | null = null;
  if (input.orderType === "limit") {
    if (input.limitPx === undefined) {
      throw new ProposalError("limitPx is required for limit orders");
    }
    const deviationPct = (Math.abs(input.limitPx - market.markPx) / market.markPx) * 100;
    if (deviationPct > MAX_PX_BAND_PCT) {
      throw new ProposalError(
        `limitPx ${input.limitPx} is ${deviationPct.toFixed(1)}% away from the mark price ${market.markPx} (max ${MAX_PX_BAND_PCT}%)`,
      );
    }
    limitPx = formatPx(input.limitPx, market.szDecimals);
  }

  const px = limitPx !== null ? Number(limitPx) : market.markPx;
  const notionalUsd = size * px;

  // Stop-loss / take-profit triggers: reduce-only exits placed atomically with
  // the entry. Validated against the reference (entry) price on the ROUNDED
  // wire values, strict inequalities — a trigger that rounds onto the entry
  // price is rejected.
  if (input.reduceOnly && (input.stopLossPx !== undefined || input.takeProfitPx !== undefined)) {
    throw new ProposalError(
      "stopLossPx/takeProfitPx cannot be combined with reduceOnly — they are exit orders themselves",
    );
  }
  const clampTrigger = (label: "stopLossPx" | "takeProfitPx", value: number): string => {
    const deviationPct = (Math.abs(value - px) / px) * 100;
    if (deviationPct > MAX_TRIGGER_BAND_PCT) {
      throw new ProposalError(
        `${label} ${value} is ${deviationPct.toFixed(1)}% away from the entry price ${px} (max ${MAX_TRIGGER_BAND_PCT}%)`,
      );
    }
    return formatPx(value, market.szDecimals);
  };
  const entryLabel = input.orderType === "limit" ? "limit" : "mark";
  let stopLossPx: string | null = null;
  if (input.stopLossPx !== undefined) {
    stopLossPx = clampTrigger("stopLossPx", input.stopLossPx);
    const sl = Number(stopLossPx);
    if (input.side === "long" ? sl >= px : sl <= px) {
      throw new ProposalError(
        `stopLossPx ${stopLossPx} must be ${input.side === "long" ? "below" : "above"} the ${entryLabel} price ${px} for a ${input.side}`,
      );
    }
  }
  let takeProfitPx: string | null = null;
  if (input.takeProfitPx !== undefined) {
    takeProfitPx = clampTrigger("takeProfitPx", input.takeProfitPx);
    const tp = Number(takeProfitPx);
    if (input.side === "long" ? tp <= px : tp >= px) {
      throw new ProposalError(
        `takeProfitPx ${takeProfitPx} must be ${input.side === "long" ? "above" : "below"} the ${entryLabel} price ${px} for a ${input.side}`,
      );
    }
  }

  if (input.reduceOnly) {
    // Closing exposure is risk-reducing: exempt from the notional caps, but
    // it must actually reduce an open opposite-side position.
    const opposite = account.positions.find(
      (p) => p.coin.toLowerCase() === market.coin.toLowerCase() && p.side !== input.side,
    );
    if (!opposite) {
      throw new ProposalError(
        `reduceOnly ${input.side} ${market.coin} needs an open ${input.side === "long" ? "short" : "long"} position, and the snapshot has none — sync the wallet if positions changed`,
      );
    }
    if (size > opposite.size) {
      throw new ProposalError(
        `reduceOnly size ${size} exceeds the open ${opposite.side} position of ${opposite.size} ${market.coin}`,
      );
    }
  } else {
    // Notional caps: hard USD cap + share-of-account cap (same envs as swaps).
    const pctCap = (caps.maxPct / 100) * account.accountValue;
    const effectiveCap = Math.min(caps.maxUsd, pctCap > 0 ? pctCap : caps.maxUsd);
    if (notionalUsd > effectiveCap) {
      throw new ProposalError(
        `notional ~${notionalUsd.toFixed(2)} USD exceeds the cap of ${effectiveCap.toFixed(2)} USD (MAX_PROPOSAL_USD=${caps.maxUsd}, MAX_PROPOSAL_PCT=${caps.maxPct}% of account value ${account.accountValue.toFixed(2)})`,
      );
    }
    if (input.sizeUsd > notionalUsd * 1.5 || input.sizeUsd < notionalUsd / 1.5) {
      throw new ProposalError(
        `sizeUsd ${input.sizeUsd.toFixed(2)} does not match the computed notional ~${notionalUsd.toFixed(2)} USD (size × price) — fix size or sizeUsd`,
      );
    }
    // New exposure must fit the account's free margin (conservative estimate
    // from the snapshot; the venue re-checks with live balances at execution).
    const available = account.accountValue - account.totalMarginUsed;
    const requiredMargin = notionalUsd / input.leverage;
    if (requiredMargin > available) {
      throw new ProposalError(
        `required margin ~${requiredMargin.toFixed(2)} USD (notional / ${input.leverage}x) exceeds the free account margin ~${available.toFixed(2)} USD`,
      );
    }
  }

  return {
    kind: "perp",
    venue: "hyperliquid",
    walletAddress: wallet,
    coin: market.coin,
    side: input.side,
    size: formatSz(size, market.szDecimals),
    szDecimals: market.szDecimals,
    leverage: input.leverage,
    orderType: input.orderType,
    limitPx,
    tif: input.orderType === "market" ? "Ioc" : input.tif,
    reduceOnly: input.reduceOnly,
    stopLossPx,
    takeProfitPx,
    notionalUsd,
    markPxAtProposal: market.markPx,
    maxSlippageBps: Math.min(input.maxSlippageBps, 100),
    rationale: input.rationale,
    risks: input.risks,
    confidence: input.confidence,
    invalidation: input.invalidation,
    reportId: input.reportId ?? null,
    source: input.source,
  };
}

/** Build PerpAccountLike facts from the user's latest snapshots (Task 2 shape). */
export function accountsFromSnapshots(
  snapshots: {
    address: string;
    chain: string;
    positions: { network: string; symbol: string; valueUsd: number | null }[];
    perps: { coin: string; side: "long" | "short"; size: number; marginUsed: number }[];
  }[],
): PerpAccountLike[] {
  return snapshots
    .filter((s) => s.chain === "hyperliquid")
    .map((s) => ({
      address: s.address,
      // The synthetic USDC margin position carries the perps account value.
      accountValue:
        s.positions.find((p) => p.network === "hyperliquid" && p.symbol === "USDC")?.valueUsd ?? 0,
      totalMarginUsed: s.perps.reduce((a, p) => a + p.marginUsed, 0),
      positions: s.perps.map((p) => ({ coin: p.coin, side: p.side, size: p.size })),
    }));
}

/** Live perp markets (meta + mark prices) for the clamp. */
export async function fetchPerpMarkets(): Promise<PerpMarketLike[]> {
  const [meta, ctxs] = await metaAndAssetCtxs();
  return meta.universe.map((u, i) => ({
    coin: u.name,
    szDecimals: u.szDecimals,
    maxLeverage: u.maxLeverage,
    markPx: Number(ctxs[i]?.markPx ?? 0),
  }));
}

/** DB-backed wrapper: clamps against latest snapshots + live meta + env caps. */
export async function validatePerpProposal(
  userId: string,
  raw: unknown,
): Promise<ValidatedPerpProposal> {
  const snapshots = await latestSnapshots(userId);
  const markets = await fetchPerpMarkets();
  const validated = clampPerpProposal(raw, accountsFromSnapshots(snapshots), markets, {
    maxUsd: maxProposalUsd(),
    maxPct: maxProposalPct(),
    maxLeverage: maxPerpLeverage(),
  });
  if (validated.reportId !== null) {
    const [report] = await db
      .select({ id: researchReports.id })
      .from(researchReports)
      .where(and(eq(researchReports.id, validated.reportId), eq(researchReports.userId, userId)));
    if (!report) {
      throw new ProposalError(
        `reportId ${validated.reportId} does not match one of your saved research reports — use the reportId returned by save_research_report, or omit it`,
      );
    }
  }
  return validated;
}

export async function createPerpProposal(
  userId: string,
  validated: ValidatedPerpProposal,
): Promise<ProposedAction> {
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
  const [row] = await db
    .insert(tradeProposals)
    .values({
      userId,
      reportId: validated.reportId,
      walletAddress: validated.walletAddress,
      kind: "perp",
      proposal: validated,
      status: "proposed",
      expiresAt,
    })
    .returning({ id: tradeProposals.id });

  return {
    proposalId: row.id,
    targetPath: `/trade/${row.id}`,
    summary: [
      {
        label: "Order",
        value: `${validated.side.toUpperCase()} ${validated.size} ${validated.coin}-PERP ${validated.leverage}x`,
      },
      { label: "Venue", value: "Hyperliquid" },
      {
        label: "Type",
        value:
          validated.orderType === "market" ? "market (IOC)" : `limit @ ${validated.limitPx} ${validated.tif}`,
      },
      { label: "Notional", value: `$${validated.notionalUsd.toFixed(2)}` },
      ...(validated.stopLossPx !== null
        ? [{ label: "Stop loss", value: validated.stopLossPx }]
        : []),
      ...(validated.takeProfitPx !== null
        ? [{ label: "Take profit", value: validated.takeProfitPx }]
        : []),
      { label: "Confidence", value: validated.confidence },
    ],
    expiresAt: expiresAt.toISOString(),
  };
}
