import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { researchReports, tradeProposals } from "@/server/db/schema";
import {
  tradeProposalInputSchema,
  type ProposedAction,
  type TradeProposalInput,
} from "@/lib/ai/action-schemas";
import { latestSnapshots } from "@/server/portfolio/service";
import {
  CHAIN_NAMES,
  findKnownToken,
  KNOWN_TOKENS,
  SUPPORTED_CHAIN_IDS,
  type KnownToken,
} from "@/server/uniswap/routers";

/**
 * Trade proposals: validated + clamped server-side, persisted as first-class
 * documents, expiring after 24h. NOTHING here moves funds — execution happens
 * only through the trade page where the user's wallet signature is the sole
 * authorization.
 */

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export class ProposalError extends Error {}

function maxProposalUsd(): number {
  return Number(process.env.MAX_PROPOSAL_USD) || 1000;
}
function maxProposalPct(): number {
  return Number(process.env.MAX_PROPOSAL_PCT) || 25;
}

export type ValidatedProposal = {
  chainId: number;
  chainName: string;
  walletAddress: string;
  tokenIn: KnownToken & { balance: string };
  tokenOut: KnownToken;
  amountIn: string;
  sizeUsd: number;
  maxSlippageBps: number;
  rationale: string;
  risks: string[];
  confidence: "low" | "medium" | "high";
  invalidation: string;
  reportId: number | null;
  source: "ai" | "manual";
};

export type SnapshotLike = {
  address: string;
  totalUsd: number;
  positions: {
    chainId: number;
    symbol: string;
    tokenAddress: string | null;
    decimals: number;
    balance: string;
    priceUsd: number | null;
  }[];
};

export type ProposalCaps = { maxUsd: number; maxPct: number };

/**
 * Pure clamp logic — validated against provided snapshots and caps, no DB.
 * Throws ProposalError with a model-repairable message on any violation.
 */
