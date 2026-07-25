import type {
  ExportedMessageRepository,
  GenericThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  MessageFormatRepository,
  ThreadHistoryAdapter,
} from "@assistant-ui/react";
import type { UIMessage } from "ai";

/** Row shape returned by GET /api/v1/chat/threads/{threadId}/messages. */
interface ChatMessageRow {
  id: string;
  role: string;
  content: string;
  parts?: unknown;
}

/**
 * Decodes persisted chat rows into AI SDK UIMessages. Rows written before the
 * `parts` column existed (parts NULL) are synthesized as a single text part;
 * system/tool rows are dropped (the v2 stream persists user/assistant only).
 */
export function rowsToUIMessages(rows: ChatMessageRow[]): UIMessage[] {
  return rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant",
      parts:
        Array.isArray(row.parts) && row.parts.length > 0
          ? (row.parts as UIMessage["parts"])
          : [{ type: "text" as const, text: row.content }],
    }));
}

export async function fetchThreadUIMessages(
  threadId: string
): Promise<UIMessage[]> {
  const response = await fetch(
    `/api/v1/chat/threads/${threadId}/messages?limit=120`,
    { method: "GET", cache: "no-store" }
  );

  const payload = (await response.json().catch(() => null)) as {
    data?: { messages?: ChatMessageRow[] };
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error || "Failed to load chat history");
  }

  return rowsToUIMessages(payload?.data?.messages ?? []);
}

/**
 * Load-only ThreadHistoryAdapter for the v2 runtime. `append` is a no-op
 * because the server persists both sides of every turn authoritatively
 * (POST /api/v1/chat/stream stores the user message up front and the
 * assistant message in the stream's onFinish).
 *
 * Note: with the installed @assistant-ui/react-ai-sdk (1.3.33), the runtime
 * only invokes `load()` for threads whose thread-list item has a `remoteId`,
 * which never happens with the default in-memory thread list at mount time.
 * The shell therefore also pre-fetches history via `fetchThreadUIMessages`
 * and passes it as the runtime's initial `messages`; this adapter keeps the
 * documented integration point wired for when a remote thread list is added.
 */
export function createThreadHistoryAdapter(
  threadId: string | null
): ThreadHistoryAdapter {
  return {
    async load(): Promise<ExportedMessageRepository> {
      // UIMessage-formatted loading goes through `withFormat` below.
      return { messages: [] };
    },

    async append(): Promise<void> {
      // No-op: the server persists messages authoritatively.
    },

    withFormat<TMessage, TStorageFormat extends Record<string, unknown>>(
      formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>
    ): GenericThreadHistoryAdapter<TMessage> {
      return {
        async load(): Promise<MessageFormatRepository<TMessage>> {
          if (!threadId) return { messages: [] };

          const uiMessages = await fetchThreadUIMessages(threadId);

          // Persisted history is a linear conversation: chain each message
          // to the previous one and point the head at the last message.
          let parentId: string | null = null;
          const messages: MessageFormatItem<TMessage>[] = uiMessages.map(
            (uiMessage) => {
              const { id, ...content } = uiMessage;
              const item = formatAdapter.decode({
                id,
                parent_id: parentId,
                format: formatAdapter.format,
                content: content as unknown as TStorageFormat,
              });
              parentId = formatAdapter.getId(item.message);
              return item;
            }
          );

          return { headId: parentId, messages };
        },

        async append(): Promise<void> {
          // No-op: the server persists messages authoritatively.
        },
      };
    },
  };
}
