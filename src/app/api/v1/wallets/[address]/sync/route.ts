import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { AlchemyError } from "@/server/portfolio/alchemy";
import { syncWallet } from "@/server/portfolio/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { address } = await params;
  try {
    const result = await syncWallet(ctx.userId, address);
    return NextResponse.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync failed";
    const status = err instanceof AlchemyError ? 502 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
