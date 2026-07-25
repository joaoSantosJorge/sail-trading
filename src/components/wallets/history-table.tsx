"use client";

import { ArrowDownLeft, ArrowUpRight, ExternalLink, Repeat, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { chainName, txUrl } from "@/lib/explorers";
import { cn, shortAddress } from "@/lib/utils";
import type { HistoryItem } from "@/server/portfolio/types";
import { SymbolLabel } from "./symbol-label";
import { TagEditor } from "./tag-editor";

const PAGE = 50;

type TypeFilter = "all" | "transfer" | "trade";
type DirectionFilter = "all" | "in" | "out";

type Filters = {
  type: TypeFilter;
  direction: DirectionFilter;
  asset: string;
  tag: string | null;
};

const NO_FILTERS: Filters = { type: "all", direction: "all", asset: "", tag: null };

function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.direction !== "all") params.set("direction", filters.direction);
  if (filters.asset.trim()) params.set("asset", filters.asset.trim());
  if (filters.tag) params.set("tag", filters.tag);
  return params;
}

/**
 * Long on-chain decimals → readable: 6 significant digits, compact above 1e9,
 * scientific above 1e15 (spam tokens mint near-uint256 amounts).
 */
function formatAmount(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e15) return n.toExponential(2);
  if (Math.abs(n) >= 1e9) {
    return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  }
  return n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

