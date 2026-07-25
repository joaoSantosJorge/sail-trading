"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { createThreadHistoryAdapter } from "./history-adapter";

interface ChatSessionHandle {
  transport: AssistantChatTransport<UIMessage>;
  setOnThreadCreated(callback: (threadId: string) => void): void;
}

/**
 * Builds the chat transport for one runtime session. The current thread id
 * lives in closure state so that a brand-new thread can adopt the
 * server-assigned id from the `x-thread-id` response header without tearing
 * down the in-flight stream: the first send carries no threadId, follow-up
 * sends include the adopted one in the request body.
 */
function createChatSession(initialThreadId: string | null): ChatSessionHandle {
  let threadId = initialThreadId;
  let onThreadCreated: (threadId: string) => void = () => {};

  const transport = new AssistantChatTransport<UIMessage>({
    api: "/api/v1/chat/stream",
    // Resolved per request, so it sees the adopted thread id.
    body: () => (threadId ? { threadId } : {}),
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const assignedThreadId = response.headers.get("x-thread-id");
      if (assignedThreadId && assignedThreadId !== threadId) {
        threadId = assignedThreadId;
        onThreadCreated(assignedThreadId);
      }
      return response;
    },
  });

  return {
    transport,
    setOnThreadCreated(callback) {
      onThreadCreated = callback;
    },
  };
}

interface AssistantRuntimeProviderV2Props {
  /** Thread to continue, or null to start a new thread on first send. */
  threadId: string | null;
  /** Persisted history for `threadId`, pre-fetched by the shell. */
  initialMessages: UIMessage[];
  /**
   * Fired when the server creates a thread for this session (the
   * `x-thread-id` response header differs from the known thread id).
   */
  onThreadCreated: (threadId: string) => void;
  children: ReactNode;
}

/**
 * Mounts the assistant-ui runtime over POST /api/v1/chat/stream. The shell
 * remounts this component (via `key`) when the user switches threads, so
 * `threadId` and `initialMessages` are read once, on mount.
 */
export function AssistantRuntimeProviderV2({
  threadId,
  initialMessages,
  onThreadCreated,
  children,
}: AssistantRuntimeProviderV2Props) {
  const [session] = useState(() => createChatSession(threadId));

  useEffect(() => {
    session.setOnThreadCreated(onThreadCreated);
  }, [session, onThreadCreated]);

  const history = useMemo(
    () => createThreadHistoryAdapter(threadId),
    [threadId]
  );

  const runtime = useChatRuntime({
    transport: session.transport,
    messages: initialMessages,
    adapters: { history },
    // Write-tool approvals: once the user has answered every approval
    // request on the last assistant message, automatically re-POST so the
    // server resumes the run and executes the approved tool calls.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
