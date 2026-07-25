import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { assets, backtestRuns, strategies } from "@/server/db/schema";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  const runId = Number(id);
  if (!Number.isInteger(runId)) {
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  }

  const [row] = await db
    .select({ run: backtestRuns, strategyName: strategies.name, assetSymbol: assets.symbol })
    .from(backtestRuns)
    .innerJoin(strategies, eq(backtestRuns.strategyId, strategies.id))
    .innerJoin(assets, eq(backtestRuns.assetId, assets.id))
    .where(and(eq(backtestRuns.id, runId), eq(backtestRuns.userId, ctx.userId)));
  if (!row) {
    return NextResponse.json({ error: "backtest run not found" }, { status: 404 });
  }

  const { run, strategyName, assetSymbol } = row;
  return NextResponse.json({
    data: {
      id: run.id,
      assetId: run.assetId,
      strategyId: run.strategyId,
      interval: run.interval,
      fromT: run.fromT,
      toT: run.toT,
      status: run.status,
      params: run.params,
      metrics: run.metrics,
      trades: run.trades ?? [],
      equityCurve: run.equityCurve ?? [],
      strategyName,
      assetSymbol,
    },
  });
}
