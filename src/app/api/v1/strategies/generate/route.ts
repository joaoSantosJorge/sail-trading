import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { generateStrategy, StrategyGenError } from "@/server/ai/strategyGen";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { strategies } from "@/server/db/schema";

export const runtime = "nodejs";
export const maxDuration = 120;

const BodySchema = z.object({ prompt: z.string().min(10).max(4000) });

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "prompt must be a string of 10-4000 characters" },
      { status: 400 },
    );
  }

  try {
    const dsl = await generateStrategy(parsed.data.prompt);
    const [row] = await db
      .insert(strategies)
      .values({
        userId: ctx.userId,
        name: dsl.name,
        dsl,
        source: "ai",
        promptText: parsed.data.prompt,
      })
      .returning({ id: strategies.id });
    return NextResponse.json({ id: row.id, dsl });
  } catch (err) {
    if (err instanceof StrategyGenError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("[strategies/generate] error", err);
    return NextResponse.json({ error: "strategy generation failed" }, { status: 502 });
  }
}
