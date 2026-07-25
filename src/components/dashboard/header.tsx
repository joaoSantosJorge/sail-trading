"use client";

import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info } from "lucide-react";

export function DashboardHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      {/* Below md the sidebar is an offcanvas sheet with no in-flow trigger. */}
      <SidebarTrigger className="-ml-1 md:hidden" aria-label="Open navigation" />
      <h1 className="min-w-0 truncate text-lg font-semibold">{title}</h1>
      {description && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger className="cursor-help">
              <Info className="h-4 w-4 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-sm">
              {description}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </header>
  );
}
