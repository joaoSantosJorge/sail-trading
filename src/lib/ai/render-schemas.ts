import { z } from "zod";

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
  interval: z.enum(["15m", "1h", "4h", "1d"]),
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
