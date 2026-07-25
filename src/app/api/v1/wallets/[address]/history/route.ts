import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { getWalletHistory } from "@/server/portfolio/history";

export const runtime = "nodejs";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** ms epoch cursor — return items strictly older than this. */
  before: z.coerce.number().int().positive().optional(),
  tag: z.string().min(1).max(32).optional(),
  asset: z.string().min(1).max(32).optional(),
  direction: z.enum(["in", "out", "self"]).optional(),
  type: z.enum(["transfer", "trade"]).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { address } = await params;
  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid history query" }, { status: 400 });
  }

  const items = await getWalletHistory(ctx.userId, address, parsed.data);
  return NextResponse.json({ data: items });
}
