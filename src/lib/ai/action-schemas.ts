import { z } from "zod";

/**
 * Client-safe shapes for zero-side-effect action tools. A ProposedAction is
 * what propose_trade returns: the client card navigates to targetPath where
 * the user reviews and (only via their wallet signature) executes.
 */

export const tradeProposalInputSchema = z.object({
  chainId: z.number().int(),
  walletAddress: z.string(),
  /** Symbol or 0x address of the token to SELL (must be held in the wallet). */
  tokenIn: z.string().min(2).max(64),
  /** Symbol or 0x address of the token to BUY (must be a known token). */
  tokenOut: z.string().min(2).max(64),
  /** Amount of tokenIn to sell, decimal string in token units (e.g. "0.05"). */
  amountIn: z.string().regex(/^\d+(\.\d+)?$/, "decimal string"),
  /** Approximate USD size of the trade (used for the safety cap). */
  sizeUsd: z.number().positive(),
  maxSlippageBps: z.number().int().min(1).max(100).default(50),
  rationale: z.string().min(10).max(2000),
  risks: z.array(z.string().max(300)).min(1).max(6),
  confidence: z.enum(["low", "medium", "high"]),
  /** What would void the thesis. */
  invalidation: z.string().min(5).max(500),
  /** Optional: id returned by save_research_report — links this proposal to its thesis report. */
  reportId: z.number().int().positive().optional(),
});
export type TradeProposalInput = z.infer<typeof tradeProposalInputSchema>;

export type ProposedAction = {
  proposalId: number;
  targetPath: string;
  summary: { label: string; value: string }[];
  expiresAt: string;
};
