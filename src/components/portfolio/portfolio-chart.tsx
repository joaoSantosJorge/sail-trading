"use client";

import {
  AreaSeries,
  createChart,
  LineSeries,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { ListFilter, Wallet, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { foldSymbol } from "@/lib/portfolio/symbols";
import { formatBtc, formatUsd } from "@/lib/portfolio/value";
import { cn, shortAddress } from "@/lib/utils";

/**
 * Portfolio value over time. Series are reconstructed server-side from the
 * on-chain transfer history and valued at daily closes; the newest point is
 * the live snapshot total. Unfiltered → one area series (total); with an
 * asset filter → one line per symbol.
 *
 * Colors are fixed hex (canvas needs concrete values), validated for CVD
 * separation per mode; a symbol keeps the color of its position in the
 * `available` list, so toggling other assets never repaints it.
 */

const RANGES = ["7d", "30d", "90d", "1y", "all"] as const;
type Range = (typeof RANGES)[number];
const MONTHLY_RANGES: Range[] = ["1y", "all"];

const PALETTE = {
  light: ["#2171cc", "#e07937", "#8072c2", "#4eb068", "#00a3c9"],
  dark: ["#3986e4", "#d56f2c", "#8072c2", "#3ca059", "#009abf"],
};
const AREA_TOP_ALPHA = { light: "rgba(33,113,204,0.18)", dark: "rgba(57,134,228,0.22)" };

type Point = { t: number; usd: number; btc: number | null };
type Timeseries = {
  points: Point[];
  perAsset: { symbol: string; points: { t: number; usd: number }[] }[];
  available: { symbol: string; valueUsd: number }[];
  excluded: { symbol: string; valueUsd: number }[];
};

function changeChip(points: { t: number; usd?: number; value?: number }[], values: number[]) {
  const first = values.find((v) => v > 0);
  const last = values[values.length - 1];
  if (first === undefined || last === undefined || first === 0) return null;
  return (last - first) / first;
}

/** Display label for a server symbol: homoglyphs folded, fakes marked. */
function assetLabel(symbol: string): string {
  const { folded, suspicious } = foldSymbol(symbol);
  return suspicious ? `${folded} (fake)` : folded;
}

export type ChartWallet = { address: string; label: string | null };

export function PortfolioChart({ wallets }: { wallets: ChartWallet[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const mode: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light";

  const [range, setRange] = useState<Range>("30d");
  const [granularity, setGranularity] = useState<"day" | "month">("day");
  const [unit, setUnit] = useState<"usd" | "btc">("usd");
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedWallets, setSelectedWallets] = useState<string[]>([]);
  const [data, setData] = useState<Timeseries | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = selected.length > 0;
  const effectiveUnit = filtered ? "usd" : unit; // per-asset series are USD-only

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setSlow(false);
    const slowTimer = window.setTimeout(() => setSlow(true), 5000);
    const params = new URLSearchParams({ range, granularity });
    if (selected.length > 0) params.set("assets", selected.join(","));
    if (selectedWallets.length > 0) params.set("wallets", selectedWallets.join(","));
    fetch(`/api/v1/portfolio/timeseries?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        return res.json() as Promise<{ data: Timeseries }>;
      })
      .then(({ data }) => {
        setData(data);
        setStatus("ready");
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setStatus("error");
      })
      .finally(() => window.clearTimeout(slowTimer));
    return () => {
      window.clearTimeout(slowTimer);
      controller.abort();
    };
  }, [range, granularity, selected, selectedWallets]);

  // (Re)build the chart whenever data, unit, or theme changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !data || data.points.length === 0) return;
    const palette = PALETTE[mode];
    const textColor = mode === "dark" ? "#8b93a3" : "#6b7280";
    const gridColor = mode === "dark" ? "rgba(139,147,163,0.10)" : "rgba(107,114,128,0.12)";

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: gridColor } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false, minBarSpacing: 0 },
      crosshair: { horzLine: { visible: false } },
    });

    const fmt = (v: number) => (effectiveUnit === "btc" ? formatBtc(v) : formatUsd(v));
    const seriesByLabel = new Map<string, ISeriesApi<"Area"> | ISeriesApi<"Line">>();

    if (!filtered) {
      const area = chart.addSeries(AreaSeries, {
        lineColor: palette[0],
        lineWidth: 2,
        topColor: AREA_TOP_ALPHA[mode],
        bottomColor: "transparent",
        priceLineVisible: false,
        priceFormat: { type: "custom", formatter: fmt, minMove: 0.01 },
      });
      area.setData(
        data.points
          .filter((p) => effectiveUnit === "usd" || p.btc !== null)
          .map((p) => ({
            time: (p.t / 1000) as UTCTimestamp,
            value: effectiveUnit === "btc" ? p.btc! : p.usd,
          })),
      );
      seriesByLabel.set("Total", area);
    } else {
      // Color follows the symbol's stable slot in `available`, not its rank
      // in the current selection.
      const slot = new Map(data.available.map((a, i) => [a.symbol, i]));
      for (const asset of data.perAsset) {
        const line = chart.addSeries(LineSeries, {
          color: palette[(slot.get(asset.symbol) ?? 0) % palette.length],
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: { type: "custom", formatter: fmt, minMove: 0.01 },
        });
        line.setData(
          asset.points.map((p) => ({ time: (p.t / 1000) as UTCTimestamp, value: p.usd })),
        );
        seriesByLabel.set(assetLabel(asset.symbol), line);
      }
    }
    chart.timeScale().fitContent();

    // Lightweight floating tooltip: date + value per hovered series.
    const tooltip = tooltipRef.current;
    chart.subscribeCrosshairMove((param) => {
      if (!tooltip) return;
      if (!param.time || !param.point || param.seriesData.size === 0) {
        tooltip.style.display = "none";
        return;
      }
      const date = new Date((param.time as number) * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      const rows = [...seriesByLabel.entries()]
        .map(([label, series]) => {
          const d = param.seriesData.get(series) as { value?: number } | undefined;
          if (d?.value === undefined) return null;
          return `<div class="flex justify-between gap-4"><span>${label}</span><span class="font-mono">${fmt(d.value)}</span></div>`;
        })
        .filter(Boolean)
        .join("");
      tooltip.innerHTML = `<div class="text-muted-foreground">${date}</div>${rows}`;
      tooltip.style.display = "block";
      const x = Math.min(param.point.x + 12, el.clientWidth - tooltip.clientWidth - 8);
      const y = Math.min(param.point.y + 12, el.clientHeight - tooltip.clientHeight - 8);
      tooltip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
    });

    return () => chart.remove();
  }, [data, effectiveUnit, mode, filtered]);

  const displayedValues = !data
    ? []
    : filtered
      ? []
      : data.points.map((p) => (effectiveUnit === "btc" ? (p.btc ?? 0) : p.usd));
  const change = displayedValues.length >= 2 ? changeChip(data!.points, displayedValues) : null;
  const excludedUsd = data?.excluded.reduce((a, e) => a + e.valueUsd, 0) ?? 0;
  const slotColors = data
    ? new Map(data.available.map((a, i) => [a.symbol, PALETTE[mode][i % PALETTE[mode].length]]))
    : new Map<string, string>();

  const pill = (active: boolean) =>
    cn(
      "rounded px-2.5 py-1 text-xs font-medium",
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent",
    );

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Value over time</CardTitle>
        {change !== null && (
          <CardAction
            className={cn(
              "font-mono text-sm font-medium tabular-nums",
              change > 0 ? "text-success" : change < 0 ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {change > 0 ? "+" : ""}
            {(change * 100).toFixed(2)}%{" "}
            <span className="text-xs font-normal text-muted-foreground">({range})</span>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => {
                setRange(r);
                if (!MONTHLY_RANGES.includes(r)) setGranularity("day");
              }}
              className={pill(r === range)}
            >
              {r.toUpperCase()}
            </button>
          ))}
          {MONTHLY_RANGES.includes(range) && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              <button onClick={() => setGranularity("day")} className={pill(granularity === "day")}>
                Day
              </button>
              <button
                onClick={() => setGranularity("month")}
                className={pill(granularity === "month")}
              >
                Month
              </button>
            </>
          )}
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={() => setUnit("usd")}
            className={pill(effectiveUnit === "usd")}
            disabled={filtered}
          >
            USD
          </button>
          <button
            onClick={() => setUnit("btc")}
            className={cn(pill(effectiveUnit === "btc"), filtered && "cursor-not-allowed opacity-50")}
            disabled={filtered}
            title={filtered ? "Per-asset series are shown in USD" : undefined}
          >
            BTC
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="outline" size="xs">
                    <Wallet />
                    {selectedWallets.length === 0
                      ? "All wallets"
                      : selectedWallets.length === 1
                        ? (wallets.find((w) => w.address === selectedWallets[0])?.label ??
                          shortAddress(selectedWallets[0]))
                        : `${selectedWallets.length} wallets`}
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-64 p-2">
                <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                  {wallets.map((w) => {
                    const on = selectedWallets.includes(w.address);
                    return (
                      <button
                        key={w.address}
                        onClick={() =>
                          setSelectedWallets((prev) =>
                            on ? prev.filter((a) => a !== w.address) : [...prev, w.address],
                          )
                        }
                        className={cn(
                          "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                          on && "bg-accent/60",
                        )}
                      >
                        <span
                          className={cn(
                            "size-2 rounded-full bg-primary",
                            !on && "opacity-30",
                          )}
                          aria-hidden
                        />
                        <span className="flex-1 truncate font-medium">
                          {w.label ?? shortAddress(w.address)}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {shortAddress(w.address)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedWallets.length > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="mt-1 w-full"
                    onClick={() => setSelectedWallets([])}
                  >
                    <X /> Clear filter
                  </Button>
                )}
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="outline" size="xs">
                    <ListFilter />
                    {filtered ? `${selected.length} asset${selected.length > 1 ? "s" : ""}` : "All assets"}
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-56 p-2">
                <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                  {(data?.available ?? []).map((a) => {
                    const on = selected.includes(a.symbol);
                    return (
                      <button
                        key={a.symbol}
                        onClick={() =>
                          setSelected((prev) =>
                            on ? prev.filter((s) => s !== a.symbol) : [...prev, a.symbol],
                          )
                        }
                        className={cn(
                          "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                          on && "bg-accent/60",
                        )}
                      >
                        <span
                          className={cn("size-2 rounded-full", !on && "opacity-30")}
                          style={{ backgroundColor: slotColors.get(a.symbol) }}
                          aria-hidden
                        />
                        <span className="flex-1 font-medium">{assetLabel(a.symbol)}</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatUsd(a.valueUsd)}
                        </span>
                      </button>
                    );
                  })}
                  {(data?.available ?? []).length === 0 && (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      Sync a wallet to see assets here.
                    </p>
                  )}
                </div>
                {filtered && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="mt-1 w-full"
                    onClick={() => setSelected([])}
                  >
                    <X /> Clear filter
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {filtered && data && (
          <div className="flex flex-wrap items-center gap-3">
            {data.perAsset.map((a) => (
              <span key={a.symbol} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: slotColors.get(a.symbol) }}
                  aria-hidden
                />
                {assetLabel(a.symbol)}
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          {status === "loading" && (
            <div className="flex h-[280px] flex-col items-center justify-center gap-2">
              <Skeleton className="h-full w-full" />
              {slow && (
                <p className="absolute text-sm text-muted-foreground">
                  Building price history for your tokens — first load can take a while…
                </p>
              )}
            </div>
          )}
          {status === "error" && (
            <div className="flex h-[280px] items-center justify-center">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
          {status === "ready" && data && data.points.length === 0 && (
            <div className="flex h-[280px] items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Sync a wallet below to start building your value history.
              </p>
            </div>
          )}
          <div
            ref={containerRef}
            className={cn("h-[280px] w-full", (status !== "ready" || !data || data.points.length === 0) && "hidden")}
          />
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute left-0 top-0 z-10 hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          />
        </div>

        <div className="flex flex-col gap-0.5">
          {excludedUsd > 0 && data && (
            <p className="text-xs text-muted-foreground">
              {data.excluded.length} asset{data.excluded.length > 1 ? "s" : ""} (
              {formatUsd(excludedUsd)}) excluded — no price history.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Historical values are reconstructed from on-chain transfers and daily prices — estimates,
            not statements.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
