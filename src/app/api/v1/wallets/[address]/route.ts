import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { removeWallet } from "@/server/portfolio/service";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { address } = await params;
  const removed = await removeWallet(ctx.userId, address);
  if (!removed) {
    return NextResponse.json({ error: "wallet not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
