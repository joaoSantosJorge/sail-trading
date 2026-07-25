import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { assets } from "@/server/db/schema";
import { getCandles } from "@/server/market/candleCache";
import { CHART_INTERVAL_MS, isChartInterval, type ChartInterval } from "@/server/market/types";

export const runtime = "nodejs";

const DEFAULT_LOOKBACK_BARS: Record<ChartInterval, number> = {
  "5m": 4032, // 14 days
  "15m": 2880, // 30 days
  "1h": 17520, // 2 years
  "4h": 4380, // 2 years
  "1d": 1825, // 5 years
  "1w": 520, // 10 years
  "1M": 120, // 10 years
};

export async function GET(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const sp = req.nextUrl.searchParams;
  const assetId = Number(sp.get("assetId"));
  const interval = sp.get("interval") ?? "1d";
  if (!Number.isInteger(assetId) || !isChartInterval(interval)) {
    return NextResponse.json({ error: "invalid assetId or interval" }, { status: 400 });
  }

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) {
    return NextResponse.json({ error: "unknown asset" }, { status: 404 });
  }

  const now = Date.now();
  const to = sp.get("to") ? Number(sp.get("to")) : now;
  // `bars` takes precedence over the interval default (used by chat blocks).
  const bars = sp.get("bars") ? Number(sp.get("bars")) : null;
  const lookback =
    bars && Number.isFinite(bars)
      ? Math.min(Math.max(Math.trunc(bars), 1), 20_000)
      : DEFAULT_LOOKBACK_BARS[interval];
  const from = sp.get("from") ? Number(sp.get("from")) : to - lookback * CHART_INTERVAL_MS[interval];
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return NextResponse.json({ error: "invalid from/to" }, { status: 400 });
  }

  try {
    const result = await getCandles(db, asset, interval, from, to);
    if (result.fetched.length > 0) {
      console.log(
        `[candles] ${asset.symbol} ${interval}: fetched ${result.fetched
          .map((s) => `${new Date(s.from).toISOString()}..${new Date(s.to).toISOString()}`)
          .join(", ")} from upstream`,
      );
    } else {
      console.log(`[candles] ${asset.symbol} ${interval}: full cache hit (${result.candles.length} candles)`);
    }
    return NextResponse.json({
      asset: { id: asset.id, symbol: asset.symbol, name: asset.name },
      interval,
      candles: result.candles,
      fetched: result.fetched,
    });
  } catch (err) {
    console.error("[candles] error", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
