import { describe, expect, it, vi } from "vitest";
import type { DeploymentRow } from "@/server/deployments/service";
import { INTERVAL_MS, type Candle } from "@/server/market/types";
import { tickDeployment, type LiveDeps, type TickDeps, type TickPatch } from "@/worker/tick";
import type { StrategyDSL } from "@/server/engine/types";

const HOUR = INTERVAL_MS["1h"];
const T0 = Date.parse("2024-06-01T00:00:00Z");

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

function candle(t: number, c: number): Candle {
  return { t, o: c, h: c + 1, l: c - 1, c, v: 1000 };
}

function series(lastClose: number, flatCount = 20): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < flatCount; i++) out.push(candle(T0 + i * HOUR, 95));
  out.push(candle(T0 + flatCount * HOUR, lastClose));
  return out;
}

function liveDeployment(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: 1,
    userId: "u1",
    strategyId: 1,
    backtestRunId: null,
    assetId: 1,
    dsl: DSL,
    interval: "1h",
    venue: "hyperliquid",
    mode: "live",
    status: "active",
    statusReason: null,
    leverage: 2,
    marginMode: "cross",
    sizingMode: "pct_equity",
    sizingValue: 10,
    maxDrawdownPct: null,
    dailyLossLimitUsd: null,
    walletAddress: "0x1111111111111111111111111111111111111111",
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

function makeDeps(candles: Candle[], live: Partial<LiveDeps>) {
  const events: Recorded[] = [];
  const patches: TickPatch[] = [];
  const liveDeps: LiveDeps = {
    getVenuePosition: vi.fn(async () => ({ size: 0, entryPx: null })),
    getAccountValue: vi.fn(async () => 10_000),
    resolveExpectedExit: vi.fn(async () => ({ reason: "adopted" as const, exitPx: null })),
    executeEntry: vi.fn(async () => ({
      filled: true,
      oid: 100,
      avgPx: 105.05,
      totalSz: 19,
      triggerOids: [101, 102],
      triggerErrors: [],
    })),
    executeClose: vi.fn(async () => ({ filled: true, oid: 200, avgPx: 89.9, totalSz: 19 })),
    ...live,
  };
  const deps: TickDeps = {
    now: () => candles[candles.length - 1].t + HOUR + 5_000,
    loadCandles: async () => candles,
    recordEvent: async (e) => {
      events.push({ type: e.type, barT: e.barT, detail: e.detail });
      return true;
    },
    updateDeployment: async (_id, patch) => {
      patches.push(patch);
    },
    live: liveDeps,
  };
  return { deps, events, patches, liveDeps };
}

describe("live tick entries", () => {
  it("sizes from live account value and records a filled entry with trigger oids", async () => {
    const { deps, events, patches, liveDeps } = makeDeps(series(105), {});
    const res = await tickDeployment(liveDeployment(), deps);
    expect(res).toMatchObject({ outcome: "evaluated", action: "entry" });

    // notional = 10000 × 10% × 2x
    expect(liveDeps.executeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      2000,
    );
    expect(events.map((e) => e.type)).toContain("entry_submitted");
    expect(events.map((e) => e.type)).toContain("entry_filled");
    const patch = patches[0];
    expect(patch.positionSize).toBe(19); // long → positive
    expect(patch.entryPx).toBe(105.05);
    // DSL has both tp and sl → triggers attribute in build order [tp, sl].
    expect(patch.tpOid).toBe("101");
    expect(patch.slOid).toBe("102");
  });

  it("records an error and keeps flat when the IOC entry does not fill", async () => {
    const { deps, events, patches } = makeDeps(series(105), {
      executeEntry: vi.fn(async () => ({
        filled: false,
        oid: 300,
        avgPx: null,
        totalSz: null,
        triggerOids: [],
        triggerErrors: [],
      })),
    });
    const res = await tickDeployment(liveDeployment(), deps);
    expect(res).toMatchObject({ outcome: "evaluated", action: "none" });
    expect(events.map((e) => e.type)).toContain("error");
    expect(patches[0].positionSize).toBeUndefined();
  });

  it("leaves trigger oids null when attribution is ambiguous", async () => {
    const { deps, patches } = makeDeps(series(105), {
      executeEntry: vi.fn(async () => ({
        filled: true,
        oid: 100,
        avgPx: 105,
        totalSz: 19,
        triggerOids: [101], // one of two requested triggers rested
        triggerErrors: ["Price too far"],
      })),
    });
    await tickDeployment(liveDeployment(), deps);
    expect(patches[0].tpOid).toBeNull();
    expect(patches[0].slOid).toBeNull();
  });

  it("respects cooldown while flat", async () => {
    const { deps, patches, liveDeps } = makeDeps(series(105), {});
    await tickDeployment(liveDeployment({ cooldownLeft: 2 }), deps);
    expect(liveDeps.executeEntry).not.toHaveBeenCalled();
    expect(patches[0].cooldownLeft).toBe(1);
  });
});

describe("live tick exits", () => {
  const inPosition = (overrides: Partial<DeploymentRow> = {}) =>
    liveDeployment({
      positionSize: 19,
      entryPx: 100,
      entryBarT: T0,
      entryOid: "100",
      tpOid: "101",
      slOid: "102",
      ...overrides,
    });

  it("closes on an exit signal and books pnl from the fill", async () => {
    const { deps, events, patches, liveDeps } = makeDeps(series(85), {
      getVenuePosition: vi.fn(async () => ({ size: 19, entryPx: 100 })),
    });
    const res = await tickDeployment(inPosition(), deps);
    expect(res).toMatchObject({ action: "exit" });
    expect(liveDeps.executeClose).toHaveBeenCalled();
    const exit = events.find((e) => e.type === "exit_filled")!;
    // (89.9 - 100) × 19
    expect(Number(exit.detail!.pnl)).toBeCloseTo(-191.9, 1);
    expect(patches[0].positionSize).toBeNull();
    expect(patches[0].tpOid).toBeNull();
    expect(patches[0].cooldownLeft).toBe(2);
  });
});

describe("live tick reconciliation", () => {
  const inPosition = () =>
    liveDeployment({ positionSize: 19, entryPx: 100, entryBarT: T0, tpOid: "101", slOid: "102" });

  it("books a take-profit fill discovered on reconcile", async () => {
    const { deps, events, patches } = makeDeps(series(95), {
      getVenuePosition: vi.fn(async () => ({ size: 0, entryPx: null })),
      resolveExpectedExit: vi.fn(async () => ({ reason: "tp_filled" as const, exitPx: 110 })),
    });
    const res = await tickDeployment(inPosition(), deps);
    expect(res).toMatchObject({ action: "reconciled" });
    const evt = events.find((e) => e.type === "tp_filled")!;
    expect(Number(evt.detail!.pnlEstimate)).toBeCloseTo((110 - 100) * 19, 5);
    expect(patches[0].positionSize).toBeNull();
    expect(patches[0].realizedPnlUsd).toBeCloseTo(190, 5);
    expect(patches[0].cooldownLeft).toBe(2);
  });

  it("maps a stop fill to the stop_filled event", async () => {
    const { deps, events } = makeDeps(series(95), {
      getVenuePosition: vi.fn(async () => ({ size: 0, entryPx: null })),
      resolveExpectedExit: vi.fn(async () => ({ reason: "sl_filled" as const, exitPx: 95 })),
    });
    await tickDeployment(inPosition(), deps);
    expect(events.map((e) => e.type)).toContain("stop_filled");
  });

  it("adopts a manual close using the bar close as the pnl estimate", async () => {
    const { deps, events } = makeDeps(series(97), {
      getVenuePosition: vi.fn(async () => ({ size: 0, entryPx: null })),
      resolveExpectedExit: vi.fn(async () => ({ reason: "adopted" as const, exitPx: null })),
    });
    await tickDeployment(inPosition(), deps);
    const evt = events.find((e) => e.type === "reconcile_adopt")!;
    // exitPx unknown → bar close 97 used: (97-100)×19
    expect(Number(evt.detail!.pnlEstimate)).toBeCloseTo(-57, 5);
  });

  it("pauses when the venue holds a position the bot did not open", async () => {
    const { deps, events, patches, liveDeps } = makeDeps(series(105), {
      getVenuePosition: vi.fn(async () => ({ size: 3, entryPx: 90 })),
    });
    const res = await tickDeployment(liveDeployment(), deps);
    expect(res).toMatchObject({ outcome: "paused" });
    expect(events.map((e) => e.type)).toContain("reconcile_pause");
    expect(patches[0].status).toBe("paused");
    expect(patches[0].statusReason).toBe("reconcile");
    // Crucially: no order was placed despite the entry signal.
    expect(liveDeps.executeEntry).not.toHaveBeenCalled();
  });
});
