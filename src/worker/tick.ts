import type { DeploymentRow } from "@/server/deployments/service";
import type { NewBotEvent } from "@/server/deployments/events";
import { computeSignals } from "@/server/engine/interpreter";
import { DEFAULT_PARAMS } from "@/server/engine/backtest";
import { StrategyDSLSchema, warmupBars, type StrategyDSL } from "@/server/engine/types";
import { INTERVAL_MS, type Candle } from "@/server/market/types";

/**
 * One evaluation of one deployment on the latest closed bar. Everything
 * side-effectful is injected so the whole decision matrix is unit-testable
 * (candleCache-style deps).
 *
 * PAPER mode mirrors the backtest engine where a bar-close runner can
 * (divergences in docs/live-trading.md): fills at the evaluated bar's close
 * (slippage-adjusted), stop/TP checked on each new bar's h/l with the
 * engine's rules (stop wins, gaps fill at the open), exit-before-entry,
 * one position, cooldown decrements only while flat.
 *
 * LIVE mode places real Hyperliquid orders through the injected executor
 * (which clamps, aggregate-caps, and signs in the enclave). Stops/TPs are
 * VENUE-SIDE trigger orders placed with the entry, so the tick never
 * emulates them — it reconciles: each bar it compares the venue position
 * with what it expects and resolves fills (tp/sl/manual) before acting.
 */

export type TickPatch = Partial<{
  lastBarT: number;
  lastRunAt: Date;
  positionSize: number | null;
  entryPx: number | null;
  entryBarT: number | null;
  entryOid: string | null;
  tpOid: string | null;
  slOid: string | null;
  cooldownLeft: number;
  realizedPnlUsd: number;
  peakPnlUsd: number;
  consecutiveErrors: number;
  status: string;
  statusReason: string | null;
}>;

/** Venue truth + execution capability, required only for live deployments. */
export type LiveDeps = {
  /** Signed venue position size for this deployment's coin (0 = flat). */
  getVenuePosition(deployment: DeploymentRow): Promise<{ size: number; entryPx: number | null }>;
  /** Live perps account value in USD (sizing basis). */
  getAccountValue(deployment: DeploymentRow): Promise<number>;
  /**
   * When the bot expected a position but the venue is flat: figure out what
   * happened from the resting trigger oids. exitPx null = unknown (manual).
   */
  resolveExpectedExit(
    deployment: DeploymentRow,
  ): Promise<{ reason: "tp_filled" | "sl_filled" | "adopted"; exitPx: number | null }>;
  executeEntry(
    deployment: DeploymentRow,
    dsl: StrategyDSL,
    barT: number,
    notionalUsd: number,
  ): Promise<{ filled: boolean; oid: number | null; avgPx: number | null; totalSz: number | null; triggerOids: number[]; triggerErrors: string[] }>;
  executeClose(
    deployment: DeploymentRow,
    barT: number,
  ): Promise<{ filled: boolean; oid: number | null; avgPx: number | null; totalSz: number | null }>;
};

export type TickDeps = {
  now(): number;
  /** Load closed candles for the deployment's asset. */
  loadCandles(deployment: DeploymentRow, fromMs: number, toMs: number): Promise<Candle[]>;
  /** Append an event; false = another worker already recorded this bar. */
  recordEvent(event: Omit<NewBotEvent, "userId">): Promise<boolean>;
  /** Persist runtime-state changes for this deployment. */
  updateDeployment(id: number, patch: TickPatch): Promise<void>;
  /** Required when ticking live deployments. */
  live?: LiveDeps;
};

export type TickResult =
  | { outcome: "no_new_bar" }
  | { outcome: "duplicate" } // another worker won the evaluated-bar race
  | { outcome: "paused"; reason: string }
  | {
      outcome: "evaluated";
      barT: number;
      action: "none" | "entry" | "exit" | "stop" | "take_profit" | "reconciled";
    };

const FEE_BPS = DEFAULT_PARAMS.feeBps;
const SLIPPAGE_BPS = DEFAULT_PARAMS.slippageBps;

