"use client";

// Type-only import: klinecharts touches `window` at module scope, so the
// runtime module is loaded lazily in the mount effect (never during SSR).
import type { Chart, KLineData, Period } from "klinecharts";
import { useEffect, useRef, useState } from "react";
import { DRAWING_TOOL_NAMES, DrawingToolbar } from "@/components/assets/drawing-toolbar";
import { SaveChartControls, type SavedChartInfo } from "@/components/assets/save-chart-controls";
import type { ChartState, SavedDrawing } from "@/lib/chart-state";
import { KLINE_STYLES } from "@/lib/kline-theme";
import { cn } from "@/lib/utils";
import { CHART_INTERVALS, type Candle, type ChartInterval } from "@/server/market/types";

// Bars per fetch: the initial window plus each older page loaded on left-pan.
const PAGE_BARS = 500;

const PERIODS: Record<ChartInterval, Period> = {
  "5m": { span: 5, type: "minute" },
  "15m": { span: 15, type: "minute" },
  "1h": { span: 1, type: "hour" },
  "4h": { span: 4, type: "hour" },
  "1d": { span: 1, type: "day" },
  "1w": { span: 1, type: "week" },
  "1M": { span: 1, type: "month" },
};

const INDICATORS: { name: string; label: string; onCandle: boolean }[] = [
  { name: "MA", label: "MA", onCandle: true },
  { name: "EMA", label: "EMA", onCandle: true },
  { name: "BOLL", label: "BOLL", onCandle: true },
  { name: "VOL", label: "VOL", onCandle: false },
  { name: "RSI", label: "RSI", onCandle: false },
  { name: "MACD", label: "MACD", onCandle: false },
];

function precisionFor(price: number | null | undefined): number {
  if (!price || price <= 0 || price >= 1) return 2;
  return Math.min(8, Math.ceil(-Math.log10(price)) + 3);
}

/** User drawings currently on the chart, in saved-chart form. Indicators
 * register internal overlays too, so filter to the drawing-tool templates. */
export function serializeDrawings(chart: Chart): SavedDrawing[] {
  return chart
    .getOverlays()
    .filter((o) => DRAWING_TOOL_NAMES.has(o.name) && o.points.length > 0)
    .map((o) => ({
      name: o.name,
      points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })),
      ...(o.lock ? { lock: true } : {}),
      ...(o.visible === false ? { visible: false } : {}),
    }));
}

/**
 * TradingView-style asset chart on KLineCharts: candles, built-in indicators,
 * drawing tools, and infinite history on left-pan. The chart instance lives
 * for the component's lifetime — interval switches only change the period, so
 * drawings survive them.
 */
