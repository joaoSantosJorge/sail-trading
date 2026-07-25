// Serialized state of an asset chart: what a saved chart persists and what
// the chart restores on load. Shared between the client chart component and
// the server saved-charts service (types only — no runtime imports).

/** KLineCharts built-in overlay templates exposed as drawing tools. */
export const DRAWING_OVERLAY_NAMES = [
  "segment",
  "rayLine",
  "straightLine",
  "horizontalStraightLine",
  "verticalStraightLine",
  "priceLine",
  "parallelStraightLine",
  "rect",
  "circle",
  "fibonacciLine",
] as const;

/** KLineCharts built-in indicators exposed as toggles. */
export const CHART_INDICATOR_NAMES = ["MA", "EMA", "BOLL", "VOL", "RSI", "MACD"] as const;

/** One user drawing: a KLineCharts overlay template name + its anchor points.
 * Some templates use only `timestamp` (vertical line) or only `value`
 * (horizontal/price line), so both are optional. */
export type SavedDrawing = {
  name: string;
  points: { timestamp?: number; value?: number }[];
  lock?: boolean;
  visible?: boolean;
};

/** An active indicator by KLineCharts built-in name (MA, EMA, BOLL, VOL, …). */
export type SavedIndicator = { name: string };

export type ChartState = {
  drawings: SavedDrawing[];
  indicators: SavedIndicator[];
};
