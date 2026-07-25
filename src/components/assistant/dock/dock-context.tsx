"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import {
  DOCK_COLLAPSED_COOKIE,
  DOCK_COOKIE_MAX_AGE,
  DOCK_THREAD_COOKIE,
} from "./dock-constants";

export function writeDockCookie(name: string, value: string | null) {
  if (value === null) {
    document.cookie = `${name}=; path=/; max-age=0`;
  } else {
    document.cookie = `${name}=${value}; path=/; max-age=${DOCK_COOKIE_MAX_AGE}`;
  }
}

export interface AssistantDockContextValue {
  /** Conversation bound to the docked runtime; null = fresh chat. */
  activeThreadId: string | null;
  /** Switch conversations — the dock panel remounts its runtime. */
  selectThread: (threadId: string | null) => void;
  /**
   * Record the server-assigned id of a freshly created thread (x-thread-id
   * adoption). State-wise identical to selectThread; callers must update the
   * panel session's activeThreadId in the same batch so no remount happens.
   */
  adoptThreadId: (threadId: string) => void;
  /** Desktop: dock collapsed to the thin rail (runtime stays mounted). */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** Below lg: chat shown as a full-screen overlay. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  /**
   * "Ask AI" from anywhere: expands the dock and queues a prompt that the
   * thread view appends as a user message once the runtime is ready.
   */
  sendPrompt: (text: string) => void;
  pendingPrompt: string | null;
  consumePendingPrompt: () => void;
}

const AssistantDockContext = createContext<AssistantDockContextValue | null>(
  null
);

export function useAssistantDock(): AssistantDockContextValue {
  const ctx = useContext(AssistantDockContext);
  if (!ctx) {
    throw new Error(
      "useAssistantDock must be used within AssistantDockProvider"
    );
  }
  return ctx;
}

/** Safe variant for components that also render without the dock (sidebar). */
export function useAssistantDockOptional(): AssistantDockContextValue | null {
  return useContext(AssistantDockContext);
}

export function AssistantDockProvider({
  initialThreadId,
  initialCollapsed,
  children,
}: {
  initialThreadId: string | null;
  initialCollapsed: boolean;
  children: React.ReactNode;
}) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    initialThreadId
  );
  const [collapsed, setCollapsedState] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const selectThread = useCallback((threadId: string | null) => {
    setActiveThreadId(threadId);
    writeDockCookie(DOCK_THREAD_COOKIE, threadId);
  }, []);

  const adoptThreadId = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    writeDockCookie(DOCK_THREAD_COOKIE, threadId);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writeDockCookie(DOCK_COLLAPSED_COOKIE, String(next));
  }, []);

  const sendPrompt = useCallback(
    (text: string) => {
      setPendingPrompt(text);
      if (window.matchMedia("(min-width: 1024px)").matches) {
        setCollapsed(false);
      } else {
        setMobileOpen(true);
      }
    },
    [setCollapsed],
  );

  const consumePendingPrompt = useCallback(() => setPendingPrompt(null), []);

  const value = useMemo<AssistantDockContextValue>(
    () => ({
      activeThreadId,
      selectThread,
      adoptThreadId,
      collapsed,
      setCollapsed,
      mobileOpen,
      setMobileOpen,
      sendPrompt,
      pendingPrompt,
      consumePendingPrompt,
    }),
    [
      activeThreadId,
      selectThread,
      adoptThreadId,
      collapsed,
      setCollapsed,
      mobileOpen,
      sendPrompt,
      pendingPrompt,
      consumePendingPrompt,
    ]
  );

  return (
    <AssistantDockContext.Provider value={value}>
      {children}
    </AssistantDockContext.Provider>
  );
}
