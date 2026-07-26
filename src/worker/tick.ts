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
 * Paper-mode model (M1) — mirrors the backtest engine where a bar-close
 * runner can (divergences in docs/live-trading.md):
 * - entries/exits fill at the evaluated bar's CLOSE, slippage-adjusted per
 *   side (the backtest fills at the next open; seconds after a close those
 *   are approximately the same price).
 * - stop/take-profit are checked on each new bar's h/l against levels derived
 *   from the entry price, conservative on gaps (fill at the open when the bar
 *   gapped through the level), stop wins when both hit — exactly the engine's
 *   rule.
 * - exit-before-entry, one position, cooldown decrements only while flat —
 *   the engine's ordering.
 */

export type TickPatch = Partial<{
  lastBarT: number;
  lastRunAt: Date;
  positionSize: number | null;
  entryPx: number | null;
  entryBarT: number | null;
  cooldownLeft: number;
  realizedPnlUsd: number;
  peakPnlUsd: number;
  consecutiveErrors: number;
}>;

export type TickDeps = {
  now(): number;
  /** Load closed candles for the deployment's asset. */
  loadCandles(deployment: DeploymentRow, fromMs: number, toMs: number): Promise<Candle[]>;
  /** Append an event; false = another worker already recorded this bar. */
  recordEvent(event: Omit<NewBotEvent, "userId">): Promise<boolean>;
  /** Persist runtime-state changes for this deployment. */
  updateDeployment(id: number, patch: TickPatch): Promise<void>;
};

export type TickResult =
  | { outcome: "no_new_bar" }
  | { outcome: "duplicate" } // another worker won the evaluated-bar race
  | { outcome: "evaluated"; barT: number; action: "none" | "entry" | "exit" | "stop" | "take_profit" };

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

  const direction = dsl.direction ?? "long";
  const sign = direction === "short" ? -1 : 1;
  const qty = deployment.positionSize ?? 0;
  const inPosition = qty !== 0;
  const equity = (deployment.baselineEquityUsd ?? 0) + deployment.realizedPnlUsd;

  const patch: TickPatch = { lastBarT: bar.t, lastRunAt: new Date(now), consecutiveErrors: 0 };
  let action: Extract<TickResult, { outcome: "evaluated" }>["action"] = "none";

  const closePosition = async (
    rawPx: number,
    type: "paper_exit",
    reason: "signal" | "stop" | "take_profit",
  ) => {
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
      type,
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
      await closePosition(px, "paper_exit", "stop");
      action = "stop";
    } else if (takeHit) {
      const px = sign > 0 ? Math.max(bar.o, take!) : Math.min(bar.o, take!);
      await closePosition(px, "paper_exit", "take_profit");
      action = "take_profit";
    } else if (signal.exit) {
      // 2) Signal exit fills at this bar's close.
      await closePosition(bar.c, "paper_exit", "signal");
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
