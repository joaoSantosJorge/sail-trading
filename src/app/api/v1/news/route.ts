import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { getNews } from "@/server/news/newsCache";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const sp = req.nextUrl.searchParams;
  const currencies = sp.get("currencies")
    ? sp
        .get("currencies")!
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 10)
    : undefined;
  const limit = Number(sp.get("limit")) || 30;

  const result = await getNews(db, { currencies, limit });
  return NextResponse.json({
    data: {
      configured: result.configured,
      stale: result.stale,
      items: result.items.map((n) => ({
        id: n.id,
        title: n.title,
        url: n.url,
        kind: n.kind,
        source: n.sourceDomain,
        currencies: n.currencies,
        publishedAt: n.publishedAt.toISOString(),
      })),
    },
  });
}
