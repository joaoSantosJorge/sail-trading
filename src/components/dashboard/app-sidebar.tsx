"use client";

import {
  ArrowLeftRight,
  Bot,
  ChevronRight,
  FileText,
  LineChart,
  LogOut,
  MessageSquare,
  Moon,
  Newspaper,
  Plus,
  Sun,
  Trash2,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useAssistantDockOptional } from "@/components/assistant/dock/dock-context";
import { useChatThreads } from "@/components/chat/chat-threads-context";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  NAV_COOKIE_MAX_AGE,
  NAV_GROUP_KEYS,
  NAV_OPEN_GROUPS_COOKIE,
  type NavGroupKey,
} from "./nav-constants";

interface NavLeaf {
  name: string;
  href: string;
}

interface NavGroup {
  key: NavGroupKey;
  name: string;
  icon: typeof FileText;
  items: NavLeaf[];
}

// The five product sections. Wallets/News/Trade are placeholder pages until
// their phases land (B and C); the nav shows the full app shape from day one.
const topNav = [
  { name: "Portfolio", href: "/portfolio", icon: Wallet },
  { name: "Analyse Assets", href: "/assets", icon: LineChart },
  { name: "Market News", href: "/news", icon: Newspaper },
];

const navGroups: NavGroup[] = [
  {
    key: "documents",
    name: "Documents",
    icon: FileText,
    items: [
      { name: "All documents", href: "/documents" },
      { name: "Strategies", href: "/strategies" },
      { name: "New strategy", href: "/strategies/new" },
    ],
  },
];

const tradeItem = { name: "Trade", href: "/trade", icon: ArrowLeftRight };
const botsItem = { name: "Bots", href: "/deployments", icon: Bot };

const MAX_VISIBLE_THREADS = 5;

/**
 * Longest-match-wins active resolution across all hrefs, so nested detail
 * routes like /assets/[id] resolve to their section.
 */
