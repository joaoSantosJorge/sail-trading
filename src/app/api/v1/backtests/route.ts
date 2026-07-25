import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { BacktestError, executeBacktestRun } from "@/server/backtests/run";

export const runtime = "nodejs";
export const maxDuration = 120;

const BodySchema = z.object({
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

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const result = await executeBacktestRun(ctx.userId, parsed.data);
    return NextResponse.json({ id: result.id, metrics: result.metrics });
  } catch (err) {
    if (err instanceof BacktestError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("[backtests] error", err);
    return NextResponse.json({ error: "backtest failed" }, { status: 502 });
  }
}
