import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { getAdapter } from "@/server/portfolio/adapters";
import { latestSnapshots, registerWallet } from "@/server/portfolio/service";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ data: await latestSnapshots(ctx.userId) });
}

const BodySchema = z.object({
  address: z.string(),
  // Widens as non-EVM adapters land (solana | bitcoin | sui).
  chain: z.enum(["evm", "hyperliquid"]).default("evm"),
  label: z.string().trim().max(60).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !getAdapter(parsed.data.chain)?.validateAddress(parsed.data.address)) {
    return NextResponse.json({ error: "address must be a 0x address" }, { status: 400 });
  }
  const address = await registerWallet(ctx.userId, parsed.data.address, {
    chain: parsed.data.chain,
    label: parsed.data.label || undefined,
  });
  return NextResponse.json({ data: { address } }, { status: 201 });
}
