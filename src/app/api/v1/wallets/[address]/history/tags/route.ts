import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { listDistinctTags, MAX_TAG_LENGTH, MAX_TAGS_PER_ITEM, setTags } from "@/server/portfolio/tags";

export const runtime = "nodejs";

const PutSchema = z.object({
  txKey: z.string().min(1).max(120),
  // Replace-set: this list becomes the item's tags (add & remove in one call).
  tags: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS_PER_ITEM),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { address } = await params;
  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid txKey/tags" }, { status: 400 });
  }

  const tags = await setTags(ctx.userId, address, parsed.data.txKey, parsed.data.tags);
  return NextResponse.json({ data: { txKey: parsed.data.txKey, tags } });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { address } = await params;
  const tags = await listDistinctTags(ctx.userId, address);
  return NextResponse.json({ data: { tags } });
}
