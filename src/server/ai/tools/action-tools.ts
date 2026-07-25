import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { tradeProposalInputSchema } from "@/lib/ai/action-schemas";
import { db } from "@/server/db";
import { executions } from "@/server/db/schema";
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
              };
              return {
                id: r.id,
                status: r.status,
                reportId: r.reportId,
                trade: `${p.amountIn ?? "?"} ${p.tokenIn?.symbol ?? "?"} → ${p.tokenOut?.symbol ?? "?"}`,
                chain: p.chainName,
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
              txHash: e.txHash,
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
