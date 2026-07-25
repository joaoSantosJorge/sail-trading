"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/portfolio/value";
import { cn } from "@/lib/utils";
import type { PerpPosition } from "@/server/portfolio/types";
import { TokenAvatar } from "./token-avatar";

const px = (v: number | null) =>
  v === null
    ? "—"
    : v.toLocaleString("en-US", { maximumSignificantDigits: 6 });

export function PerpPositionsTable({ perps }: { perps: PerpPosition[] }) {
  return (
    <div className="rounded-md border border-border/50">
      <Table className="text-xs [&_td]:py-2">
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Market</TableHead>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Side</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Size</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Notional</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Entry</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Liq. price</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Lev.</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Margin</TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">uPnL</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {perps.map((p, i) => (
            <TableRow key={i} className="hover:bg-muted/40">
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <TokenAvatar symbol={p.coin} seed={null} />
                  <span className="text-sm font-medium">{p.coin}-PERP</span>
                </div>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs uppercase",
                    p.side === "long" ? "text-success" : "text-destructive",
                  )}
                >
                  {p.side}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono tabular-figures">
                {p.size.toLocaleString("en-US", { maximumSignificantDigits: 6 })}
              </TableCell>
              <TableCell className="text-right font-mono tabular-figures">
                {formatUsd(p.notionalUsd)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-figures">{px(p.entryPx)}</TableCell>
              <TableCell className="text-right font-mono tabular-figures">{px(p.liquidationPx)}</TableCell>
              <TableCell className="text-right font-mono tabular-figures">
                {p.leverage}× <span className="text-muted-foreground">{p.marginMode}</span>
              </TableCell>
              <TableCell className="text-right font-mono tabular-figures">
                {formatUsd(p.marginUsed)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono font-medium tabular-figures",
                  p.unrealizedPnl > 0 ? "text-success" : p.unrealizedPnl < 0 ? "text-destructive" : "",
                )}
              >
                {p.unrealizedPnl >= 0 ? "+" : ""}
                {formatUsd(p.unrealizedPnl)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
