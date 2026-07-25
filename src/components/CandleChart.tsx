"use client";

import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { INTERVALS, type Candle, type Interval } from "@/server/market/types";

type Props = {
  assetId: number;
  initialInterval?: Interval;
};

export function CandleChart({ assetId, initialInterval = "1h" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [interval, setInterval] = useState<Interval>(initialInterval);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [candleCount, setCandleCount] = useState(0);

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
      // minBarSpacing 0 lets fitContent show arbitrarily long histories
      // instead of silently clipping to ~1500 bars (the 0.5px default).
      timeScale: { timeVisible: true, secondsVisible: false, minBarSpacing: 0 },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      color: "rgba(107,114,128,0.5)",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    let cancelled = false;
    setStatus("loading");
    fetch(`/api/v1/candles?assetId=${assetId}&interval=${interval}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        return res.json() as Promise<{ candles: Candle[] }>;
      })
      .then(({ candles }) => {
        if (cancelled) return;
        candleSeries.setData(
          candles.map((c) => ({
            time: (c.t / 1000) as UTCTimestamp,
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
          })),
        );
        volumeSeries.setData(
          candles.map((c) => ({
            time: (c.t / 1000) as UTCTimestamp,
            value: c.v,
            color: c.c >= c.o ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
          })),
        );
        chart.timeScale().fitContent();
        setCandleCount(candles.length);
        setStatus("ready");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setStatus("error");
      });

    return () => {
      cancelled = true;
      chart.remove();
      chartRef.current = null;
    };
  }, [assetId, interval]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval(iv)}
            className={`rounded px-3 py-1 text-sm ${
              iv === interval
                ? "bg-foreground text-background"
                : "bg-black/[.05] dark:bg-white/[.08] hover:bg-black/[.1] dark:hover:bg-white/[.15]"
            }`}
          >
            {iv}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">
          {status === "loading" && "loading…"}
          {status === "ready" && `${candleCount} candles`}
          {status === "error" && <span className="text-red-500">{error}</span>}
        </span>
      </div>
      <div ref={containerRef} className="h-[480px] w-full" />
    </div>
  );
}
