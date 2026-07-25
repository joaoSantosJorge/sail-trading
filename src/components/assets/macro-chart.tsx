"use client";

import { AreaSeries, createChart } from "lightweight-charts";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

/**
 * Small themed line/area chart for one macro series. Data arrives as props
 * from the RSC grid; dates are "YYYY-MM-DD" business-day strings, which
 * lightweight-charts accepts directly. Colors are fixed hex — canvas needs
 * concrete values (same approach as portfolio-chart).
 */

const LINE = { light: "#2171cc", dark: "#3986e4" };
const AREA_TOP = { light: "rgba(33,113,204,0.18)", dark: "rgba(57,134,228,0.22)" };

export type MacroPoint = { date: string; value: number };

export function MacroChart({ data, unit }: { data: MacroPoint[]; unit: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const mode: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light";

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.length === 0) return;
    const textColor = mode === "dark" ? "#8b93a3" : "#6b7280";
    const gridColor = mode === "dark" ? "rgba(139,147,163,0.10)" : "rgba(107,114,128,0.12)";

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: gridColor } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false, minBarSpacing: 0 },
      crosshair: { horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: LINE[mode],
      lineWidth: 2,
      topColor: AREA_TOP[mode],
      bottomColor: "transparent",
      priceLineVisible: false,
      priceFormat: {
        type: "custom",
        formatter: (v: number) =>
          unit === "%" ? `${v.toFixed(2)}%` : v.toLocaleString("en-US", { maximumFractionDigits: 0 }),
        minMove: 0.01,
      },
    });
    series.setData(data.map((p) => ({ time: p.date, value: p.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, unit, mode]);

  return <div ref={containerRef} className="h-[180px] w-full" />;
}
