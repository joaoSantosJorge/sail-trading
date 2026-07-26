import { describe, expect, it } from "vitest";
import type { DeploymentRow } from "@/server/deployments/service";
import { INTERVAL_MS, type Candle } from "@/server/market/types";
import { tickDeployment, type TickDeps, type TickPatch } from "@/worker/tick";
import type { StrategyDSL } from "@/server/engine/types";

const HOUR = INTERVAL_MS["1h"];
const T0 = Date.parse("2024-06-01T00:00:00Z");

/** Entry when close > 100, exit when close < 90 — trivially steerable. */
const DSL: StrategyDSL = {
  version: 1,
  name: "steerable",
  description: "",
  interval: "1h",
  indicators: [],
  entry: { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 100 } },
  exit: { op: "lt", left: { kind: "price", field: "close" }, right: { kind: "const", value: 90 } },
  risk: { positionSizePct: 10, stopLossPct: 5, takeProfitPct: 10, cooldownBars: 2 },
};

function candle(t: number, c: number, h = c + 1, l = c - 1, o = c): Candle {
  return { t, o, h, l, c, v: 1000 };
}

/** N flat bars at 95 followed by the given final bars. */
function series(finals: Candle[], flatCount = 20): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < flatCount; i++) out.push(candle(T0 + i * HOUR, 95));
  return [...out, ...finals.map((f, i) => ({ ...f, t: T0 + (flatCount + i) * HOUR }))];
}

function deployment(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: 1,
    userId: "u1",
    strategyId: 1,
    backtestRunId: null,
    assetId: 1,
    dsl: DSL,
    interval: "1h",
    venue: "hyperliquid",
    mode: "paper",
    status: "active",
    statusReason: null,
    leverage: 2,
    marginMode: "cross",
    sizingMode: "pct_equity",
    sizingValue: 10,
    maxDrawdownPct: null,
    dailyLossLimitUsd: null,
    walletAddress: null,
    lastBarT: null,
    lastRunAt: null,
    consecutiveErrors: 0,
    claimedAt: null,
    claimedBy: null,
    positionSize: null,
    entryPx: null,
    entryBarT: null,
    entryOid: null,
    tpOid: null,
    slOid: null,
    cooldownLeft: 0,
    baselineEquityUsd: 10_000,
    realizedPnlUsd: 0,
    peakPnlUsd: 0,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...overrides,
  };
}

type Recorded = { type: string; barT?: number; detail?: Record<string, unknown> };

function makeDeps(candles: Candle[], opts: { duplicate?: boolean } = {}) {
  const events: Recorded[] = [];
  const patches: TickPatch[] = [];
  const deps: TickDeps = {
    now: () => candles[candles.length - 1].t + HOUR + 5_000,
    loadCandles: async () => candles,
    recordEvent: async (e) => {
      if (opts.duplicate && e.type === "evaluated") return false;
      events.push({ type: e.type, barT: e.barT, detail: e.detail });
      return true;
    },
    updateDeployment: async (_id, patch) => {
      patches.push(patch);
    },
  };
  return { deps, events, patches };
}

