// Pure delta computation for the macro snapshot tool. Observations arrive
// date-ascending from getMacroSeries and may be daily, weekly, or monthly —
// deltas pick the nearest observation to the target date within a tolerance.
import type { MacroObservation } from "./fred";

export type MacroDeltas = {
  latest: MacroObservation;
  /** Absolute change in the series' unit vs ~3 months ago (null if no observation near enough). */
  delta3m: number | null;
  delta12m: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 45 * DAY_MS;

const round2 = (v: number) => Number(v.toFixed(2));

function nearestValue(observations: MacroObservation[], targetMs: number): number | null {
  let best: MacroObservation | null = null;
  let bestDist = Infinity;
  for (const obs of observations) {
    const dist = Math.abs(Date.parse(obs.date) - targetMs);
    if (dist < bestDist) {
      best = obs;
      bestDist = dist;
    }
  }
  return best && bestDist <= TOLERANCE_MS ? best.value : null;
}

export function computeMacroDeltas(observations: MacroObservation[]): MacroDeltas | null {
  if (observations.length === 0) return null;
  const latest = observations[observations.length - 1];
  const latestMs = Date.parse(latest.date);
  const ago3m = nearestValue(observations.slice(0, -1), latestMs - 90 * DAY_MS);
  const ago12m = nearestValue(observations.slice(0, -1), latestMs - 365 * DAY_MS);
  return {
    latest: { date: latest.date, value: round2(latest.value) },
    delta3m: ago3m === null ? null : round2(latest.value - ago3m),
    delta12m: ago12m === null ? null : round2(latest.value - ago12m),
  };
}
