"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRightClose, Plus, X } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { useChatThreads } from "@/components/chat/chat-threads-context";
import { AssistantRuntimeProviderV2 } from "@/components/assistant/v2/runtime-provider";
import { ThreadView } from "@/components/assistant/v2/thread-view";
import { fetchThreadUIMessages } from "@/components/assistant/v2/history-adapter";
import { useAssistantDock } from "./dock-context";

interface RuntimeSession {
  /** Bumped to remount the runtime when the user switches to another thread. */
  key: number;
  /** Thread the session started on; null starts a new thread on first send. */
  threadId: string | null;
  /**
   * Thread id the mounted runtime is currently bound to. Equals `threadId`
   * until a new thread adopts the server-assigned id from `x-thread-id`.
   * Used to tell "dock state caught up with adoption" apart from real
   * navigation between threads.
   */
  activeThreadId: string | null;
}

interface HistoryState {
  key: number;
  messages: UIMessage[];
}

/**
 * The always-docked assistant panel. Same runtime-session mechanic as the
 * old /assistant shell (history pre-fetched before the runtime mounts, one
 * session per conversation), but thread selection comes from the dock
 * context instead of the ?thread= URL param, so the panel survives page
 * navigation with streams intact.
 */
export function AssistantDockPanel() {
  const dock = useAssistantDock();
  const { selectThread, adoptThreadId } = dock;
  const { refresh: refreshThreads, threads } = useChatThreads();

  const [error, setError] = useState<string | null>(null);

  // One runtime session per conversation, with history pre-fetched before
  // the runtime mounts (the runtime takes it as initial messages).
  const [session, setSession] = useState<RuntimeSession>(() => ({
    key: 0,
    threadId: dock.activeThreadId,
    activeThreadId: dock.activeThreadId,
  }));
  const [history, setHistory] = useState<HistoryState | null>(() =>
    dock.activeThreadId ? null : { key: 0, messages: [] }
  );

  // Thread restored from the persistence cookie at mount; if its history
  // fetch fails (deleted elsewhere → stale cookie), reset silently.
  const restoredThreadIdRef = useRef(dock.activeThreadId);

  // Render-phase adjustment: the dock points at a different conversation
  // than the mounted runtime, so start a new session. Adoption of a
  // server-created id updates session.activeThreadId first (see
  // handleThreadCreated), so the dock catching up does not remount.
  if (dock.activeThreadId !== session.activeThreadId) {
    const nextKey = session.key + 1;
    setSession({
      key: nextKey,
      threadId: dock.activeThreadId,
      activeThreadId: dock.activeThreadId,
    });
    setHistory(dock.activeThreadId ? null : { key: nextKey, messages: [] });
    setError(null);
  }

  useEffect(() => {
    const { key, threadId } = session;
    if (!threadId) return; // new thread: empty history was set with the session

    let cancelled = false;

    fetchThreadUIMessages(threadId)
      .then((messages) => {
        if (!cancelled) setHistory({ key, messages });
      })
      .catch((err) => {
        if (cancelled) return;
        if (key === 0 && threadId === restoredThreadIdRef.current) {
          // Stale cookie: fall back to a fresh chat without surfacing an error.
          selectThread(null);
          return;
        }
        const message =
          err instanceof Error ? err.message : "Failed to load messages";
        setError(message);
        setHistory({ key, messages: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [session, selectThread]);

  const handleThreadCreated = useCallback(
    (threadId: string) => {
      // Mark the new id as active on the session before the dock state so
      // the render-phase adjustment above does not remount mid-stream (both
      // updates land in the same batch).
      setSession((prev) => ({ ...prev, activeThreadId: threadId }));
      adoptThreadId(threadId);
      void refreshThreads();
    },
    [adoptThreadId, refreshThreads]
  );

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === dock.activeThreadId) ?? null,
    [threads, dock.activeThreadId]
  );

  const sessionReady = history !== null && history.key === session.key;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {selectedThread?.title?.trim() || "Chat"}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New chat"
          onClick={() => selectThread(null)}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Collapse chat panel"
          className="hidden lg:inline-flex"
          onClick={() => dock.setCollapsed(true)}
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close chat"
          className="lg:hidden"
          onClick={() => dock.setMobileOpen(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {sessionReady ? (
        <AssistantRuntimeProviderV2
          key={session.key}
          threadId={session.threadId}
          initialMessages={history.messages}
          onThreadCreated={handleThreadCreated}
        >
          <ThreadView />
        </AssistantRuntimeProviderV2>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Loading conversation...
        </div>
      )}

    </div>
  );
}