describe("tickDeployment watermark & idempotency", () => {
  it("does nothing when there is no new bar", async () => {
    const candles = series([candle(0, 95)]);
    const last = candles[candles.length - 1].t;
    const { deps, events, patches } = makeDeps(candles);
    const res = await tickDeployment(deployment({ lastBarT: last }), deps);
    expect(res.outcome).toBe("no_new_bar");
    expect(events).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("aborts without state change when another worker already evaluated the bar", async () => {
    const candles = series([candle(0, 105)]);
    const { deps, patches } = makeDeps(candles, { duplicate: true });
    const res = await tickDeployment(deployment(), deps);
    expect(res.outcome).toBe("duplicate");
    expect(patches).toHaveLength(0);
  });

  it("logs skipped bars and never replays stale signals", async () => {
    const candles = series([candle(0, 95), candle(0, 95), candle(0, 95), candle(0, 95)]);
    const last = candles[candles.length - 1].t;
    const { deps, events } = makeDeps(candles);
    // Watermark 4 bars back → 3 missed bars.
    const res = await tickDeployment(deployment({ lastBarT: last - 4 * HOUR }), deps);
    expect(res.outcome).toBe("evaluated");
    const skip = events.find((e) => e.type === "skipped_bars");
    expect(skip?.detail?.gapBars).toBe(3);
  });
});

describe("tickDeployment entries", () => {
  it("enters long on an entry signal with pct-of-equity sizing × leverage", async () => {
    const candles = series([candle(0, 105)]);
    const bar = candles[candles.length - 1];
    const { deps, events, patches } = makeDeps(candles);
    const res = await tickDeployment(deployment(), deps);
    expect(res).toMatchObject({ outcome: "evaluated", action: "entry" });

    const entry = events.find((e) => e.type === "paper_entry");
    expect(entry).toBeDefined();
    // notional = 10000 × 10% × 2x = 2000
    expect(entry!.detail!.notional).toBeCloseTo(2000);
    const patch = patches[0];
    expect(patch.positionSize).toBeGreaterThan(0);
    // Slippage-adjusted entry above the close for a long.
    expect(patch.entryPx!).toBeGreaterThan(bar.c);
    expect(patch.lastBarT).toBe(bar.t);
  });

  it("sizes fixed_usd notionals as given", async () => {
    const candles = series([candle(0, 105)]);
    const { deps, events } = makeDeps(candles);
    await tickDeployment(deployment({ sizingMode: "fixed_usd", sizingValue: 500 }), deps);
    expect(events.find((e) => e.type === "paper_entry")!.detail!.notional).toBe(500);
  });

  it("enters short with negative qty when direction is short", async () => {
    const shortDsl: StrategyDSL = { ...DSL, direction: "short" };
    const candles = series([candle(0, 105)]);
    const { deps, patches } = makeDeps(candles);
    await tickDeployment(deployment({ dsl: shortDsl }), deps);
    expect(patches[0].positionSize).toBeLessThan(0);
    // Short entry slips DOWN (selling).
    expect(patches[0].entryPx!).toBeLessThan(105);
  });

  it("respects cooldown: decrements while flat, no entry", async () => {
    const candles = series([candle(0, 105)]);
    const { deps, events, patches } = makeDeps(candles);
    const res = await tickDeployment(deployment({ cooldownLeft: 2 }), deps);
    expect(res).toMatchObject({ outcome: "evaluated", action: "none" });
    expect(events.find((e) => e.type === "paper_entry")).toBeUndefined();
    expect(patches[0].cooldownLeft).toBe(1);
  });

  it("does not signal during indicator warm-up (three-valued logic)", async () => {
    const smaDsl: StrategyDSL = {
      ...DSL,
      indicators: [{ id: "s", type: "sma", params: { period: 50 } }],
      entry: {
        op: "gt",
        left: { kind: "price", field: "close" },
        right: { kind: "indicator", id: "s" },
      },
    };
    // Only 10 bars — far short of the 50-bar warm-up.
    const candles = series([candle(0, 105)], 9);
    const { deps, events } = makeDeps(candles);
    const res = await tickDeployment(deployment({ dsl: smaDsl }), deps);
    expect(res).toMatchObject({ outcome: "evaluated", action: "none" });
    expect(events.find((e) => e.type === "paper_entry")).toBeUndefined();
  });
});

describe("tickDeployment exits", () => {
  const inPosition = (overrides: Partial<DeploymentRow> = {}) =>
    deployment({ positionSize: 20, entryPx: 100, entryBarT: T0 + 10 * HOUR, ...overrides });

  it("exits on an exit signal at the bar close, records pnl net of fees", async () => {
    // No stop/take on this DSL — otherwise the stop at 95 would preempt any
    // close below 90 (lows always trail closes).
    const noRiskDsl: StrategyDSL = { ...DSL, risk: { positionSizePct: 10, cooldownBars: 2 } };
    const candles = series([candle(0, 85)]); // close < 90 → exit
    const { deps, events, patches } = makeDeps(candles);
    const res = await tickDeployment(inPosition({ dsl: noRiskDsl }), deps);
    expect(res).toMatchObject({ action: "exit" });
    const exit = events.find((e) => e.type === "paper_exit")!;
    expect(exit.detail!.reason).toBe("signal");
    // Loss: entry 100 → ~85, 20 units ≈ -300 minus fees/slippage.
    expect(Number(exit.detail!.pnl)).toBeLessThan(-295);
    expect(patches[0].positionSize).toBeNull();
    expect(patches[0].cooldownLeft).toBe(2); // dsl cooldownBars
  });

  it("stop-loss beats take-profit when both hit in one bar, conservative on gaps", async () => {
    // Entry 100, stop 95, take 110. Bar spans both. Opens at 90 (gap through stop).
    const candles = series([candle(0, 100, 115, 85, 90)]);
    const { deps, events } = makeDeps(candles);
    const res = await tickDeployment(inPosition(), deps);
    expect(res).toMatchObject({ action: "stop" });
    const exit = events.find((e) => e.type === "paper_exit")!;
    expect(exit.detail!.reason).toBe("stop");
    // Gapped through the stop → fills at the open (90), not the stop (95).
    expect(Number(exit.detail!.px)).toBeLessThan(95);
  });

  it("takes profit at the level when reached intrabar", async () => {
    // Bar high 112 ≥ take 110, low stays above stop.
    const candles = series([candle(0, 108, 112, 105, 106)]);
    const { deps, events } = makeDeps(candles);
    const res = await tickDeployment(inPosition(), deps);
    expect(res).toMatchObject({ action: "take_profit" });
    const exit = events.find((e) => e.type === "paper_exit")!;
    // Fills at the take level (110) minus slippage, not the high.
    expect(Number(exit.detail!.px)).toBeGreaterThan(109);
    expect(Number(exit.detail!.px)).toBeLessThan(111);
    expect(Number(exit.detail!.pnl)).toBeGreaterThan(0);
  });

  it("mirrors stops for shorts (stop above entry)", async () => {
    const shortDsl: StrategyDSL = { ...DSL, direction: "short" };
    // Short from 100, stop = 105. Bar high 107 hits it.
    const candles = series([candle(0, 104, 107, 103, 104)]);
    const { deps, events } = makeDeps(candles);
    const res = await tickDeployment(
      deployment({ dsl: shortDsl, positionSize: -20, entryPx: 100, entryBarT: T0 + 10 * HOUR }),
      deps,
    );
    expect(res).toMatchObject({ action: "stop" });
    const exit = events.find((e) => e.type === "paper_exit")!;
    // Buying back above entry → negative pnl.
    expect(Number(exit.detail!.pnl)).toBeLessThan(0);
  });

  it("updates realized and peak pnl on profitable exits", async () => {
    const candles = series([candle(0, 85)]);
    const { deps, patches } = makeDeps(candles);
    await tickDeployment(
      deployment({ positionSize: -20, entryPx: 100, entryBarT: T0, dsl: { ...DSL, direction: "short" } }),
      deps,
    );
    // Short 100, take at 90; the bar gaps to 85 so the fill improves to the
    // open. ≈ +298 gross minus ~11 in fees.
    expect(patches[0].realizedPnlUsd!).toBeGreaterThan(280);
    expect(patches[0].peakPnlUsd!).toBe(patches[0].realizedPnlUsd!);
  });
});
