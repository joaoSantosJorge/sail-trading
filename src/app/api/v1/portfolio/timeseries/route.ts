import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { getPortfolioTimeseries } from "@/server/portfolio/timeseries";

export const runtime = "nodejs";
// Cold path may resolve + backfill daily prices for many tokens at the
// CoinGecko rate limit; warm requests are DB-only.
export const maxDuration = 120;

const QuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d", "1y", "all"]).default("30d"),
  granularity: z.enum(["day", "month"]).default("day"),
  /** Comma-separated symbols to break out as per-asset series. */
  assets: z
    .string()
    .optional()
    .transform((s) =>
      s
        ?.split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  /** Comma-separated wallet addresses to restrict the series to. */
  wallets: z
    .string()
    .optional()
    .transform((s) =>
      s
        ?.split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    )
    .refine((list) => !list || list.every((a) => /^0x[0-9a-f]{40}$/.test(a)), {
      message: "invalid wallet address",
    }),
});

export async function GET(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid range/granularity/assets" }, { status: 400 });
  }

  const { range, granularity, assets, wallets } = parsed.data;
  const data = await getPortfolioTimeseries(ctx.userId, {
    range,
    granularity,
    symbols: assets,
    wallets,
  });
  return NextResponse.json({ data });
}
