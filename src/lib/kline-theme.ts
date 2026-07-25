import type { DeepPartial, Styles } from "klinecharts";

// Matches the palette of the app's lightweight-charts components
// (asset snapshot deltas, portfolio chart): green/red candles, gray axes.
// Neutral grays read fine on both the light and dark theme.
const UP = "#22c55e";
const DOWN = "#ef4444";
const NEUTRAL = "#9ca3af";
const GRID = "rgba(107,114,128,0.12)";
const AXIS_LINE = "rgba(107,114,128,0.3)";
const CROSSHAIR = "rgba(107,114,128,0.5)";

export const KLINE_STYLES: DeepPartial<Styles> = {
  grid: {
    horizontal: { color: GRID },
    vertical: { color: GRID },
  },
  candle: {
    bar: {
      upColor: UP,
      downColor: DOWN,
      noChangeColor: NEUTRAL,
      upBorderColor: UP,
      downBorderColor: DOWN,
      noChangeBorderColor: NEUTRAL,
      upWickColor: UP,
      downWickColor: DOWN,
      noChangeWickColor: NEUTRAL,
    },
    priceMark: {
      last: { upColor: UP, downColor: DOWN, noChangeColor: NEUTRAL },
    },
  },
  xAxis: {
    axisLine: { color: AXIS_LINE },
    tickLine: { color: AXIS_LINE },
    tickText: { color: NEUTRAL },
  },
  yAxis: {
    axisLine: { color: AXIS_LINE },
    tickLine: { color: AXIS_LINE },
    tickText: { color: NEUTRAL },
  },
  separator: { color: AXIS_LINE },
  crosshair: {
    horizontal: { line: { color: CROSSHAIR } },
    vertical: { line: { color: CROSSHAIR } },
  },
};
