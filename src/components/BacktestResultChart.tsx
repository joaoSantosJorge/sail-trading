"use client";

import {
  BaselineSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { EquityPoint, Trade } from "@/server/engine/backtest";
import type { Candle, Interval } from "@/server/market/types";

type Props = {
  assetId: number;
  interval: Interval;
  fromT: number;
  toT: number;
  trades: Trade[];
  equityCurve: EquityPoint[];
  initialEquity: number;
};

const chartOptions = {
  autoSize: true,
  layout: { background: { color: "transparent" }, textColor: "#9ca3af" },
  grid: {
    vertLines: { color: "rgba(107,114,128,0.15)" },
    horzLines: { color: "rgba(107,114,128,0.15)" },
  },
  // minBarSpacing 0 lets fitContent show arbitrarily long histories instead
  // of silently clipping to ~1500 bars (the 0.5px default).
  timeScale: { timeVisible: true, secondsVisible: false, minBarSpacing: 0 },
} as const;

export function BacktestResultChart({
  assetId,
  interval,
  fromT,
  toT,
  trades,
  equityCurve,
  initialEquity,
}: Props) {
  const priceRef = useRef<HTMLDivElement>(null);
  const equityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const priceEl = priceRef.current;
    const equityEl = equityRef.current;
    if (!priceEl || !equityEl) return;

    const priceChart = createChart(priceEl, chartOptions);
    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    const equityChart = createChart(equityEl, chartOptions);
    const equitySeries = equityChart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: initialEquity },
      topLineColor: "#22c55e",
      topFillColor1: "rgba(34,197,94,0.2)",
      topFillColor2: "rgba(34,197,94,0.02)",
      bottomLineColor: "#ef4444",
      bottomFillColor1: "rgba(239,68,68,0.02)",
      bottomFillColor2: "rgba(239,68,68,0.2)",
    });
    equitySeries.setData(
      equityCurve.map((p) => ({ time: (p.t / 1000) as UTCTimestamp, value: p.equity })),
    );
    equityChart.timeScale().fitContent();

    let cancelled = false;
    fetch(`/api/v1/candles?assetId=${assetId}&interval=${interval}&from=${fromT}&to=${toT}`)
      .then((res) => res.json() as Promise<{ candles: Candle[] }>)
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
        const markers: SeriesMarker<Time>[] = trades.flatMap((t) => [
          {
            time: (t.entryT / 1000) as UTCTimestamp,
            position: "belowBar" as const,
            color: "#22c55e",
            shape: "arrowUp" as const,
            text: "buy",
          },
          {
            time: (t.exitT / 1000) as UTCTimestamp,
            position: "aboveBar" as const,
            color: "#ef4444",
            shape: "arrowDown" as const,
            text: t.exitReason === "signal" ? "sell" : t.exitReason,
          },
        ]);
        createSeriesMarkers(candleSeries, markers);
        priceChart.timeScale().fitContent();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      priceChart.remove();
      equityChart.remove();
    };
  }, [assetId, interval, fromT, toT, trades, equityCurve, initialEquity]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1 text-xs text-gray-500">Price & trades</p>
        <div ref={priceRef} className="h-[360px] w-full" />
      </div>
      <div>
        <p className="mb-1 text-xs text-gray-500">Equity</p>
        <div ref={equityRef} className="h-[220px] w-full" />
      </div>
    </div>
  );
}
