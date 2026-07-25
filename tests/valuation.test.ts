import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  reconstructDailyBalances,
  sampleMonthly,
  valuePortfolioSeries,
} from "@/server/portfolio/valuation";

const DAY0 = Date.parse("2026-07-01T00:00:00Z");
const day = (n: number) => DAY0 + n * DAY_MS;
const ETH = "1:native";
const OBS = "1:0xaaaa";

describe("reconstructDailyBalances", () => {
  it("walks backwards from current balances through transfer deltas", () => {
    // Timeline: day1 receive 5, day3 send 2 → current 3.
    const { days, balances } = reconstructDailyBalances(
      [{ key: ETH, balance: 3 }],
      [
        { key: ETH, ts: day(1) + 1000, delta: 5 },
        { key: ETH, ts: day(3) + 1000, delta: -2 },
      ],
      day(0),
      day(4),
    );
    expect(days).toEqual([day(0), day(1), day(2), day(3), day(4)]);
    expect(balances.get(ETH)).toEqual([0, 5, 5, 3, 3]);
  });

  it("clamps a missing inflow to zero instead of going negative", () => {
    // Current 1, but a 4-unit outflow is on record with no matching inflow:
    // naively balance before the outflow would be 5, before "history" −? No:
    // walking back past the outflow gives 1 + 4 = 5; walking back past an
    // unmatched *inflow* of 10 gives 5 − 10 = −5 → clamped to 0.
    const { balances } = reconstructDailyBalances(
      [{ key: ETH, balance: 1 }],
      [
        { key: ETH, ts: day(1) + 1, delta: 10 },
        { key: ETH, ts: day(2) + 1, delta: -4 },
      ],
      day(0),
      day(3),
    );
    // end of day0: 1 − (−4) − 10 = −5 → 0; end of day1: 1 + 4 = 5; day2+: 1.
    expect(balances.get(ETH)).toEqual([0, 5, 1, 1]);
  });

  it("treats self-transfers (delta 0) as neutral", () => {
    const { balances } = reconstructDailyBalances(
      [{ key: ETH, balance: 2 }],
      [{ key: ETH, ts: day(1) + 1, delta: 0 }],
      day(0),
      day(2),
    );
    expect(balances.get(ETH)).toEqual([2, 2, 2]);
  });

  it("buckets by UTC day boundaries: a transfer at exactly 00:00 belongs to that day", () => {
    const { balances } = reconstructDailyBalances(
      [{ key: ETH, balance: 7 }],
      [{ key: ETH, ts: day(2), delta: 7 }],
      day(0),
      day(3),
    );
    // End of day1 predates the transfer; end of day2 includes it.
    expect(balances.get(ETH)).toEqual([0, 0, 7, 7]);
  });

  it("tracks tokens that were fully sent away (no current holding)", () => {
    const { balances } = reconstructDailyBalances(
      [],
      [
        { key: OBS, ts: day(0) + 1, delta: 9 },
        { key: OBS, ts: day(2) + 1, delta: -9 },
      ],
      day(0),
      day(3),
    );
    expect(balances.get(OBS)).toEqual([9, 9, 0, 0]);
  });
});

describe("valuePortfolioSeries", () => {
  const days = [day(0), day(1), day(2)];

  it("values balances with daily closes and converts to BTC per day", () => {
    const { points } = valuePortfolioSeries(
      days,
      new Map([[ETH, [2, 2, 3]]]),
      new Map([[ETH, "ETH"]]),
      new Map([[ETH, new Map([[day(0), 100], [day(1), 110], [day(2), 120]])]]),
      new Map([[day(0), 50_000], [day(1), 55_000], [day(2), 60_000]]),
    );
    expect(points).toEqual([
      { t: day(0), usd: 200, btc: 200 / 50_000 },
      { t: day(1), usd: 220, btc: 220 / 55_000 },
      { t: day(2), usd: 360, btc: 360 / 60_000 },
    ]);
  });

  it("carries closes forward over gaps and values pre-coverage days at 0", () => {
    const { points } = valuePortfolioSeries(
      days,
      new Map([[ETH, [1, 1, 1]]]),
      new Map([[ETH, "ETH"]]),
      new Map([[ETH, new Map([[day(1), 100]])]]), // no close on day0 or day2
      new Map(),
    );
    expect(points.map((p) => p.usd)).toEqual([0, 100, 100]);
    expect(points.every((p) => p.btc === null)).toBe(true);
  });

  it("skips keys without a close map and aggregates same-symbol keys across chains", () => {
    const usdcEth = "1:0xusdc";
    const usdcBase = "8453:0xusdc";
    const { points, perAsset } = valuePortfolioSeries(
      days,
      new Map([
        [usdcEth, [10, 10, 10]],
        [usdcBase, [5, 5, 5]],
        [OBS, [1000, 1000, 1000]], // excluded: no closes
      ]),
      new Map([
        [usdcEth, "USDC"],
        [usdcBase, "USDC"],
        [OBS, "OBS"],
      ]),
      new Map([
        [usdcEth, new Map(days.map((d) => [d, 1]))],
        [usdcBase, new Map(days.map((d) => [d, 1]))],
      ]),
      new Map(),
    );
    expect(points.map((p) => p.usd)).toEqual([15, 15, 15]);
    expect(perAsset.get("USDC")!.map((p) => p.usd)).toEqual([15, 15, 15]);
    expect(perAsset.has("OBS")).toBe(false);
  });
});

describe("sampleMonthly", () => {
  it("keeps the last daily point of each UTC month plus the newest point", () => {
    const jun29 = Date.parse("2026-06-29T00:00:00Z");
    const points = Array.from({ length: 10 }, (_, i) => ({ t: jun29 + i * DAY_MS }));
    // Days: Jun 29, 30, Jul 1..8 — expect Jun 30 and Jul 8 (newest).
    expect(sampleMonthly(points).map((p) => new Date(p.t).toISOString().slice(0, 10))).toEqual([
      "2026-06-30",
      "2026-07-08",
    ]);
  });

  it("handles empty and single-point inputs", () => {
    expect(sampleMonthly([])).toEqual([]);
    expect(sampleMonthly([{ t: day(0) }])).toEqual([{ t: day(0) }]);
  });
});
