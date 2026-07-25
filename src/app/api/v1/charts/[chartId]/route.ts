import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import {
  deleteSavedChart,
  getSavedChart,
  savedChartPatchSchema,
  updateSavedChart,
} from "@/server/charts/savedCharts";
import { db } from "@/server/db";

export const runtime = "nodejs";

type Params = { params: Promise<{ chartId: string }> };

async function parseId(params: Params["params"]): Promise<number | null> {
  const { chartId } = await params;
  const id = Number(chartId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = await parseId(params);
  if (id === null) return NextResponse.json({ error: "invalid chart id" }, { status: 400 });

  const row = await getSavedChart(db, ctx.userId, id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ data: row });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = await parseId(params);
  if (id === null) return NextResponse.json({ error: "invalid chart id" }, { status: 400 });

  const parsed = savedChartPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid patch" }, { status: 400 });
  }

  const row = await updateSavedChart(db, ctx.userId, id, parsed.data);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ data: { id: row.id, name: row.name } });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = await parseId(params);
  if (id === null) return NextResponse.json({ error: "invalid chart id" }, { status: 400 });

  const deleted = await deleteSavedChart(db, ctx.userId, id);
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ data: { deleted: true } });
}
