import { describe, expect, it } from "vitest";
import { computeMacroDeltas } from "@/server/macro/snapshot";
import type { MacroObservation } from "@/server/macro/fred";

function monthly(from: string, values: number[]): MacroObservation[] {
  const [y, m] = from.split("-").map(Number);
  return values.map((value, i) => {
    const month = m - 1 + i;
    const date = new Date(Date.UTC(y + Math.floor(month / 12), month % 12, 1));
    return { date: date.toISOString().slice(0, 10), value };
  });
}

describe("computeMacroDeltas", () => {
  it("returns null for an empty series", () => {
    expect(computeMacroDeltas([])).toBeNull();
  });

  it("computes exact 3m/12m deltas on a monthly series", () => {
    // 13 months, value = index: latest 12, 3 months ago 9, 12 months ago 0.
    const obs = monthly("2025-06", Array.from({ length: 13 }, (_, i) => i));
    const deltas = computeMacroDeltas(obs);
    expect(deltas).not.toBeNull();
    expect(deltas!.latest).toEqual({ date: "2026-06-01", value: 12 });
    expect(deltas!.delta3m).toBe(3);
    expect(deltas!.delta12m).toBe(12);
  });

  it("picks the nearest observation on a daily series", () => {
    const obs: MacroObservation[] = Array.from({ length: 400 }, (_, i) => {
      const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
      return { date, value: i };
    });
    const deltas = computeMacroDeltas(obs)!;
    expect(deltas.latest.value).toBe(399);
    expect(deltas.delta3m).toBe(90); // exactly 90 days back exists
    expect(deltas.delta12m).toBe(365);
  });

  it("returns null deltas when no observation is within tolerance", () => {
    // Two observations 60 days apart: 3m target misses both by >45d... the
    // 60d-old one is 30d from the 90d target, so delta3m resolves; 12m is null.
    const obs: MacroObservation[] = [
      { date: "2026-05-01", value: 10 },
      { date: "2026-06-30", value: 14 },
    ];
    const deltas = computeMacroDeltas(obs)!;
    expect(deltas.delta3m).toBe(4);
    expect(deltas.delta12m).toBeNull();
  });

  it("returns null deltas for a single observation", () => {
    const deltas = computeMacroDeltas([{ date: "2026-06-01", value: 5 }])!;
    expect(deltas.latest.value).toBe(5);
    expect(deltas.delta3m).toBeNull();
    expect(deltas.delta12m).toBeNull();
  });

  it("rounds values and deltas to 2 decimals", () => {
    const obs = monthly("2026-03", [3.14159, 3.15159, 3.16159, 3.2599]);
    const deltas = computeMacroDeltas(obs)!;
    expect(deltas.latest.value).toBe(3.26);
    expect(deltas.delta3m).toBe(0.12); // 3.2599 - 3.14159 ≈ 0.1183 → nearest is 90d
  });
});