export function AssetChartPro({
  assetId,
  symbol,
  hasIntraday,
  lastPrice,
  initialInterval = "1d",
  initialState,
  saved = null,
}: {
  assetId: number;
  symbol: string;
  hasIntraday: boolean;
  lastPrice?: number | null;
  initialInterval?: ChartInterval;
  initialState?: ChartState | null;
  /** The saved chart this view was opened from (deep link), if any. */
  saved?: SavedChartInfo | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const intervalRef = useRef<ChartInterval>(initialInterval);
  const restoreRef = useRef<SavedDrawing[] | null>(initialState?.drawings ?? null);

  const [interval, setIntervalState] = useState<ChartInterval>(initialInterval);
  const [savedInfo, setSavedInfo] = useState<SavedChartInfo | null>(saved);
  const [dirty, setDirty] = useState(false);
  const [indicators, setIndicators] = useState<string[]>(
    initialState?.indicators.map((i) => i.name) ?? ["MA", "VOL"],
  );
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  const overlayEvents = () => ({
    onDrawEnd: () => {
      setActiveTool(null);
      setDirty(true);
      return false;
    },
    onPressedMoveEnd: () => {
      setDirty(true);
      return false;
    },
    onRemoved: () => {
      setDirty(true);
      return false;
    },
    // Right-click deletes the drawing, like TradingView's eraser.
    onRightClick: (e: { overlay: { id: string } }) => {
      chartRef.current?.removeOverlay({ id: e.overlay.id });
      return true;
    },
  });

  const addIndicator = (chart: Chart, name: string) => {
    const def = INDICATORS.find((i) => i.name === name);
    if (!def) return;
    if (def.onCandle) chart.createIndicator({ name, paneId: "candle_pane" }, true);
    else chart.createIndicator(name);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const { init, dispose } = await import("klinecharts");
      if (cancelled) return;

      const chart = init(el, { timezone: "Etc/UTC", styles: KLINE_STYLES });
      if (!chart) return;
      chartRef.current = chart;
      // klinecharts sizes its canvases once at init and never watches the
      // container, so flex/dock resizes would leave a stale canvas size.
      const resizeObserver = new ResizeObserver(() => chart.resize());
      resizeObserver.observe(el);
      cleanup = () => {
        resizeObserver.disconnect();
        dispose(el);
        chartRef.current = null;
      };

    chart.setSymbol({
      ticker: symbol,
      pricePrecision: precisionFor(lastPrice),
      volumePrecision: 0,
    });

    chart.setDataLoader({
      getBars: async ({ type, timestamp, callback }) => {
        // "backward" (newer data) and "update" never apply: the cache only
        // serves closed candles, so the initial load is already current.
        if (type === "backward" || type === "update") {
          callback([], { backward: false });
          return;
        }
        try {
          setStatus("loading");
          const params = new URLSearchParams({
            assetId: String(assetId),
            interval: intervalRef.current,
            bars: String(PAGE_BARS),
          });
          // "forward" = load older history; timestamp is the earliest loaded bar.
          if (type === "forward") {
            if (timestamp === null) {
              callback([], { forward: false });
              return;
            }
            params.set("to", String(timestamp - 1));
          }
          const res = await fetch(`/api/v1/candles?${params}`);
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
          const { candles } = (await res.json()) as { candles: Candle[] };
          const bars: KLineData[] = candles.map((c) => ({
            timestamp: c.t,
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
            volume: c.v,
          }));
          callback(bars, { forward: bars.length >= PAGE_BARS, backward: false });
          setCount((prev) => (type === "init" ? bars.length : prev + bars.length));
          setStatus("ready");
          setError(null);
          if (type === "init" && restoreRef.current !== null) {
            const drawings = restoreRef.current;
            restoreRef.current = null;
            if (drawings.length > 0) {
              chart.createOverlay(drawings.map((d) => ({ ...d, ...overlayEvents() })));
            }
          }
        } catch (err) {
          callback([], { forward: false, backward: false });
          setError((err as Error).message);
          setStatus("error");
        }
      },
    });

      for (const name of indicators) addIndicator(chart, name);
      // Setting the period last triggers the initial load exactly once.
      chart.setPeriod(PERIODS[intervalRef.current]);
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
    // The chart mounts once per asset; interval/indicator changes go through
    // imperative handlers so drawings and zoom survive them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, symbol]);

  const changeInterval = (iv: ChartInterval) => {
    intervalRef.current = iv;
    setIntervalState(iv);
    setDirty(true);
    chartRef.current?.setPeriod(PERIODS[iv]);
  };

  const toggleIndicator = (name: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (indicators.includes(name)) {
      chart.removeIndicator({ name });
      setIndicators((prev) => prev.filter((n) => n !== name));
    } else {
      addIndicator(chart, name);
      setIndicators((prev) => [...prev, name]);
    }
    setDirty(true);
  };

  const startDrawing = (name: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    setActiveTool(name);
    chart.createOverlay({ name, ...overlayEvents() });
  };

  const clearDrawings = () => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const name of DRAWING_TOOL_NAMES) chart.removeOverlay({ name });
  };

  const getState = (): ChartState => ({
    drawings: chartRef.current ? serializeDrawings(chartRef.current) : [],
    indicators: indicators.map((name) => ({ name })),
  });

  const handleSaved = (info: SavedChartInfo) => {
    setSavedInfo(info);
    setDirty(false);
    // Keep the deep link current without an RSC round-trip (which would
    // remount the chart and drop zoom state).
    window.history.replaceState(null, "", `/assets/${assetId}?chart=${info.id}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {CHART_INTERVALS.map((iv) => {
          const disabled = !hasIntraday && iv !== "1d";
          return (
            <button
              key={iv}
              type="button"
              disabled={disabled}
              title={disabled ? "Only daily candles are available for this asset" : undefined}
              onClick={() => changeInterval(iv)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium",
                iv === interval
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent",
                disabled && "cursor-not-allowed opacity-40 hover:bg-muted",
              )}
            >
              {iv}
            </button>
          );
        })}
        <span className="mx-2 h-4 w-px bg-border" />
        {INDICATORS.map(({ name, label }) => (
          <button
            key={name}
            type="button"
            onClick={() => toggleIndicator(name)}
            className={cn(
              "rounded border px-2 py-1 text-xs",
              indicators.includes(name)
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {label}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-border" />
        <SaveChartControls
          assetId={assetId}
          interval={interval}
          saved={savedInfo}
          dirty={dirty}
          getState={getState}
          onSaved={handleSaved}
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {status === "loading" && "loading…"}
          {status === "ready" && `${count} candles`}
          {status === "error" && <span className="text-destructive">{error}</span>}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 gap-2">
        <DrawingToolbar activeTool={activeTool} onSelect={startDrawing} onClearAll={clearDrawings} />
        <div ref={containerRef} className="min-h-[420px] w-full flex-1" />
      </div>
    </div>
  );
}