export async function tickDeployment(deployment: DeploymentRow, deps: TickDeps): Promise<TickResult> {
  const dsl = StrategyDSLSchema.parse(deployment.dsl) as StrategyDSL;
  const ms = INTERVAL_MS[dsl.interval];
  const now = deps.now();
  // Warm-up plus a small tail so crosses_* always has its previous bar.
  const from = now - (warmupBars(dsl) + 12) * ms;
  const candles = await deps.loadCandles(deployment, from, now);
  if (candles.length === 0) return { outcome: "no_new_bar" };

  const bar = candles[candles.length - 1];
  if (deployment.lastBarT !== null && bar.t <= deployment.lastBarT) {
    return { outcome: "no_new_bar" };
  }

  const signals = computeSignals(dsl, candles);
  const signal = signals[signals.length - 1];

  // Idempotency gate: exactly one worker may act on this bar.
  const fresh = await deps.recordEvent({
    deploymentId: deployment.id,
    type: "evaluated",
    barT: bar.t,
    signal,
  });
  if (!fresh) return { outcome: "duplicate" };

  // Bars missed while the worker was down are never replayed — stale signals
  // must not fire. We evaluate the latest bar only and log the gap.
  if (deployment.lastBarT !== null) {
    const gapBars = Math.round((bar.t - deployment.lastBarT) / ms) - 1;
    if (gapBars > 0) {
      await deps.recordEvent({
        deploymentId: deployment.id,
        type: "skipped_bars",
        barT: bar.t,
        detail: { gapBars },
      });
    }
  }

  if (deployment.mode === "live") {
    if (!deps.live) throw new Error("live deployment ticked without live deps");
    return tickLive(deployment, dsl, bar, signal, deps, deps.live);
  }
  return tickPaper(deployment, dsl, bar, signal, deps);
}

// ---------------------------------------------------------------------------
// Paper
// ---------------------------------------------------------------------------