function resolveActiveHref(pathname: string): string | null {
  const candidates = [...topNav, ...navGroups.flatMap((g) => g.items), tradeItem, botsItem]
    .map((i) => i.href)
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function AppSidebar({
  initialOpenGroups,
}: {
  /** From the nav_open_groups cookie; null = cookie absent (open the
   *  active group by default). Read server-side to avoid a flash. */
  initialOpenGroups: NavGroupKey[] | null;
}) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const { isMobile, setOpenMobile, state, setOpen } = useSidebar();
  const dock = useAssistantDockOptional();
  const [showSignOut, setShowSignOut] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [showAllChats, setShowAllChats] = useState(false);
  const { threads, createThread, deleteThread } = useChatThreads();

  const activeThreadId = dock?.activeThreadId ?? null;

  const activeHref = resolveActiveHref(pathname);
  const activeGroupKey =
    navGroups.find((g) => g.items.some((i) => i.href === activeHref))?.key ?? null;

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const keys = initialOpenGroups ?? (activeGroupKey ? [activeGroupKey] : []);
    const single =
      activeGroupKey && keys.includes(activeGroupKey) ? activeGroupKey : keys[0];
    return (single ? { [single]: true } : {}) as Record<string, boolean>;
  });

  function applyOpenGroups(next: Record<string, boolean>) {
    setOpenGroups(next);
    const value = NAV_GROUP_KEYS.filter((k) => next[k]).join(",");
    document.cookie = `${NAV_OPEN_GROUPS_COOKIE}=${value}; path=/; max-age=${NAV_COOKIE_MAX_AGE}`;
  }

  function handleGroupOpenChange(key: NavGroupKey, open: boolean) {
    if (!isMobile && state === "collapsed") {
      setOpen(true);
      applyOpenGroups({ [key]: true });
      return;
    }
    applyOpenGroups(open ? { [key]: true } : {});
  }

  // Auto-open the group containing the page on navigation only.
  useEffect(() => {
    if (!activeGroupKey) return;
    setOpenGroups((prev) => {
      if (prev[activeGroupKey]) return prev;
      const next = { [activeGroupKey]: true };
      const value = NAV_GROUP_KEYS.filter((k) => next[k]).join(",");
      document.cookie = `${NAV_OPEN_GROUPS_COOKIE}=${value}; path=/; max-age=${NAV_COOKIE_MAX_AGE}`;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Close the mobile nav sheet once a link has navigated.
  useEffect(() => {
    setOpenMobile(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  /**
   * Point the docked panel at a conversation and make sure it is visible:
   * open the overlay below the split breakpoint, expand the rail above it,
   * and close the mobile sidebar sheet so the chat is not hidden behind it.
   */
  function openDockThread(threadId: string | null) {
    if (!dock) return;
    dock.selectThread(threadId);
    if (window.matchMedia("(min-width: 1024px)").matches) {
      dock.setCollapsed(false);
    } else {
      dock.setMobileOpen(true);
    }
    if (isMobile) setOpenMobile(false);
  }

  async function handleNewChat() {
    try {
      const created = await createThread();
      openDockThread(created.id);
    } catch {
      openDockThread(null);
    }
  }

  async function confirmDeleteThread() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await deleteThread(id);
      if (activeThreadId === id) {
        dock?.selectThread(null);
      }
    } catch {
      // surfaced via the assistant panel if needed
    }
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b">
        <div className="flex items-center justify-between gap-2 px-1">
          <Link
            href="/assets"
            className="flex items-center gap-2 group-data-[collapsible=icon]:hidden"
          >
            <span className="flex size-8 items-center justify-center rounded-md bg-brand-mark font-mono text-sm font-bold text-background">
              R
            </span>
            <span className="text-lg font-semibold">Research</span>
          </Link>
          <SidebarTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Menu</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {topNav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={item.href === activeHref}
                    tooltip={item.name}
                    render={<Link href={item.href} />}
                  >
                    <item.icon className="h-4 w-4" />
                    <span>{item.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {navGroups.map((group) => (
                <Collapsible
                  key={group.key}
                  open={!!openGroups[group.key]}
                  onOpenChange={(open) => handleGroupOpenChange(group.key, open)}
                  render={<SidebarMenuItem />}
                >
                  <SidebarMenuButton render={<CollapsibleTrigger />} tooltip={group.name}>
                    <group.icon className="h-4 w-4" />
                    <span className="truncate">{group.name}</span>
                    <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[panel-open]/menu-button:rotate-90" />
                  </SidebarMenuButton>
                  <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-starting-style:h-0 data-ending-style:h-0">
                    <SidebarMenuSub>
                      {group.items.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton
                            isActive={item.href === activeHref}
                            render={<Link href={item.href} />}
                          >
                            <span>{item.name}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </Collapsible>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={tradeItem.href === activeHref}
                  tooltip={tradeItem.name}
                  render={<Link href={tradeItem.href} />}
                >
                  <tradeItem.icon className="h-4 w-4" />
                  <span>{tradeItem.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={botsItem.href === activeHref}
                  tooltip={botsItem.name}
                  render={<Link href={botsItem.href} />}
                >
                  <botsItem.icon className="h-4 w-4" />
                  <span>{botsItem.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between pr-1">
            <span>Chats</span>
            <button
              type="button"
              onClick={() => void handleNewChat()}
              className="flex h-5 w-5 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label="New chat"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem className="group-data-[collapsible=icon]:block hidden">
                <SidebarMenuButton tooltip="New chat" onClick={() => void handleNewChat()}>
                  <Plus className="h-4 w-4" />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {(showAllChats ? threads : threads.slice(0, MAX_VISIBLE_THREADS)).map((thread) => {
                const title = thread.title?.trim() || "Untitled chat";
                const isActive = activeThreadId === thread.id;
                return (
                  <SidebarMenuItem
                    key={thread.id}
                    className="group-data-[collapsible=icon]:hidden"
                  >
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={title}
                      onClick={() => openDockThread(thread.id)}
                    >
                      <MessageSquare className="h-4 w-4" />
                      <span>{title}</span>
                    </SidebarMenuButton>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setPendingDeleteId(thread.id);
                      }}
                      className="absolute right-1 top-1.5 flex h-5 w-5 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-destructive group-hover/menu-item:opacity-100 focus-visible:opacity-100"
                      aria-label={`Delete ${title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </SidebarMenuItem>
                );
              })}
              {threads.length > MAX_VISIBLE_THREADS ? (
                <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
                  <SidebarMenuButton
                    className="text-sidebar-foreground/70"
                    onClick={() => setShowAllChats((prev) => !prev)}
                  >
                    <span>{showAllChats ? "Show fewer" : `Show all (${threads.length})`}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              {threads.length === 0 ? (
                <li className="px-2 py-1 text-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
                  No chats yet.
                </li>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Sun className="h-4 w-4 dark:hidden" />
              <Moon className="hidden h-4 w-4 dark:block" />
              <span className="dark:hidden">Dark Mode</span>
              <span className="hidden dark:block">Light Mode</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Sign out" onClick={() => setShowSignOut(true)}>
              <LogOut className="h-4 w-4" />
              <span>Sign Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <Dialog open={showSignOut} onOpenChange={setShowSignOut}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Sign out</DialogTitle>
            <DialogDescription>
              Are you sure you want to sign out of your account?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSignOut(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => signOut({ callbackUrl: "/login" })}>
              Sign Out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete chat</DialogTitle>
            <DialogDescription>
              This permanently removes the chat and its messages.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteThread()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
