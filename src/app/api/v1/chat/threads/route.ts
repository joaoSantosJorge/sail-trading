import { NextResponse, type NextRequest } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { createChatThread, listChatThreads } from "@/server/chat/service";

export async function GET(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 25, 50);
  const threads = await listChatThreads(ctx.userId, limit);
  // { data } envelope — the shape the chat-threads client context expects.
  return NextResponse.json({
    data: threads.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt.toISOString(),
    })),
  });
}

export async function POST() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const thread = await createChatThread(ctx.userId, "New Chat");
  return NextResponse.json(
    {
      data: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt.toISOString() },
    },
    { status: 201 },
  );
}
