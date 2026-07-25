import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { deleteChatThread } from "@/server/chat/service";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { threadId } = await params;
  const deleted = await deleteChatThread(ctx.userId, threadId);
  if (!deleted) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
