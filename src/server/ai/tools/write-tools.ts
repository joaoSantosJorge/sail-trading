import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { db } from "@/server/db";
import { researchReports, strategies } from "@/server/db/schema";
import { MODELS } from "@/server/ai/client";
import { parseStrategyDSL } from "@/server/engine/types";
import { BacktestError, executeBacktestRun } from "@/server/backtests/run";
import type { ToolAuditRecord, ToolAuditSink } from "./sdk-tools";

/**
 * Write tools — all `needsApproval: true`. The UI shows an ApprovalCard with a
 * human-readable summary of the exact validated args; nothing runs until the
 * user approves. Execute re-validates everything server-side.
 */

export const WRITE_SYSTEM_ADDENDUM = `## Saving strategies and running backtests

- create_strategy takes a COMPLETE strategy DSL object (see the DSL spec).
  Author the DSL yourself from the user's description. The user must approve
  before anything is saved. If the result is {error, problems}, fix the listed
  problems and call the tool again with the corrected DSL.
- run_backtest runs a saved strategy on an asset. Defaults: last ~2000 bars,
  feeBps 30, slippageBps 10, gasUsd 1, initialEquity 10000. The user approves
  the run. Interpret the returned metrics honestly — compare against buy-and-
  hold, and mention drawdown and trade count, not just returns.
- Strategies the DSL cannot express (shorting, multi-asset, operand
  arithmetic like "3% below the high") must NOT be approximated silently —
  tell the user what can't be encoded and offer the closest expressible
  alternative.
- save_research_report saves a markdown research note as a document the user
  can revisit under Documents -> Reports. Offer it after a substantial piece
  of analysis; write the full report into reportMd (GFM), grounded in this
  conversation's tool results.
- When the user EXPLICITLY asks to save/create/run something, call the write
  tool directly — the approval card the user sees IS the confirmation step.
  Do not draft in text and ask for permission first.`;

const runBacktestSchema = z.object({
  strategyId: z.number().int(),
  assetId: z.number().int(),
  fromMs: z.number().optional(),
  toMs: z.number().optional(),
  params: z
    .object({
      feeBps: z.number().min(0).max(1000).optional(),
      slippageBps: z.number().min(0).max(1000).optional(),
      gasUsd: z.number().min(0).max(1000).optional(),
      initialEquity: z.number().min(1).max(1e12).optional(),
    })
    .optional(),
});

export function buildWriteTools(
  userId: string,
  opts: { promptText?: string; getAudits?: () => ToolAuditRecord[] },
  audit: ToolAuditSink,
): ToolSet {
  return {
    save_research_report: tool({
      description:
        "Save a markdown research report as a document (Documents -> Reports). The user approves before saving. reportMd is the FULL report in GitHub-flavored markdown.",
      inputSchema: z.object({
        title: z.string().min(3).max(150),
        reportMd: z.string().min(50).max(50_000),
        walletAddress: z.string().optional(),
      }),
      needsApproval: true,
      execute: async (input) => {
        try {
          const [row] = await db
            .insert(researchReports)
            .values({
              userId,
              title: input.title,
              reportMd: input.reportMd,
              wallet: input.walletAddress ?? null,
              model: MODELS.chat,
              // Provenance: the tool calls that grounded this turn.
              inputs: { toolCalls: opts.getAudits?.() ?? [] },
            })
            .returning({ id: researchReports.id });
          const output = { reportId: row.id, title: input.title };
          audit({ name: "save_research_report", input: { title: input.title }, output });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "save failed";
          audit({ name: "save_research_report", input: { title: input.title }, error: message });
          return { error: message };
        }
      },
    }),
    create_strategy: tool({
      description:
        "Save a new trading strategy from a complete strategy-DSL object. The user approves before saving. On {error, problems}, correct the DSL and retry.",
      // The DSL's recursive condition trees don't fit a strict JSON schema —
      // accept the object and run the full Zod + semantic validation inside.
      inputSchema: z.object({
        dsl: z.record(z.string(), z.unknown()).describe("The complete StrategyDSL JSON object"),
      }),
      needsApproval: true,
      execute: async (input) => {
        try {
          const dsl = parseStrategyDSL(input.dsl);
          const [row] = await db
            .insert(strategies)
            .values({
              userId,
              name: dsl.name,
              dsl,
              source: "ai",
              promptText: opts.promptText ?? null,
            })
            .returning({ id: strategies.id });
          const output = { strategyId: row.id, name: dsl.name, interval: dsl.interval };
          audit({ name: "create_strategy", input, output });
          return output;
        } catch (err) {
          const message = err instanceof Error ? err.message : "validation failed";
          audit({ name: "create_strategy", input, error: message });
          return { error: message };
        }
      },
    }),
    run_backtest: tool({
      description:
        "Run a saved strategy against an asset's cached history and persist the results. The user approves the run. Returns headline metrics and the runId.",
      inputSchema: runBacktestSchema,
      needsApproval: true,
      execute: async (input) => {
        try {
          const result = await executeBacktestRun(userId, input);
          const output = {
            runId: result.id,
            asset: result.assetSymbol,
            interval: result.interval,
            metrics: {
              totalReturnPct: Number(result.metrics.totalReturnPct.toFixed(2)),
              buyHoldReturnPct: Number(result.metrics.buyHoldReturnPct.toFixed(2)),
              maxDrawdownPct: Number(result.metrics.maxDrawdownPct.toFixed(2)),
              sharpe: Number(result.metrics.sharpe.toFixed(3)),
              winRatePct: Number(result.metrics.winRatePct.toFixed(1)),
              profitFactor: Number.isFinite(result.metrics.profitFactor)
                ? Number(result.metrics.profitFactor.toFixed(2))
                : null,
              tradeCount: result.metrics.tradeCount,
              timeInMarketPct: Number(result.metrics.timeInMarketPct.toFixed(1)),
            },
          };
          audit({ name: "run_backtest", input, output });
          return output;
        } catch (err) {
          const message =
            err instanceof BacktestError ? err.message : "backtest failed unexpectedly";
          audit({ name: "run_backtest", input, error: message });
          return { error: message };
        }
      },
    }),
  };
}
