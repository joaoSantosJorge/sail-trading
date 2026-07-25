import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { strategies } from "@/server/db/schema";
import { parseStrategyDSL } from "@/server/engine/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const dsl = parseStrategyDSL((body as { dsl: unknown }).dsl);
    const [row] = await db
      .insert(strategies)
      .values({ userId: ctx.userId, name: dsl.name, dsl, source: "manual" })
      .returning({ id: strategies.id });
    return NextResponse.json({ id: row.id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
