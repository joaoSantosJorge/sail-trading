import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { NextResponse } from "next/server";
import { requireUserApi } from "@/server/auth/guards";
import { aiConfigured, MODELS } from "@/server/ai/client";
import { CHAT_BASE_SYSTEM, PHASE_B_ADDENDA, PRECEDENCE_GUARD } from "@/server/ai/prompts";
import { buildReadTools, type ToolAuditRecord } from "@/server/ai/tools/sdk-tools";
import { buildRenderTools, RENDER_SYSTEM_ADDENDUM } from "@/server/ai/tools/render-tools";
import { buildWriteTools, WRITE_SYSTEM_ADDENDUM } from "@/server/ai/tools/write-tools";
import { ACTION_SYSTEM_ADDENDUM, buildActionTools } from "@/server/ai/tools/action-tools";
import { generateThreadTitle } from "@/server/ai/thread-title";
import { updateThreadSummary } from "@/server/ai/thread-summary";
import {
  buildFallbackUIMessage,
  extractApprovalResponses,
  persistAssistantUIMessage,
  prepareApprovalResumeTurn,
  prepareUITurn,
} from "@/server/chat/turns";

export const runtime = "nodejs";
export const maxDuration = 120;

// Byte-stable across every request → the Anthropic prompt cache holds.
const STABLE_SYSTEM = [
  CHAT_BASE_SYSTEM,
  WRITE_SYSTEM_ADDENDUM,
  RENDER_SYSTEM_ADDENDUM,
  PHASE_B_ADDENDA,
  ACTION_SYSTEM_ADDENDUM,
  PRECEDENCE_GUARD,
].join("\n\n");

interface StreamBody {
  threadId?: string;
  messages?: UIMessage[];
}

export async function POST(req: Request) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  let body: StreamBody;
  try {
    body = (await req.json()) as StreamBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const incoming = body.messages?.at(-1);
  if (!incoming || (incoming.role !== "user" && incoming.role !== "assistant")) {
    return NextResponse.json(
      { error: "Last message must be a user or assistant message" },
      { status: 400 },
    );
  }

  // Two request shapes (see src/server/chat/turns.ts for the approval design):
  // - Normal turn: last message is the new USER message → persist + rebuild
  //   history from the DB.
  // - Approval resume: last message is the client's ASSISTANT message with
  //   `approval-responded` parts → merge only the {approvalId, approved,
  //   reason} triples into the persisted message and resume the same row.
  let prepared: { thread: { id: string }; history: UIMessage[]; resumeMessageId?: string };
  try {
    if (incoming.role === "assistant") {
      if (!body.threadId) {
        return NextResponse.json(
          { error: "threadId is required to resume an approval" },
          { status: 400 },
        );
      }
      const responses = extractApprovalResponses(incoming);
      if (responses.length === 0) {
        return NextResponse.json(
          { error: "No approval responses on the last message" },
          { status: 400 },
        );
      }
      if (!aiConfigured()) {
        return NextResponse.json(
          { error: "Write actions require a configured model" },
          { status: 400 },
        );
      }
      prepared = await prepareApprovalResumeTurn(ctx.userId, body.threadId, responses);
    } else {
      prepared = await prepareUITurn(ctx.userId, {
        threadId: body.threadId,
        message: incoming,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start turn";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const { thread, history, resumeMessageId } = prepared;

  // Graceful degradation when no model is configured: persist a local
  // fallback reply and stream it as a single-message UIMessage stream.
  if (!aiConfigured()) {
    const fallback = buildFallbackUIMessage();
    await persistAssistantUIMessage({
      threadId: thread.id,
      userId: ctx.userId,
      message: fallback,
      model: "fallback",
      audits: [],
    });
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: fallback.id });
        writer.write({ type: "text-start", id: "0" });
        const text = fallback.parts[0];
        writer.write({
          type: "text-delta",
          id: "0",
          delta: text.type === "text" ? text.text : "",
        });
        writer.write({ type: "text-end", id: "0" });
        writer.write({ type: "finish" });
      },
    });
    return createUIMessageStreamResponse({ stream, headers: { "x-thread-id": thread.id } });
  }

  const audits: ToolAuditRecord[] = [];
  const auditSink = (record: ToolAuditRecord) => audits.push(record);

  // The user's latest text — passed to create_strategy for provenance.
  const latestUserText =
    [...history]
      .reverse()
      .find((m) => m.role === "user")
      ?.parts.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n") ?? "";

  const result = streamText({
    model: anthropic(MODELS.chat),
    system: STABLE_SYSTEM,
    messages: await convertToModelMessages(history),
    tools: {
      ...buildReadTools({ userId: ctx.userId, currentThreadId: thread.id }, auditSink),
      ...buildRenderTools(ctx.userId, auditSink),
      // Approval-gated writes; must also be registered on the resume turn —
      // that is when execution happens.
      ...buildWriteTools(
        ctx.userId,
        { promptText: latestUserText, getAudits: () => [...audits] },
        auditSink,
      ),
      // Zero-side-effect proposals: navigate + review; the wallet signature
      // on the trade page is the sole authorization.
      ...buildActionTools(ctx.userId, auditSink),
    },
    stopWhen: stepCountIs(6),
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
    onError: ({ error }) => {
      console.error("[chat] streamText error", error);
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: history,
    headers: { "x-thread-id": thread.id },
    onFinish: async ({ responseMessage }) => {
      try {
        const usage = await result.totalUsage;
        const providerMeta = await result.providerMetadata;
        const anthropicMeta = providerMeta?.anthropic as
          | { cacheCreationInputTokens?: number }
          | undefined;
        await persistAssistantUIMessage({
          threadId: thread.id,
          userId: ctx.userId,
          message: responseMessage,
          model: MODELS.chat,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
          },
          cacheWriteTokens: anthropicMeta?.cacheCreationInputTokens,
          audits,
          replaceMessageId: resumeMessageId,
        });
      } catch (err) {
        console.error("[chat] failed to persist assistant turn", err);
      }

      const assistantText = responseMessage.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      // Rolling summary + one-shot title — sibling try/catch blocks so a
      // failure in either never affects persistence or the stream.
      try {
        await updateThreadSummary({
          threadId: thread.id,
          userId: ctx.userId,
          userText: latestUserText,
          assistantText,
        });
      } catch (err) {
        console.error("[chat] failed to update thread summary", err);
      }

      try {
        const isFirstTurn =
          !resumeMessageId && history.filter((m) => m.role === "user").length === 1;
        if (isFirstTurn) {
          await generateThreadTitle({
            threadId: thread.id,
            userId: ctx.userId,
            userText: latestUserText,
            assistantText,
          });
        }
      } catch (err) {
        console.error("[chat] failed to generate thread title", err);
      }
    },
  });
}
