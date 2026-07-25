import type { UIMessage } from "ai";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { chatMessages, chatThreads, chatToolCalls } from "@/server/db/schema";
import { computeCostCents } from "@/server/ai/pricing";
import type { ToolAuditRecord } from "@/server/ai/tools/sdk-tools";
import { createChatThread, getThreadForUser, purgeExpiredThreads } from "./service";

/**
 * Chat turn persistence (mirrors the tracking app's chat-v2-service):
 * chat_messages stores the full UIMessage `parts` array alongside the
 * flattened `content` text that retention/titles rely on. chat_tool_calls is
 * the server-side audit log, written from tool execution — never from client
 * input. History is always rebuilt from the DB; the client's copy is never
 * trusted for the model call.
 */

/**
 * Server-side gate on incoming user-message parts: text parts only. No
 * attachments in this app (v1); base64/file/unknown part types are dropped.
 */
export function sanitizeIncomingUserParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts.filter((part) => part.type === "text");
}

function flattenParts(message: UIMessage): string {
  return message.parts
    .filter(
      (p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function trimTitle(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

/** Rows → UIMessages. Rows with parts NULL become a single text part. */
export async function loadThreadUIMessages(
  userId: string,
  threadId: string,
): Promise<UIMessage[]> {
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      parts: chatMessages.parts,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId)))
    .orderBy(asc(chatMessages.createdAt));

  return rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      id: r.id,
      role: r.role as "user" | "assistant",
      parts: (r.parts as UIMessage["parts"] | null) ?? [{ type: "text", text: r.content }],
    }));
}

export interface PreparedUITurn {
  thread: typeof chatThreads.$inferSelect;
  history: UIMessage[];
}

// ---------------------------------------------------------------------------
// Tool-approval round-trip (AI SDK `needsApproval` tools).
//
// 1. Model calls a write tool → streamText emits `tool-approval-request` and
//    finishes; the assistant message persists with the part in state
//    `approval-requested`.
// 2. User answers → client flips the part to `approval-responded` and
//    re-POSTs (sendAutomaticallyWhen). The LAST message in body.messages is
//    that ASSISTANT message.
// 3. We extract only {approvalId, approved, reason} and merge them into the
//    PERSISTED parts — only genuinely pending parts can be flipped, so a
//    client cannot forge approvals for calls that never happened.
// 4. Rebuilt history now converts cleanly; streamText executes approved calls.
// 5. The response stream continues the same assistant message, so persistence
//    UPDATES that row (replaceMessageId) instead of inserting a duplicate.
// ---------------------------------------------------------------------------

