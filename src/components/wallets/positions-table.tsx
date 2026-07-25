"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { chainName } from "@/lib/explorers";
import { foldSymbol } from "@/lib/portfolio/symbols";
import { formatBtc, formatUsd, usdToBtc } from "@/lib/portfolio/value";
import { cn } from "@/lib/utils";
import type { Position } from "@/server/portfolio/types";
import { SymbolLabel } from "./symbol-label";
import { TokenAvatar } from "./token-avatar";

const PREVIEW_ROWS = 15;

/**
 * Long on-chain decimals → readable: 6 significant digits, compact above 1e9,
 * scientific above 1e15 (spam tokens mint near-uint256 balances).
 */
function formatBalance(balance: string): string {
  const n = Number(balance);
  if (!Number.isFinite(n)) return balance;
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e15) return n.toExponential(2);
  if (Math.abs(n) >= 1e9) {
    return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  }
  return n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

export function PositionsTable({
  positions,
  btcUsd,
}: {
  positions: Position[];
  btcUsd: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? positions : positions.slice(0, PREVIEW_ROWS);
  const walletTotal = positions.reduce((a, p) => a + (p.valueUsd ?? 0), 0);

  return (
    <div className="flex flex-col gap-2">
      <div className={cn("rounded-md border border-border/50", expanded && "max-h-[480px] overflow-auto")}>
        <Table className="text-xs [&_td]:py-2">
          <TableHeader>
            <TableRow className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Token</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Chain</TableHead>
              <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                Balance
              </TableHead>
              <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                Price
              </TableHead>
              <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                Value (USD)
              </TableHead>
              <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                Value (BTC)
              </TableHead>
              <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                Share
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p, i) => {
              const share = walletTotal > 0 && p.valueUsd !== null ? p.valueUsd / walletTotal : null;
              return (
                <TableRow key={i} className="hover:bg-muted/40">
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <TokenAvatar symbol={foldSymbol(p.symbol).folded} seed={p.tokenAddress} />
                      <div className="min-w-0">
                        <SymbolLabel symbol={p.symbol} className="text-sm font-medium" />
                        <div className="max-w-[120px] truncate text-xs text-muted-foreground">
                          {p.name}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      {chainName(p.chainId)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-figures">
                    {formatBalance(p.balance)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-figures">
                    <span className="inline-flex items-center gap-1">
                      {formatUsd(p.priceUsd)}
                      {p.priceSource === "coingecko" && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  aria-label="Priced via CoinGecko contract lookup"
                                  className="size-1.5 rounded-full bg-warning"
                                />
                              }
                            />
                            <TooltipContent side="top">
                              Priced via CoinGecko contract lookup (DEX/long-tail)
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium tabular-figures">
                    {formatUsd(p.valueUsd)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-figures text-muted-foreground">
                    {formatBtc(usdToBtc(p.valueUsd, btcUsd))}
                  </TableCell>
                  <TableCell className="text-right">
                    {share !== null ? (
                      <div className="inline-flex flex-col items-end gap-1">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {(share * 100).toFixed(1)}%
                        </span>
                        <span className="block h-[3px] w-10 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full bg-chart-1/60"
                            style={{ width: `${Math.max(2, share * 100)}%` }}
                          />
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {positions.length > PREVIEW_ROWS && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : `Show all ${positions.length} positions`}
        </Button>
      )}
      {positions.some((p) => p.priceSource === "coingecko") && (
        <p className="text-right text-xs text-muted-foreground">
          Dotted prices come from a CoinGecko contract lookup — thin-liquidity tokens may not be
          sellable at this price.
        </p>
      )}
    </div>
  );
}