function TypeBadge({ item }: { item: HistoryItem }) {
  if (item.type === "trade") {
    const failed = item.status === "failed";
    return (
      <Badge
        variant="outline"
        className={cn(
          "border-transparent bg-primary/10 text-primary",
          failed && "bg-destructive/10 text-destructive",
        )}
      >
        <Repeat className="size-3.5" />
        trade{item.status ? ` · ${item.status}` : ""}
      </Badge>
    );
  }
  if (item.direction === "in") {
    return (
      <Badge variant="outline" className="border-transparent bg-success/10 text-success">
        <ArrowDownLeft className="size-3.5" /> in
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
      <ArrowUpRight className="size-3.5" /> {item.direction}
    </Badge>
  );
}

export function HistoryTable({
  address,
  initialItems,
  synced,
}: {
  address: string;
  initialItems: HistoryItem[];
  synced: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [assetDraft, setAssetDraft] = useState("");
  const [distinctTags, setDistinctTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // A page shorter than PAGE means the (filtered) history is exhausted.
  const [done, setDone] = useState(initialItems.length < PAGE);

  const hasFilters =
    filters.type !== "all" || filters.direction !== "all" || !!filters.asset.trim() || !!filters.tag;

  const refreshDistinctTags = useCallback(() => {
    fetch(`/api/v1/wallets/${address}/history/tags`)
      .then(async (res) => (res.ok ? ((await res.json()) as { data: { tags: string[] } }) : null))
      .then((body) => body && setDistinctTags(body.data.tags))
      .catch(() => {});
  }, [address]);

  useEffect(refreshDistinctTags, [refreshDistinctTags]);

  // Debounce the asset text input into the applied filters.
  useEffect(() => {
    const t = window.setTimeout(
      () => setFilters((f) => (f.asset === assetDraft ? f : { ...f, asset: assetDraft })),
      350,
    );
    return () => window.clearTimeout(t);
  }, [assetDraft]);

  // Refetch page 1 whenever filters change (skip the pristine initial state —
  // the server already rendered it).
  const pristine = useRef(true);
  useEffect(() => {
    if (pristine.current) {
      pristine.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    const params = filterParams(filters);
    params.set("limit", String(PAGE));
    fetch(`/api/v1/wallets/${address}/history?${params}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { data?: HistoryItem[] };
        if (!res.ok || !body.data) throw new Error("failed to load history");
        if (cancelled) return;
        setItems(body.data);
        setDone(body.data.length < PAGE);
      })
      .catch((err: Error) => !cancelled && toast.error(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filters, address]);

  async function loadMore() {
    const oldest = items[items.length - 1]?.ts;
    if (!oldest) return;
    setLoading(true);
    try {
      const params = filterParams(filters);
      params.set("limit", String(PAGE));
      params.set("before", String(oldest));
      const res = await fetch(`/api/v1/wallets/${address}/history?${params}`);
      const body = (await res.json().catch(() => ({}))) as { data?: HistoryItem[] };
      if (!res.ok || !body.data) throw new Error("failed to load history");
      setItems((prev) => [...prev, ...body.data!]);
      if (body.data.length < PAGE) setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "failed to load history");
    } finally {
      setLoading(false);
    }
  }

  function setItemTags(txKey: string, tags: string[]) {
    setItems((prev) => prev.map((i) => (i.txKey === txKey ? { ...i, tags } : i)));
  }

  const pill = (active: boolean) =>
    cn(
      "rounded px-2 py-1 text-xs font-medium",
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent",
    );

  if (initialItems.length === 0 && !hasFilters) {
    return (
      <p className="p-4 text-center text-sm text-muted-foreground">
        {synced
          ? "No on-chain activity found for this address on the supported chains."
          : "No activity recorded yet — sync the wallet to backfill its on-chain history."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {(["all", "transfer", "trade"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setFilters((f) => ({ ...f, type: t }))}
            className={pill(filters.type === t)}
          >
            {t === "all" ? "All" : t === "transfer" ? "Transfers" : "Trades"}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {(["all", "in", "out"] as const).map((d) => (
          <button
            key={d}
            onClick={() => setFilters((f) => ({ ...f, direction: d }))}
            className={pill(filters.direction === d)}
          >
            {d === "all" ? "Any direction" : d === "in" ? "In" : "Out"}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <Input
          value={assetDraft}
          onChange={(e) => setAssetDraft(e.target.value)}
          placeholder="Asset…"
          className="h-7 w-24 text-xs"
        />
        {distinctTags.length > 0 && (
          <Popover>
            <PopoverTrigger
              render={
                <Button variant={filters.tag ? "default" : "outline"} size="xs">
                  {filters.tag ?? "Tag"}
                </Button>
              }
            />
            <PopoverContent align="start" className="w-44 p-1">
              <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                {distinctTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setFilters((f) => ({ ...f, tag: f.tag === tag ? null : tag }))}
                    className={cn(
                      "rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                      filters.tag === tag && "bg-accent/60 font-medium",
                    )}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setAssetDraft("");
              setFilters(NO_FILTERS);
            }}
          >
            <X /> Clear
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="p-4 text-center text-sm text-muted-foreground">
          Nothing matches these filters.
        </p>
      ) : (
        <div className="max-h-[480px] overflow-auto rounded-md border border-border/50">
          <Table className="text-xs [&_td]:py-2">
            <TableHeader>
              <TableRow className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Date</TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Type</TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Asset</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                  Amount
                </TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Counterparty</TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Chain</TableHead>
                <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">Tags</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">Tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, i) => {
                const url = txUrl(item.chainId, item.txHash);
                const sign = item.direction === "out" ? "−" : item.direction === "in" ? "+" : "";
                const when = new Date(item.ts);
                return (
                  <TableRow key={`${item.txKey}-${i}`} className="hover:bg-muted/40">
                    <TableCell className="whitespace-nowrap">
                      <div>{when.toLocaleDateString()}</div>
                      <div className="text-xs text-muted-foreground">
                        {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </TableCell>
                    <TableCell>
                      <TypeBadge item={item} />
                    </TableCell>
                    <TableCell>
                      <SymbolLabel symbol={item.assetSymbol} className="font-medium" />
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono tabular-figures",
                        item.direction === "in" && "text-success",
                      )}
                    >
                      {item.amount !== null ? `${sign}${formatAmount(item.amount)}` : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {item.counterparty ? shortAddress(item.counterparty) : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{chainName(item.chainId)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <div className="flex max-w-[140px] flex-wrap gap-1">
                          {item.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                        <TagEditor
                          address={address}
                          txKey={item.txKey}
                          tags={item.tags}
                          suggestions={distinctTags}
                          onChange={(tags) => {
                            setItemTags(item.txKey, tags);
                            refreshDistinctTags();
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          {shortAddress(item.txHash!)}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {!done && items.length > 0 && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={loadMore}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
