"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export interface ChatThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface ChatThreadsContextValue {
  threads: ChatThreadSummary[];
  loading: boolean;
  refresh: () => Promise<ChatThreadSummary[]>;
  createThread: (title?: string) => Promise<ChatThreadSummary>;
  deleteThread: (threadId: string) => Promise<void>;
}

const ChatThreadsContext = createContext<ChatThreadsContextValue | null>(null);

export function useChatThreads() {
  const ctx = useContext(ChatThreadsContext);
  if (!ctx) {
    throw new Error("useChatThreads must be used within ChatThreadsProvider");
  }
  return ctx;
}

async function fetchThreads(): Promise<ChatThreadSummary[]> {
  const response = await fetch("/api/v1/chat/threads?limit=25", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as { data?: ChatThreadSummary[] };
  return payload.data ?? [];
}

export function ChatThreadsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchThreads();
      setThreads(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, []);

  const createThread = useCallback(
    async (title = "New Chat") => {
      const response = await fetch("/api/v1/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const payload = (await response.json()) as {
        data?: ChatThreadSummary;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || "Failed to create chat");
      }
      await refresh();
      return payload.data;
    },
    [refresh]
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      const response = await fetch(`/api/v1/chat/threads/${threadId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error || "Failed to delete chat");
      }
      await refresh();
    },
    [refresh]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ChatThreadsContext.Provider
      value={{ threads, loading, refresh, createThread, deleteThread }}
    >
      {children}
    </ChatThreadsContext.Provider>
  );
}
