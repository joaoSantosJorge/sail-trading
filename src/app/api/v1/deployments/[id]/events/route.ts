import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { listEvents } from "@/server/deployments/events";
import { getDeployment } from "@/server/deployments/service";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!(await getDeployment(ctx.userId, id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const before = sp.has("before") ? Number(sp.get("before")) : undefined;
  const limit = sp.has("limit") ? Number(sp.get("limit")) : undefined;
  if ((before !== undefined && !Number.isInteger(before)) || (limit !== undefined && !Number.isInteger(limit))) {
    return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  }

  const events = await listEvents(ctx.userId, id, { before, limit });
  return NextResponse.json({
    events,
    nextCursor: events.length > 0 ? events[events.length - 1].id : null,
  });
}
