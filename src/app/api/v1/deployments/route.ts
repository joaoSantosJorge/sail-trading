import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import {
  createDeployment,
  DeploymentError,
  listDeployments,
} from "@/server/deployments/service";

export const runtime = "nodejs";

const BodySchema = z.object({
  strategyId: z.number().int(),
  assetId: z.number().int(),
  backtestRunId: z.number().int().optional(),
  leverage: z.number().int().min(1).max(20).default(1),
  sizingMode: z.enum(["pct_equity", "fixed_usd"]),
  sizingValue: z.number().positive(),
  maxDrawdownPct: z.number().positive().max(100).optional(),
  dailyLossLimitUsd: z.number().positive().optional(),
});

export async function GET() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ deployments: await listDeployments(ctx.userId) });
}

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const deployment = await createDeployment(ctx.userId, parsed.data);
    return NextResponse.json({ deployment }, { status: 201 });
  } catch (err) {
    if (err instanceof DeploymentError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("[deployments] create error", err);
    return NextResponse.json({ error: "failed to create deployment" }, { status: 502 });
  }
}
