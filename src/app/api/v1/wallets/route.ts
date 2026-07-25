import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { isEvmAddress, latestSnapshots, registerWallet } from "@/server/portfolio/service";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ data: await latestSnapshots(ctx.userId) });
}

const BodySchema = z.object({
  address: z.string(),
  // Widens as non-EVM adapters land (solana | bitcoin | sui | hyperliquid).
  chain: z.enum(["evm"]).default("evm"),
  label: z.string().trim().max(60).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isEvmAddress(parsed.data.address)) {
    return NextResponse.json({ error: "address must be a 0x EVM address" }, { status: 400 });
  }
  const address = await registerWallet(ctx.userId, parsed.data.address, {
    chain: parsed.data.chain,
    label: parsed.data.label || undefined,
  });
  return NextResponse.json({ data: { address } }, { status: 201 });
}
