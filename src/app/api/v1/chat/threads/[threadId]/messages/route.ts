import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { getThreadForUser } from "@/server/chat/service";
import { loadThreadUIMessages } from "@/server/chat/turns";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { threadId } = await params;
  const thread = await getThreadForUser(ctx.userId, threadId);
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  const messages = await loadThreadUIMessages(ctx.userId, threadId);
  // { data } envelope — the shape the history adapter expects.
  return NextResponse.json({ data: { threadId, title: thread.title, messages } });
}
