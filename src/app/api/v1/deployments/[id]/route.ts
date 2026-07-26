import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import {
  deleteDeployment,
  DeploymentError,
  getDeployment,
  transitionDeployment,
} from "@/server/deployments/service";

export const runtime = "nodejs";

const PatchSchema = z.object({
  status: z.enum(["active", "paused", "stopped"]),
});

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const deployment = await getDeployment(ctx.userId, id);
  if (!deployment) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ deployment });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const deployment = await transitionDeployment(ctx.userId, id, parsed.data.status);
    return NextResponse.json({ deployment });
  } catch (err) {
    if (err instanceof DeploymentError) {
      const status = err.message.includes("not found") ? 404 : 422;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error("[deployments] transition error", err);
    return NextResponse.json({ error: "failed to update deployment" }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  try {
    await deleteDeployment(ctx.userId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DeploymentError) {
      const status = err.message.includes("not found") ? 404 : 422;
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error("[deployments] delete error", err);
    return NextResponse.json({ error: "failed to delete deployment" }, { status: 502 });
  }
}