export interface ApprovalResponseInput {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

interface ApprovalToolPart {
  type: string;
  state?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

function isPendingApprovalPart(part: unknown): part is ApprovalToolPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as ApprovalToolPart;
  return (
    typeof p.type === "string" &&
    (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
    p.state === "approval-requested" &&
    typeof p.approval?.id === "string"
  );
}

/** Extract approval responses from the client's last assistant message. */
export function extractApprovalResponses(message: UIMessage): ApprovalResponseInput[] {
  const responses: ApprovalResponseInput[] = [];
  for (const part of message.parts) {
    const p = part as unknown as ApprovalToolPart;
    if (
      typeof p.type === "string" &&
      (p.type.startsWith("tool-") || p.type === "dynamic-tool") &&
      p.state === "approval-responded" &&
      typeof p.approval?.id === "string" &&
      typeof p.approval.approved === "boolean"
    ) {
      responses.push({
        approvalId: p.approval.id,
        approved: p.approval.approved,
        reason:
          typeof p.approval.reason === "string" ? p.approval.reason.slice(0, 500) : undefined,
      });
    }
  }
  return responses;
}

async function getLastThreadMessage(userId: string, threadId: string) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Merge the user's approval responses into the persisted assistant message,
 * then rebuild history so the model call resumes with the approvals visible.
 */
export async function prepareApprovalResumeTurn(
  userId: string,
  threadId: string,
  responses: ApprovalResponseInput[],
): Promise<PreparedUITurn & { resumeMessageId: string }> {
  const thread = await getThreadForUser(userId, threadId);
  if (!thread) throw new Error("Chat thread not found");

  const last = await getLastThreadMessage(userId, threadId);
  if (!last || last.role !== "assistant" || !last.parts) {
    throw new Error("No assistant message awaiting approval");
  }

  const byId = new Map(responses.map((r) => [r.approvalId, r]));
  let matched = 0;
  const parts = (last.parts as unknown[]).map((part) => {
    if (!isPendingApprovalPart(part)) return part;
    const response = byId.get(part.approval!.id);
    if (!response) return part;
    matched += 1;
    return {
      ...part,
      state: "approval-responded",
      approval: {
        id: response.approvalId,
        approved: response.approved,
        ...(response.reason ? { reason: response.reason } : {}),
      },
    };
  });

  if (matched === 0) {
    throw new Error("No matching pending approval on this thread");
  }

  await db
    .update(chatMessages)
    .set({ parts: parts as UIMessage["parts"] })
    .where(eq(chatMessages.id, last.id));

  const history = await loadThreadUIMessages(userId, threadId);
  return { thread, history, resumeMessageId: last.id };
}

/**
 * When the user ignores a pending approval and keeps chatting, the persisted
 * assistant message still has `approval-requested` parts — which
 * convertToModelMessages rejects. Mark them denied so history stays
 * convertible. Called at the start of every normal user turn.
 */
export async function expireStalePendingApprovals(
  userId: string,
  threadId: string,
): Promise<void> {
  const last = await getLastThreadMessage(userId, threadId);
  if (!last || last.role !== "assistant" || !last.parts) return;

  let changed = false;
  const parts = (last.parts as unknown[]).map((part) => {
    if (!isPendingApprovalPart(part)) return part;
    changed = true;
    return {
      ...part,
      state: "output-denied",
      approval: {
        id: part.approval!.id,
        approved: false,
        reason: "The user continued the conversation without approving.",
      },
    };
  });

  if (!changed) return;
  await db
    .update(chatMessages)
    .set({ parts: parts as UIMessage["parts"] })
    .where(eq(chatMessages.id, last.id));
}

/**
 * Start a turn: purge expired threads, sanitize the incoming message,
 * resolve/create the thread, persist the user row, and return the full
 * server-derived history.
 */
export async function prepareUITurn(
  userId: string,
  input: { threadId?: string; message: UIMessage },
): Promise<PreparedUITurn> {
  await purgeExpiredThreads(userId);

  const parts = sanitizeIncomingUserParts(input.message.parts);
  const sanitized: UIMessage = { ...input.message, parts };

  const content = flattenParts(sanitized);
  if (!content) throw new Error("Message cannot be empty");

  const existing = input.threadId ? await getThreadForUser(userId, input.threadId) : null;
  if (input.threadId && !existing) {
    throw new Error("Chat thread not found");
  }
  const thread = existing ?? (await createChatThread(userId, trimTitle(content)));

  if (existing) {
    await expireStalePendingApprovals(userId, thread.id);
  }

  await db.insert(chatMessages).values({
    threadId: thread.id,
    userId,
    role: "user",
    content,
    parts: sanitized.parts,
  });

  const history = await loadThreadUIMessages(userId, thread.id);
  return { thread, history };
}

export interface PersistAssistantTurnInput {
  threadId: string;
  userId: string;
  message: UIMessage;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  cacheWriteTokens?: number;
  audits: ToolAuditRecord[];
  /** Approval-resume turns update the existing assistant row in place. */
  replaceMessageId?: string;
}

export async function persistAssistantUIMessage(input: PersistAssistantTurnInput) {
  const costCents = computeCostCents(input.model, {
    inputTokens: input.usage?.inputTokens,
    outputTokens: input.usage?.outputTokens,
    cacheReadTokens: input.usage?.cachedInputTokens,
    cacheWriteTokens: input.cacheWriteTokens,
  });

  let row: typeof chatMessages.$inferSelect;
  if (input.replaceMessageId) {
    const existingRows = await db
      .select()
      .from(chatMessages)
      .where(
        and(eq(chatMessages.id, input.replaceMessageId), eq(chatMessages.userId, input.userId)),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error("Assistant message to update not found");
    const [updated] = await db
      .update(chatMessages)
      .set({
        content: flattenParts(input.message),
        parts: input.message.parts,
        context: { model: input.model, generatedAt: new Date().toISOString() },
        inputTokens: (existing.inputTokens ?? 0) + (input.usage?.inputTokens ?? 0) || null,
        outputTokens: (existing.outputTokens ?? 0) + (input.usage?.outputTokens ?? 0) || null,
        costCents: (existing.costCents ?? 0) + costCents,
      })
      .where(eq(chatMessages.id, existing.id))
      .returning();
    row = updated;
  } else {
    const [inserted] = await db
      .insert(chatMessages)
      .values({
        threadId: input.threadId,
        userId: input.userId,
        role: "assistant",
        content: flattenParts(input.message),
        parts: input.message.parts,
        context: { model: input.model, generatedAt: new Date().toISOString() },
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        costCents,
      })
      .returning();
    row = inserted;
  }

  if (input.audits.length > 0) {
    await db.insert(chatToolCalls).values(
      input.audits.map((a) => ({
        messageId: row.id,
        threadId: input.threadId,
        userId: input.userId,
        toolName: a.name,
        input: (a.input ?? {}) as Record<string, unknown>,
        output: (a.error ? { error: a.error } : (a.output ?? {})) as Record<string, unknown>,
        status: a.error ? "failed" : "completed",
      })),
    );
  }

  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, input.threadId));

  return row;
}

/** Local fallback turn when ANTHROPIC_API_KEY is unset. */
export function buildFallbackUIMessage(): UIMessage {
  return {
    id: `fallback-${crypto.randomUUID()}`,
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "The AI assistant is not configured yet. Add `ANTHROPIC_API_KEY` to `.env.local` and restart the server to enable chat. Your message was saved to this thread.",
      },
    ],
  };
}
