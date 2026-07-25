import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { listProposals } from "@/server/trade/proposals";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const rows = await listProposals(ctx.userId);
  return NextResponse.json({
    data: rows.map((r) => ({
      id: r.id,
      status: r.status,
      reportId: r.reportId,
      proposal: r.proposal,
      walletAddress: r.walletAddress,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
