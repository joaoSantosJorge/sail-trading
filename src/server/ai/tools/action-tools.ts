import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { perpProposalInputSchema, tradeProposalInputSchema } from "@/lib/ai/action-schemas";
import { db } from "@/server/db";
import { executions } from "@/server/db/schema";
import { createPerpProposal, validatePerpProposal } from "@/server/trade/perpProposals";
import {
  createProposal,
  listProposals,
  ProposalError,
  validateProposal,
} from "@/server/trade/proposals";
import type { ToolAuditSink } from "./sdk-tools";

/**
 * Action tools: zero-side-effect proposals. propose_trade validates + clamps
 * + persists a proposal row and returns a ProposedAction; the client card
 * navigates to the trade page where the user's wallet signature is the SOLE
 * authorization. No approval gate here — nothing moves funds.
 */

export const ACTION_SYSTEM_ADDENDUM = `## Trade proposals

- propose_trade turns your analysis into an actionable trade proposal. It
  validates against the user's LATEST wallet snapshot and hard server-side
  caps; on {error} results, fix what the message says and retry (or tell the
  user why it cannot be proposed).
- tokenIn must be held in the chosen wallet on the chosen chain; tokenOut must
  be one of the known tokens the error message lists when wrong.
- A proposal is NOT a trade. The user reviews it on the trade page and only
  their wallet signature executes anything. You will NEVER be told whether a
  proposal was executed — never claim a trade happened, and phrase follow-ups
  accordingly (check get_execution/list_trade_proposals for recorded status
  if the user asks).
- Always include honest risks and an invalidation condition. Propose trades
  only when the user asks for one or clearly wants to act.`;

/** Appended AFTER the thesis addendum — keep ACTION_SYSTEM_ADDENDUM byte-stable. */
export const PERP_ACTION_ADDENDUM = `## Perp order proposals (Hyperliquid)

- propose_perp_order proposes a perpetual-futures order on Hyperliquid for a
  registered Hyperliquid wallet (get_perp_positions / get_portfolio show
  them). Same contract as propose_trade: validated + clamped server-side,
  nothing executes without the user signing on the trade page, and you are
  never told outcomes except via get_execution.
- coin is the Hyperliquid perp name (BTC, ETH, SOL, HYPE, …). size is in coin
  units; sizeUsd must match size × price. Leverage is clamped to a hard
  server cap — do not promise leverage above a few x.
- Perps carry liquidation risk: ALWAYS state the liquidation direction and
  funding costs in risks, and prefer low leverage unless the user explicitly
  asks otherwise. reduceOnly closes exposure and requires an open opposite
  position in the latest snapshot.
- stopLossPx/takeProfitPx attach reduce-only trigger exits placed atomically
  with the entry (long: SL below / TP above the entry price; short reversed;
  not allowed with reduceOnly). Prefer proposing a stop loss whenever
  leverage is above 1x.`;

export function buildActionTools(userId: string, audit: ToolAuditSink): ToolSet {
  return {
    propose_trade: tool({
      description:
        "Create a trade proposal (swap) from analysis: validated against the user's wallet snapshot and size caps, persisted as a document, and opened for review on the trade page. Nothing executes without the user's wallet signature. Pass reportId (from save_research_report's result) when the trade implements a saved thesis report.",
      inputSchema: tradeProposalInputSchema,
      execute: async (input) => {
        try {
          const validated = await validateProposal(userId, input);
          const action = await createProposal(userId, validated);
          audit({ name: "propose_trade", input, output: action });
          return action;
        } catch (err) {
          const message =
            err instanceof ProposalError ? err.message : "proposal validation failed";
          audit({ name: "propose_trade", input, error: message });
          return { error: message };
        }
      },
    }),
    propose_perp_order: tool({
      description:
        "Create a Hyperliquid perpetual-futures order proposal (long/short, market or limit, leverage-capped): validated against the user's Hyperliquid wallet snapshot, live venue metadata, and hard server-side caps, then opened for review on the trade page. Optional stopLossPx/takeProfitPx attach reduce-only trigger exit orders placed atomically with the entry. Nothing executes without the user's signature there. Pass reportId when it implements a saved thesis.",
      inputSchema: perpProposalInputSchema,
      execute: async (input) => {
        try {
          const validated = await validatePerpProposal(userId, input);
          const action = await createPerpProposal(userId, validated);
          audit({ name: "propose_perp_order", input, output: action });
          return action;
        } catch (err) {
          const message =
            err instanceof ProposalError ? err.message : "proposal validation failed";
          audit({ name: "propose_perp_order", input, error: message });
          return { error: message };
        }
      },
    }),
    list_trade_proposals: tool({
      description:
        "List the user's trade proposals with status (proposed/approved/executed/dismissed/expired).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(25).default(10) }),
      execute: async (input) => {
        try {
          const rows = await listProposals(userId, input.limit);
          const output = {
            proposals: rows.map((r) => {
              const p = r.proposal as {
                amountIn?: string;
                tokenIn?: { symbol?: string };
                tokenOut?: { symbol?: string };
                chainName?: string;
                side?: string;
                size?: string;
                coin?: string;
                leverage?: number;
              };
              return {
                id: r.id,
                kind: r.kind,
                status: r.status,
                reportId: r.reportId,
                trade:
                  r.kind === "perp"
                    ? `${p.side ?? "?"} ${p.size ?? "?"} ${p.coin ?? "?"}-PERP ${p.leverage ?? "?"}x`
                    : `${p.amountIn ?? "?"} ${p.tokenIn?.symbol ?? "?"} → ${p.tokenOut?.symbol ?? "?"}`,
                chain: r.kind === "perp" ? "Hyperliquid" : p.chainName,
                createdAt: r.createdAt.toISOString(),
                expiresAt: r.expiresAt?.toISOString() ?? null,
              };
            }),
          };
          audit({ name: "list_trade_proposals", input, output });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "failed";
          audit({ name: "list_trade_proposals", input, error: message });
          return { error: message };
        }
      },
    }),
    get_execution: tool({
      description:
        "Read the recorded execution attempt for a proposal (tx hash and status), if any. This is the ONLY way to know whether a proposal was executed.",
      inputSchema: z.object({ proposalId: z.number().int() }),
      execute: async (input) => {
        try {
          const rows = await db
            .select()
            .from(executions)
            .where(
              and(eq(executions.proposalId, input.proposalId), eq(executions.userId, userId)),
            );
          const output = {
            executions: rows.map((e) => ({
              id: e.id,
              status: e.status,
              venue: e.venue,
              txHash: e.txHash,
              externalId: e.externalId,
              chainId: e.chainId,
              createdAt: e.createdAt.toISOString(),
            })),
          };
          audit({ name: "get_execution", input, output });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "failed";
          audit({ name: "get_execution", input, error: message });
          return { error: message };
        }
      },
    }),
  };
}
