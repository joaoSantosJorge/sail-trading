import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { getProposal, ProposalError, setProposalStatus } from "@/server/trade/proposals";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const row = await getProposal(ctx.userId, Number(id));
  if (!row) return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  return NextResponse.json({
    data: {
      id: row.id,
      status: row.status,
      reportId: row.reportId,
      proposal: row.proposal,
      walletAddress: row.walletAddress,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
  });
}

const PatchSchema = z.object({ status: z.literal("dismissed") });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "only { status: \"dismissed\" } is allowed" }, { status: 400 });
  }
  try {
    const row = await setProposalStatus(ctx.userId, Number(id), "dismissed");
    return NextResponse.json({ data: { id: row.id, status: row.status } });
  } catch (err) {
    const message = err instanceof ProposalError ? err.message : "update failed";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
