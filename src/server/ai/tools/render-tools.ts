import { tool, type ToolSet } from "ai";
import { and, eq } from "drizzle-orm";
import {
  backtestSpecSchema,
  metricsSpecSchema,
  priceChartSpecSchema,
} from "@/lib/ai/render-schemas";
import { db } from "@/server/db";
import { backtestRuns } from "@/server/db/schema";
import type { ToolAuditSink } from "./sdk-tools";

/**
 * Render tools: the validated args ARE the artifact. Execute is (near-)trivial
 * — the client renders the block from the persisted tool part. Chart/backtest
 * specs are references; the client fetches the underlying data from /api/v1.
 */

export const RENDER_SYSTEM_ADDENDUM = `## Visual blocks

You can render inline visual blocks with these tools. Use them when a chart or
metric row genuinely helps — not on every answer.
- render_price_chart: a candlestick chart spec (asset, interval, lookback,
  optional SMA/EMA overlays). Intervals: 5m, 15m, 1h, 4h, 1d, 1w, 1M — always
  use the timeframe the user asked for ("weekly" -> 1w, "monthly" -> 1M), never
  substitute a different one. Warm-up bars for the overlays are added
  automatically, so lookbackBars is the window you want SHOWN. Never paste
  candle arrays into text — fetch data with read tools for your prose, and let
  the chart show the series.
- render_metrics: a compact KPI row. Values are preformatted strings you copy
  from tool results.
- render_backtest: the equity/price visualization of a completed backtest run
  (by runId). Use after running or discussing a specific backtest.
After a block, add at most 2-3 sentences of interpretation.`;

export function buildRenderTools(userId: string, audit: ToolAuditSink): ToolSet {
  return {
    render_price_chart: tool({
      description:
        "Render an inline candlestick chart for an asset. Args are a spec (assetId, interval — one of 5m/15m/1h/4h/1d/1w/1M, lookbackBars = bars to SHOW, optional sma/ema overlays); the client fetches the candles itself, including the extra warm-up bars each overlay needs.",
      inputSchema: priceChartSpecSchema,
      execute: async (input) => {
        audit({ name: "render_price_chart", input, output: { rendered: true } });
        return { rendered: true };
      },
    }),
    render_metrics: tool({
      description:
        "Render a compact row of metric tiles (1-8 items with label, preformatted value, optional delta).",
      inputSchema: metricsSpecSchema,
      execute: async (input) => {
        audit({ name: "render_metrics", input, output: { rendered: true } });
        return { rendered: true };
      },
    }),
    render_backtest: tool({
      description:
        "Render the results visualization (price + trades + equity curve + metric grid) of a completed backtest run by runId.",
      inputSchema: backtestSpecSchema,
      execute: async (input) => {
        // Verify ownership so a rendered block can never reference another
        // user's run (the block endpoint re-checks, this catches it early).
        const [run] = await db
          .select({ id: backtestRuns.id, status: backtestRuns.status })
          .from(backtestRuns)
          .where(and(eq(backtestRuns.id, input.runId), eq(backtestRuns.userId, userId)));
        if (!run) {
          const output = { error: "backtest run not found" };
          audit({ name: "render_backtest", input, error: output.error });
          return output;
        }
        if (run.status !== "done") {
          const output = { error: `backtest run is ${run.status}, not done` };
          audit({ name: "render_backtest", input, error: output.error });
          return output;
        }
        audit({ name: "render_backtest", input, output: { rendered: true } });
        return { rendered: true };
      },
    }),
  };
}