async function tickPaper(
  deployment: DeploymentRow,
  dsl: StrategyDSL,
  bar: Candle,
  signal: { entry: boolean; exit: boolean },
  deps: TickDeps,
): Promise<TickResult> {
  const direction = dsl.direction ?? "long";
  const sign = direction === "short" ? -1 : 1;
  const qty = deployment.positionSize ?? 0;
  const inPosition = qty !== 0;
  const equity = (deployment.baselineEquityUsd ?? 0) + deployment.realizedPnlUsd;

  const patch: TickPatch = { lastBarT: bar.t, lastRunAt: new Date(deps.now()), consecutiveErrors: 0 };
  let action: Extract<TickResult, { outcome: "evaluated" }>["action"] = "none";

  const closePosition = async (rawPx: number, reason: "signal" | "stop" | "take_profit") => {
    const exitPx = rawPx * (1 - (sign * SLIPPAGE_BPS) / 10_000);
    const entryPx = deployment.entryPx ?? exitPx;
    const grossPnl = (exitPx - entryPx) * qty;
    const fees = (Math.abs(qty) * (entryPx + exitPx) * FEE_BPS) / 10_000;
    const pnl = grossPnl - fees;
    patch.positionSize = null;
    patch.entryPx = null;
    patch.entryBarT = null;
    patch.cooldownLeft = dsl.risk.cooldownBars ?? 0;
    patch.realizedPnlUsd = deployment.realizedPnlUsd + pnl;
    patch.peakPnlUsd = Math.max(deployment.peakPnlUsd, patch.realizedPnlUsd);
    await deps.recordEvent({
      deploymentId: deployment.id,
      type: "paper_exit",
      barT: bar.t,
      detail: { px: exitPx, qty, pnl, reason },
    });
  };

  if (inPosition) {
    // 1) Intrabar stop / take-profit on the new bar — engine rule: stop wins,
    //    gaps fill at the open.
    const entryPx = deployment.entryPx ?? bar.c;
    const stop =
      dsl.risk.stopLossPct !== undefined ? entryPx * (1 - (sign * dsl.risk.stopLossPct) / 100) : undefined;
    const take =
      dsl.risk.takeProfitPct !== undefined ? entryPx * (1 + (sign * dsl.risk.takeProfitPct) / 100) : undefined;
    const stopHit = stop !== undefined && (sign > 0 ? bar.l <= stop : bar.h >= stop);
    const takeHit = take !== undefined && (sign > 0 ? bar.h >= take : bar.l <= take);
    if (stopHit) {
      const px = sign > 0 ? Math.min(bar.o, stop!) : Math.max(bar.o, stop!);
      await closePosition(px, "stop");
      action = "stop";
    } else if (takeHit) {
      const px = sign > 0 ? Math.max(bar.o, take!) : Math.min(bar.o, take!);
      await closePosition(px, "take_profit");
      action = "take_profit";
    } else if (signal.exit) {
      // 2) Signal exit fills at this bar's close.
      await closePosition(bar.c, "signal");
      action = "exit";
    }
  } else if (deployment.cooldownLeft > 0) {
    patch.cooldownLeft = deployment.cooldownLeft - 1;
  } else if (signal.entry && equity > 0) {
    const entryPx = bar.c * (1 + (sign * SLIPPAGE_BPS) / 10_000);
    const notional =
      deployment.sizingMode === "pct_equity"
        ? ((equity * deployment.sizingValue) / 100) * deployment.leverage
        : deployment.sizingValue;
    const newQty = (notional / entryPx) * sign;
    patch.positionSize = newQty;
    patch.entryPx = entryPx;
    patch.entryBarT = bar.t;
    await deps.recordEvent({
      deploymentId: deployment.id,
      type: "paper_entry",
      barT: bar.t,
      detail: { px: entryPx, qty: newQty, notional, leverage: deployment.leverage },
    });
    action = "entry";
  }

  await deps.updateDeployment(deployment.id, patch);
  return { outcome: "evaluated", barT: bar.t, action };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

async function tickLive(
  deployment: DeploymentRow,
  dsl: StrategyDSL,
  bar: Candle,
  signal: { entry: boolean; exit: boolean },
  deps: TickDeps,
  live: LiveDeps,
): Promise<TickResult> {
  const direction = dsl.direction ?? "long";
  const sign = direction === "short" ? -1 : 1;
  const expected = deployment.positionSize ?? 0;

  const patch: TickPatch = { lastBarT: bar.t, lastRunAt: new Date(deps.now()), consecutiveErrors: 0 };
  let action: Extract<TickResult, { outcome: "evaluated" }>["action"] = "none";

  // --- Reconcile: the venue is the source of truth -------------------------
  const venue = await live.getVenuePosition(deployment);
  let inPosition = expected !== 0;

  if (expected !== 0 && venue.size === 0) {
    // Position gone: a venue-side trigger filled, or the user closed it.
    const resolution = await live.resolveExpectedExit(deployment);
    const exitPx = resolution.exitPx ?? bar.c;
    const entryPx = deployment.entryPx ?? exitPx;
    const pnl = (exitPx - entryPx) * expected;
    patch.positionSize = null;
    patch.entryPx = null;
    patch.entryBarT = null;
    patch.entryOid = null;
    patch.tpOid = null;
    patch.slOid = null;
    patch.cooldownLeft = dsl.risk.cooldownBars ?? 0;
    patch.realizedPnlUsd = deployment.realizedPnlUsd + pnl;
    patch.peakPnlUsd = Math.max(deployment.peakPnlUsd, patch.realizedPnlUsd);
    inPosition = false;
    action = "reconciled";
    const eventType =
      resolution.reason === "adopted"
        ? ("reconcile_adopt" as const)
        : resolution.reason === "sl_filled"
          ? ("stop_filled" as const)
          : ("tp_filled" as const);
    await deps.recordEvent({
      deploymentId: deployment.id,
      type: eventType,
      barT: bar.t,
      detail: { exitPx: resolution.exitPx, pnlEstimate: pnl },
    });
  } else if (expected === 0 && venue.size !== 0) {
    // A position this bot didn't open exists on its coin — attribution is
    // impossible, so pause rather than fight the user (or another system).
    patch.status = "paused";
    patch.statusReason = "reconcile";
    await deps.recordEvent({
      deploymentId: deployment.id,
      type: "reconcile_pause",
      barT: bar.t,
      detail: { venueSize: venue.size },
    });
    await deps.updateDeployment(deployment.id, patch);
    return { outcome: "paused", reason: "unexpected venue position" };
  }

  // --- Act on the signal ----------------------------------------------------
  if (inPosition && signal.exit) {
    await deps.recordEvent({ deploymentId: deployment.id, type: "exit_submitted", barT: bar.t });
    const res = await live.executeClose(deployment, bar.t);
    const exitPx = res.avgPx ?? bar.c;
    const entryPx = deployment.entryPx ?? exitPx;
    const pnl = (exitPx - entryPx) * expected;
    patch.positionSize = null;
    patch.entryPx = null;
    patch.entryBarT = null;
    patch.entryOid = null;
    patch.tpOid = null;
    patch.slOid = null;
    patch.cooldownLeft = dsl.risk.cooldownBars ?? 0;
    patch.realizedPnlUsd = deployment.realizedPnlUsd + pnl;
    patch.peakPnlUsd = Math.max(deployment.peakPnlUsd, patch.realizedPnlUsd);
    action = "exit";
    await deps.recordEvent({
      deploymentId: deployment.id,
      type: "exit_filled",
      barT: bar.t,
      detail: { oid: res.oid, px: res.avgPx, sz: res.totalSz, pnl },
    });
  } else if (!inPosition && deployment.cooldownLeft > 0) {
    patch.cooldownLeft = deployment.cooldownLeft - 1;
  } else if (!inPosition && signal.entry) {
    const accountValue = await live.getAccountValue(deployment);
    const notional =
      deployment.sizingMode === "pct_equity"
        ? ((accountValue * deployment.sizingValue) / 100) * deployment.leverage
        : deployment.sizingValue;
    await deps.recordEvent({
      deploymentId: deployment.id,
      type: "entry_submitted",
      barT: bar.t,
      detail: { notional, leverage: deployment.leverage },
    });
    const res = await live.executeEntry(deployment, dsl, bar.t, notional);
    if (res.filled && res.totalSz !== null) {
      patch.positionSize = res.totalSz * sign;
      patch.entryPx = res.avgPx;
      patch.entryBarT = bar.t;
      patch.entryOid = res.oid !== null ? String(res.oid) : null;
      // Trigger oids arrive in build order [tp?, sl?]. Attribution is only
      // safe when every requested trigger rested; otherwise leave them null
      // (the trigger_errors in the event trail say what happened).
      const requested: ("tp" | "sl")[] = [
        ...(dsl.risk.takeProfitPct !== undefined ? (["tp"] as const) : []),
        ...(dsl.risk.stopLossPct !== undefined ? (["sl"] as const) : []),
      ];
      patch.tpOid = null;
      patch.slOid = null;
      if (res.triggerOids.length === requested.length) {
        requested.forEach((kind, i) => {
          if (kind === "tp") patch.tpOid = String(res.triggerOids[i]);
          else patch.slOid = String(res.triggerOids[i]);
        });
      }
      action = "entry";
      await deps.recordEvent({
        deploymentId: deployment.id,
        type: "entry_filled",
        barT: bar.t,
        detail: {
          oid: res.oid,
          px: res.avgPx,
          sz: res.totalSz,
          triggerOids: res.triggerOids,
          triggerErrors: res.triggerErrors,
        },
      });
    } else {
      // IOC that didn't fill: no position, no retry — next signal bar tries
      // again. The event trail shows what happened.
      await deps.recordEvent({
        deploymentId: deployment.id,
        type: "error",
        barT: bar.t,
        detail: { error: "entry did not fill (IOC)", oid: res.oid },
      });
    }
  }

  await deps.updateDeployment(deployment.id, patch);
  return { outcome: "evaluated", barT: bar.t, action };
}