export function clampProposal(
  raw: unknown,
  snapshots: SnapshotLike[],
  caps: ProposalCaps,
): ValidatedProposal {
  const parsed = tradeProposalInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProposalError(
      `invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const input: TradeProposalInput = parsed.data;

  if (!SUPPORTED_CHAIN_IDS.includes(input.chainId)) {
    throw new ProposalError(
      `chainId ${input.chainId} is not supported (supported: ${SUPPORTED_CHAIN_IDS.join(", ")})`,
    );
  }

  const wallet = input.walletAddress.toLowerCase();
  const snapshot = snapshots.find((s) => s.address === wallet);
  if (!snapshot) {
    throw new ProposalError(
      `wallet ${input.walletAddress} is not registered for this user — available: ${snapshots.map((s) => s.address).join(", ") || "none"}`,
    );
  }

  // tokenIn must be held in the snapshot on the right chain.
  const needle = input.tokenIn.toLowerCase();
  const held = snapshot.positions.find(
    (p) =>
      p.chainId === input.chainId &&
      (p.symbol.toLowerCase() === needle || (p.tokenAddress ?? "eth") === needle),
  );
  if (!held) {
    throw new ProposalError(
      `tokenIn ${input.tokenIn} is not held in wallet ${wallet} on ${CHAIN_NAMES[input.chainId]} (per the latest snapshot — sync the wallet if holdings changed)`,
    );
  }
  if (Number(input.amountIn) > Number(held.balance)) {
    throw new ProposalError(
      `amountIn ${input.amountIn} exceeds the snapshot balance of ${held.balance} ${held.symbol}`,
    );
  }

  // tokenOut must be a known token on that chain.
  const tokenOut = findKnownToken(input.chainId, input.tokenOut);
  if (!tokenOut) {
    throw new ProposalError(
      `tokenOut ${input.tokenOut} is not a known token on ${CHAIN_NAMES[input.chainId]} — known: ${KNOWN_TOKENS[
        input.chainId
      ]
        .map((t) => t.symbol)
        .join(", ")}`,
    );
  }
  if (
    tokenOut.symbol.toLowerCase() === held.symbol.toLowerCase() &&
    (tokenOut.address ?? null) === (held.tokenAddress ?? null)
  ) {
    throw new ProposalError("tokenIn and tokenOut are the same token");
  }

  // USD size caps: hard cap + share-of-portfolio cap.
  const capUsd = caps.maxUsd;
  const portfolioUsd = snapshot.totalUsd;
  const pctCap = (caps.maxPct / 100) * portfolioUsd;
  const effectiveCap = Math.min(capUsd, pctCap > 0 ? pctCap : capUsd);
  if (input.sizeUsd > effectiveCap) {
    throw new ProposalError(
      `sizeUsd ${input.sizeUsd.toFixed(2)} exceeds the cap of ${effectiveCap.toFixed(2)} USD (MAX_PROPOSAL_USD=${capUsd}, MAX_PROPOSAL_PCT=${caps.maxPct}% of ${portfolioUsd.toFixed(2)})`,
    );
  }
  // Cross-check the claimed USD size against snapshot pricing when available.
  if (held.priceUsd !== null) {
    const impliedUsd = Number(input.amountIn) * held.priceUsd;
    if (impliedUsd > effectiveCap * 1.05) {
      throw new ProposalError(
        `amountIn is worth ~${impliedUsd.toFixed(2)} USD at the snapshot price, exceeding the ${effectiveCap.toFixed(2)} USD cap`,
      );
    }
  }

  return {
    chainId: input.chainId,
    chainName: CHAIN_NAMES[input.chainId],
    walletAddress: wallet,
    tokenIn: {
      symbol: held.symbol,
      name: held.symbol,
      address: held.tokenAddress,
      decimals: held.decimals,
      balance: held.balance,
    },
    tokenOut,
    amountIn: input.amountIn,
    sizeUsd: input.sizeUsd,
    maxSlippageBps: Math.min(input.maxSlippageBps, 100),
    rationale: input.rationale,
    risks: input.risks,
    confidence: input.confidence,
    invalidation: input.invalidation,
    reportId: input.reportId ?? null,
    source: input.source,
  };
}

/** DB-backed wrapper: clamps against the user's latest snapshots + env caps. */
export async function validateProposal(
  userId: string,
  raw: unknown,
): Promise<ValidatedProposal> {
  const snapshots = await latestSnapshots(userId);
  const validated = clampProposal(raw, snapshots, {
    maxUsd: maxProposalUsd(),
    maxPct: maxProposalPct(),
  });
  if (validated.reportId !== null) {
    const [report] = await db
      .select({ id: researchReports.id })
      .from(researchReports)
      .where(
        and(eq(researchReports.id, validated.reportId), eq(researchReports.userId, userId)),
      );
    if (!report) {
      throw new ProposalError(
        `reportId ${validated.reportId} does not match one of your saved research reports — use the reportId returned by save_research_report, or omit it`,
      );
    }
  }
  return validated;
}

export async function createProposal(
  userId: string,
  validated: ValidatedProposal,
): Promise<ProposedAction> {
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
  const [row] = await db
    .insert(tradeProposals)
    .values({
      userId,
      reportId: validated.reportId,
      walletAddress: validated.walletAddress,
      proposal: validated,
      status: "proposed",
      expiresAt,
    })
    .returning({ id: tradeProposals.id });

  return {
    proposalId: row.id,
    targetPath: `/trade/${row.id}`,
    summary: [
      { label: "Trade", value: `${validated.amountIn} ${validated.tokenIn.symbol} → ${validated.tokenOut.symbol}` },
      { label: "Chain", value: validated.chainName },
      { label: "Size", value: `$${validated.sizeUsd.toFixed(2)}` },
      { label: "Max slippage", value: `${validated.maxSlippageBps} bps` },
      { label: "Confidence", value: validated.confidence },
    ],
    expiresAt: expiresAt.toISOString(),
  };
}

export type ProposalRow = typeof tradeProposals.$inferSelect;

/** Load a proposal, transitioning to expired when past its TTL. */
export async function getProposal(userId: string, id: number): Promise<ProposalRow | null> {
  const [row] = await db
    .select()
    .from(tradeProposals)
    .where(and(eq(tradeProposals.id, id), eq(tradeProposals.userId, userId)));
  if (!row) return null;
  if (
    row.status === "proposed" &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() < Date.now()
  ) {
    const [updated] = await db
      .update(tradeProposals)
      .set({ status: "expired" })
      .where(eq(tradeProposals.id, row.id))
      .returning();
    return updated;
  }
  return row;
}

export async function listProposals(userId: string, limit = 25): Promise<ProposalRow[]> {
  return db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.userId, userId))
    .orderBy(desc(tradeProposals.createdAt))
    .limit(limit);
}

const TRANSITIONS: Record<string, string[]> = {
  proposed: ["approved", "dismissed", "expired", "executed"],
  approved: ["executed", "dismissed", "expired"],
};

export async function setProposalStatus(
  userId: string,
  id: number,
  next: "approved" | "dismissed" | "executed",
): Promise<ProposalRow> {
  const row = await getProposal(userId, id);
  if (!row) throw new ProposalError("proposal not found");
  if (!(TRANSITIONS[row.status] ?? []).includes(next)) {
    throw new ProposalError(`cannot move proposal from ${row.status} to ${next}`);
  }
  const [updated] = await db
    .update(tradeProposals)
    .set({ status: next })
    .where(eq(tradeProposals.id, id))
    .returning();
  return updated;
}
