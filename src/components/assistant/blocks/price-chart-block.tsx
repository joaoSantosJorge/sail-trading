"use client";

import {
  CandlestickSeries,
  createChart,
  LineSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { chartFetchBars, priceChartSpecSchema, type PriceChartSpec } from "@/lib/ai/render-schemas";
import type { Candle } from "@/server/market/types";
import { BlockError, BlockFrame, BlockPending } from "./block-frame";

// Local, client-side overlay math (index-aligned, NaN during warm-up) — the
// server engine is never imported into the client bundle.
function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      seedSum += values[i];
    } else if (i === period - 1) {
      prev = (seedSum + values[i]) / period;
      out[i] = prev;
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

const OVERLAY_COLORS = ["#3b82f6", "#f59e0b", "#a855f7", "#14b8a6"];

const INTRADAY_INTERVALS = new Set<PriceChartSpec["interval"]>(["5m", "15m", "1h", "4h"]);

function ChartCanvas({ spec }: { spec: PriceChartSpec }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string>("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#9ca3af" },
      grid: {
        vertLines: { color: "rgba(107,114,128,0.15)" },
        horzLines: { color: "rgba(107,114,128,0.15)" },
      },
      timeScale: {
        // Time-of-day only means something intraday; 1d/1w/1M read as dates.
        timeVisible: INTRADAY_INTERVALS.has(spec.interval),
        secondsVisible: false,
        minBarSpacing: 0,
      },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    // Fetch overlay warm-up bars on top of the window, then keep the VISIBLE
    // window at exactly lookbackBars (see chartFetchBars).
    const fetchBars = chartFetchBars(spec);

    let cancelled = false;
    fetch(`/api/v1/candles?assetId=${spec.assetId}&interval=${spec.interval}&bars=${fetchBars}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        return res.json() as Promise<{ asset: { symbol: string }; candles: Candle[] }>;
      })
      .then(({ asset, candles }) => {
        if (cancelled) return;
        setSymbol(asset.symbol);
        candleSeries.setData(
          candles.map((c) => ({
            time: (c.t / 1000) as UTCTimestamp,
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
          })),
        );
        const closes = candles.map((c) => c.c);
        (spec.overlays ?? []).forEach((overlay, i) => {
          const series = overlay.type === "sma" ? sma(closes, overlay.period) : ema(closes, overlay.period);
          const line = chart.addSeries(LineSeries, {
            color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          line.setData(
            candles
              .map((c, idx) => ({ time: (c.t / 1000) as UTCTimestamp, value: series[idx] }))
              .filter((p) => Number.isFinite(p.value)),
          );
        });
        if (fetchBars > spec.lookbackBars && candles.length > spec.lookbackBars) {
          chart
            .timeScale()
            .setVisibleLogicalRange({ from: candles.length - spec.lookbackBars, to: candles.length });
        } else {
          chart.timeScale().fitContent();
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
      chart.remove();
    };
  }, [spec]);

  if (error) return <BlockError tool="render_price_chart" detail={error} />;

  return (
    <div>
      <div ref={containerRef} className="h-64 w-full" />
      <p className="mt-1 text-[11px] text-muted-foreground">
        {symbol && `${symbol}/USD · `}
        {spec.interval} · last {spec.lookbackBars} bars
        {spec.overlays?.length
          ? ` · ${spec.overlays.map((o) => `${o.type.toUpperCase()}(${o.period})`).join(", ")}`
          : ""}
      </p>
    </div>
  );
}

/**
 * Inline price chart rendered from a render_price_chart SPEC — the block
 * fetches candles itself from /api/v1/candles (fetch-through cache), so
 * series data never rides through the model or the persisted parts.
 */
export function PriceChartBlock({ args, streaming }: { args: unknown; streaming?: boolean }) {
  const parsed = priceChartSpecSchema.safeParse(args);
  if (!parsed.success) {
    return streaming ? (
      <BlockPending label="Preparing chart…" />
    ) : (
      <BlockError tool="render_price_chart" />
    );
  }
  return (
    <BlockFrame title={parsed.data.title}>
      <ChartCanvas spec={parsed.data} />
    </BlockFrame>
  );
}
