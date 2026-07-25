import { cookies } from "next/headers";
import { AssistantDockProvider } from "@/components/assistant/dock/dock-context";
import {
  DOCK_COLLAPSED_COOKIE,
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_THREAD_COOKIE,
  DOCK_WIDTH_COOKIE,
} from "@/components/assistant/dock/dock-constants";
import { DashboardSplit } from "@/components/assistant/dock/dashboard-split";
import { ChatThreadsProvider } from "@/components/chat/chat-threads-context";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import {
  NAV_OPEN_GROUPS_COOKIE,
  parseNavOpenGroups,
} from "@/components/dashboard/nav-constants";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppTopBar } from "@/components/web3/app-top-bar";
import { Web3Provider } from "@/components/web3/web3-provider";
import { requireUserPage } from "@/server/auth/guards";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireUserPage();

  // Dock state is cookie-persisted so the server renders the exact split
  // (width/collapsed/thread) and hydration causes no layout flash.
  const cookieStore = await cookies();
  const dockThreadId = cookieStore.get(DOCK_THREAD_COOKIE)?.value || null;
  const dockCollapsed = cookieStore.get(DOCK_COLLAPSED_COOKIE)?.value === "true";
  const widthRaw = Number(cookieStore.get(DOCK_WIDTH_COOKIE)?.value);
  const dockWidth = Number.isFinite(widthRaw)
    ? Math.min(Math.max(widthRaw, DOCK_MIN_WIDTH), DOCK_MAX_WIDTH)
    : DOCK_DEFAULT_WIDTH;

  return (
    <ChatThreadsProvider>
      <SidebarProvider>
        {/* The dock provider must wrap the sidebar too: the chat-history list
            lives in the sidebar and calls dock.selectThread() to switch
            conversations. */}
        <AssistantDockProvider initialThreadId={dockThreadId} initialCollapsed={dockCollapsed}>
          <AppSidebar
            initialOpenGroups={parseNavOpenGroups(
              cookieStore.get(NAV_OPEN_GROUPS_COOKIE)?.value,
            )}
          />
          <SidebarInset className="h-svh min-w-0 overflow-hidden">
            <DashboardSplit initialWidth={dockWidth}>
              <Web3Provider>
                <AppTopBar />
                {children}
              </Web3Provider>
            </DashboardSplit>
          </SidebarInset>
        </AssistantDockProvider>
      </SidebarProvider>
    </ChatThreadsProvider>
  );
}
