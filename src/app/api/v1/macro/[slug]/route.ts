import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { getMacroSeries } from "@/server/macro/macroCache";
import { MACRO_SLUGS } from "@/server/macro/registry";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { slug } = await params;
  if (!MACRO_SLUGS.includes(slug)) {
    return NextResponse.json({ error: `unknown macro series "${slug}"` }, { status: 400 });
  }

  const result = await getMacroSeries(db, slug);
  if (!result) {
    return NextResponse.json({ error: `unknown macro series "${slug}"` }, { status: 400 });
  }
  return NextResponse.json({
    data: {
      series: {
        slug: result.def.slug,
        name: result.def.name,
        unit: result.def.unit,
        transform: result.def.transform,
      },
      source: result.source,
      stale: result.stale,
      observations: result.observations,
    },
  });
}
