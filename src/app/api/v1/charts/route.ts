import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import {
  createSavedChart,
  listSavedCharts,
  MAX_SAVED_CHARTS,
  savedChartCreateSchema,
} from "@/server/charts/savedCharts";
import { db } from "@/server/db";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const charts = await listSavedCharts(db, ctx.userId);
  return NextResponse.json({
    data: {
      charts: charts.map((c) => ({ ...c, updatedAt: c.updatedAt.toISOString() })),
    },
  });
}

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = savedChartCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid saved chart" }, { status: 400 });
  }

  const row = await createSavedChart(db, ctx.userId, parsed.data);
  if (!row) {
    return NextResponse.json(
      { error: `limit of ${MAX_SAVED_CHARTS} saved charts reached` },
      { status: 400 },
    );
  }
  return NextResponse.json({ data: { id: row.id, name: row.name } }, { status: 201 });
}
