import { describe, expect, it } from "vitest";
import { chartFetchBars, priceChartSpecSchema } from "@/lib/ai/render-schemas";
import { CHART_INTERVALS, CHART_INTERVAL_MS, INTERVALS } from "@/server/market/types";

/**
 * The chat could not chart a weekly timeframe: render_price_chart's interval
 * enum was locked to the strategy DSL's four intervals, so "BTC weekly" either
 * failed tool validation or came back as a daily chart. Charting accepts the
 * full ChartInterval superset; the DSL stays locked.
 */

describe("render_price_chart accepts chart-only intervals", () => {
  it("accepts every ChartInterval, including 1w and 1M", () => {
    for (const interval of CHART_INTERVALS) {
      const parsed = priceChartSpecSchema.safeParse({ assetId: 1, interval, lookbackBars: 180 });
      expect(parsed.success, `interval ${interval} should be chartable`).toBe(true);
      expect(parsed.success && parsed.data.interval).toBe(interval);
    }
  });

  it("still rejects intervals no provider serves", () => {
    for (const bad of ["1y", "2h", "1W", "weekly", ""]) {
      expect(priceChartSpecSchema.safeParse({ assetId: 1, interval: bad }).success).toBe(false);
    }
  });

  it("keeps the strategy DSL a strict subset of the chart intervals", () => {
    for (const interval of INTERVALS) {
      expect(CHART_INTERVALS).toContain(interval);
    }
    expect(INTERVALS as readonly string[]).not.toContain("1w");
  });

  it("charts a weekly BTC spec with 50/200 MAs — the case that failed", () => {
    const parsed = priceChartSpecSchema.safeParse({
      assetId: 1,
      interval: "1w",
      lookbackBars: 260,
      overlays: [
        { type: "sma", period: 50 },
        { type: "sma", period: 200 },
      ],
      title: "BTC/USD weekly",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("chartFetchBars", () => {
  const spec = (over?: { lookbackBars?: number; overlays?: { type: "sma"; period: number }[] }) =>
    priceChartSpecSchema.parse({
      assetId: 1,
      interval: "1w",
      lookbackBars: over?.lookbackBars ?? 180,
      ...(over?.overlays ? { overlays: over.overlays } : {}),
    });

  it("fetches exactly the window when there are no overlays", () => {
    expect(chartFetchBars(spec())).toBe(180);
  });

  it("adds warm-up for the longest overlay so an SMA(200) is drawn on bar 1", () => {
    const s = spec({
      lookbackBars: 180,
      overlays: [
        { type: "sma", period: 50 },
        { type: "sma", period: 200 },
      ],
    });
    // 199 prior bars + the 180 shown: the SMA(200) has a value on every
    // visible bar instead of being NaN across the whole window.
    expect(chartFetchBars(s)).toBe(379);
  });

  it("stays within the /api/v1/candles bars cap at the schema maximum", () => {
    const s = spec({ lookbackBars: 500, overlays: [{ type: "sma", period: 500 }] });
    expect(chartFetchBars(s)).toBe(999);
    expect(chartFetchBars(s)).toBeLessThanOrEqual(20_000);
  });
});

describe("weekly lookback sizing", () => {
  it("1w spans a week, so a 200-bar weekly window is ~3.8 years", () => {
    expect(CHART_INTERVAL_MS["1w"]).toBe(7 * 24 * 60 * 60 * 1000);
    const years = (200 * CHART_INTERVAL_MS["1w"]) / (365 * 24 * 60 * 60 * 1000);
    expect(years).toBeGreaterThan(3.8);
    expect(years).toBeLessThan(3.9);
  });

  it("annualization scales by interval, not by a hardcoded daily constant", () => {
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(year / CHART_INTERVAL_MS["1w"]).toBeCloseTo(52.14, 1);
    expect(year / CHART_INTERVAL_MS["1d"]).toBe(365);
  });
});
