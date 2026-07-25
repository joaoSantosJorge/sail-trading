"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { describeSuspicious, foldSymbol } from "@/lib/portfolio/symbols";
import { cn } from "@/lib/utils";

/**
 * Token symbol with homoglyph defense: look-alike characters are folded to
 * their Latin shapes for display, and a red "fake" badge with an explanatory
 * tooltip marks symbols that used them (scam airdrops impersonating real
 * tokens).
 */
export function SymbolLabel({ symbol, className }: { symbol: string | null; className?: string }) {
  if (!symbol) return <span className={className}>—</span>;
  const { folded, suspicious } = foldSymbol(symbol);
  if (!suspicious) return <span className={className}>{folded}</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {folded}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge className="border-transparent bg-destructive/10 px-1.5 text-[10px] font-semibold text-destructive">
                fake
              </Badge>
            }
          />
          <TooltipContent side="top" className="max-w-72">
            {describeSuspicious(symbol)}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
