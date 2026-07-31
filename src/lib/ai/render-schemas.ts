import { z } from "zod";
import { CHART_INTERVALS } from "@/server/market/types";

/**
 * Client-safe schemas for the chat render tools. The validated tool-call args
 * ARE the artifact: the server's execute is trivial, and the client block
 * components re-parse these from the persisted tool part on every render
 * (defensively — a malformed historical part renders an error frame, not a
 * crash). Chart/backtest blocks carry a SPEC, not data — the client fetches
 * candles / the run from /api/v1 so heavy series never pass through the model.
 */

export const priceChartSpecSchema = z.object({
  assetId: z.number().int(),
  // Charts accept the full chart-interval superset (5m..1M) — including the
  // weekly/monthly ones the strategy DSL deliberately excludes.
  interval: z.enum(CHART_INTERVALS),
  lookbackBars: z.number().int().min(30).max(500).default(180),
  overlays: z
    .array(
      z.object({
        type: z.enum(["sma", "ema"]),
        period: z.number().int().min(2).max(500),
      }),
    )
    .max(4)
    .optional(),
  title: z.string().max(120).optional(),
});
export type PriceChartSpec = z.infer<typeof priceChartSpecSchema>;

/**
 * Bars to FETCH for a chart spec: the window to show plus the warm-up an
 * overlay needs before its first value (an SMA(200) is undefined for 199 bars).
 * Without this a "weekly chart with a 200-week MA" over the default 180-bar
 * window would draw an empty MA line.
 */
export function chartFetchBars(spec: PriceChartSpec): number {
  const warmup = Math.max(0, ...(spec.overlays ?? []).map((o) => o.period - 1));
  return spec.lookbackBars + warmup;
}

export const metricsSpecSchema = z.object({
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        label: z.string().max(60),
        value: z.string().max(60),
        delta: z.string().max(40).optional(),
        goodWhen: z.enum(["up", "down"]).optional(),
      }),
    )
    .min(1)
    .max(8),
});
export type MetricsSpec = z.infer<typeof metricsSpecSchema>;

export const backtestSpecSchema = z.object({
  runId: z.number().int(),
  title: z.string().max(120).optional(),
});
export type BacktestSpec = z.infer<typeof backtestSpecSchema>;
