import type { Candle } from "../market/types";
import { computeSignals } from "./interpreter";
import { computeMetrics, type Metrics } from "./metrics";
import type { StrategyDSL } from "./types";

export type PerpParams = {
  /** Position leverage — notional = equity × positionSizePct% × leverage. */
  leverage: number;
  /** Maintenance-margin fraction of position notional (e.g. 0.005 = 0.5%). */
  maintenanceMarginFraction: number;
  /**
   * Funding accrued per BAR while a position is open, as a fraction of
   * position notional at that bar's close; positive = longs pay. Must align
   * 1:1 with the candles array. Passed IN as data — the engine never fetches.
   */
  fundingPerBar?: number[];
};

export type BacktestParams = {
  feeBps: number; // per side
  slippageBps: number; // per side, applied to fill price
  gasUsd: number; // flat per fill
  initialEquity: number;
  /** Present = perps mode: shorts/leverage/funding/liquidation become legal. */
  perp?: PerpParams;
};

export const DEFAULT_PARAMS: BacktestParams = {
  feeBps: 30,
  slippageBps: 10,
  gasUsd: 1,
  initialEquity: 10_000,
};

export type Trade = {
  direction?: "long" | "short"; // absent in runs stored before perps support = long
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: "signal" | "stop" | "take_profit" | "liquidation" | "end_of_data";
};

export type EquityPoint = { t: number; equity: number };

export type BacktestResult = {
  trades: Trade[];
  equityCurve: EquityPoint[];
  metrics: Metrics;
};

/**
 * Deterministic simulation. Signals are evaluated on closed bar i and fill at
 * open[i+1] — never on the signal bar itself (no lookahead). Stops/
 * take-profits are checked intrabar on the current bar's h/l.
 *
 * Two modes:
 * - Spot (default): long-only, the original accounting, byte-identical to
 *   pre-perps behavior. A `direction: "short"` DSL throws here — shorting is
 *   NEVER silently approximated.
 * - Perps (`params.perp` set): signed positions with leverage, per-bar
 *   funding, and intrabar liquidation (see runPerpBacktest).
 */
export function runBacktest(
  dsl: StrategyDSL,
  candles: Candle[],
  params: BacktestParams = DEFAULT_PARAMS,
): BacktestResult {
  if (params.perp) return runPerpBacktest(dsl, candles, params);
  if (dsl.direction === "short") {
    throw new Error(
      'strategy direction is "short" but no perp params were given — shorts run only on the perps engine (pass params.perp)',
    );
  }
  const signals = computeSignals(dsl, candles);
  const { feeBps, slippageBps, gasUsd, initialEquity } = params;

  let cash = initialEquity;
  let qty = 0;
  let entryPrice = 0;
  let entryT = 0;
  let cooldownLeft = 0;
  let pendingEntry = false;
  let pendingExit: Trade["exitReason"] | null = null;

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const buy = (rawPrice: number, t: number) => {
    const price = rawPrice * (1 + slippageBps / 10_000);
    const equity = cash; // flat when buying
    const notional = (equity * dsl.risk.positionSizePct) / 100;
    const fee = notional * (feeBps / 10_000);
    const spend = Math.min(notional + fee + gasUsd, cash);
    const buyNotional = Math.max(spend - fee - gasUsd, 0);
    qty = buyNotional / price;
    cash -= spend;
    entryPrice = price;
    entryT = t;
  };

  const sell = (rawPrice: number, t: number, reason: Trade["exitReason"]) => {
    const price = rawPrice * (1 - slippageBps / 10_000);
    const notional = qty * price;
    const fee = notional * (feeBps / 10_000);
    cash += notional - fee - gasUsd;
    const cost = qty * entryPrice;
    const pnlUsd = notional - fee - gasUsd - cost;
    trades.push({
      direction: "long",
      entryT,
      entryPrice,
      exitT: t,
      exitPrice: price,
      qty,
      pnlUsd,
      pnlPct: (pnlUsd / cost) * 100,
      exitReason: reason,
    });
    qty = 0;
    cooldownLeft = dsl.risk.cooldownBars ?? 0;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // 1) Fills scheduled from the previous bar's signal execute at this open.
    if (pendingExit && qty > 0) {
      sell(bar.o, bar.t, pendingExit);
    }
    pendingExit = null;
    if (pendingEntry && qty === 0 && cooldownLeft === 0) {
      buy(bar.o, bar.t);
    }
    pendingEntry = false;

    // 2) Intrabar stop / take-profit on the current bar.
    if (qty > 0) {
      const stop = dsl.risk.stopLossPct !== undefined ? entryPrice * (1 - dsl.risk.stopLossPct / 100) : undefined;
      const take =
        dsl.risk.takeProfitPct !== undefined ? entryPrice * (1 + dsl.risk.takeProfitPct / 100) : undefined;
      // Conservative: a gap through the level fills at the open, otherwise at
      // the level itself. If both could hit in one bar, assume the stop hit.
      if (stop !== undefined && bar.l <= stop) {
        sell(Math.min(bar.o, stop), bar.t, "stop");
      } else if (take !== undefined && bar.h >= take) {
        sell(Math.max(bar.o, take), bar.t, "take_profit");
      }
    }

    // 3) Evaluate signals on this (closed) bar; fills happen next bar.
    if (qty > 0 && signals[i].exit) {
      pendingExit = "signal";
    } else if (qty === 0 && signals[i].entry && cooldownLeft === 0) {
      pendingEntry = true;
    }

    if (cooldownLeft > 0 && qty === 0) cooldownLeft -= 1;

    equityCurve.push({ t: bar.t, equity: cash + qty * bar.c });
  }

  // Mark-to-market close of any open position on the final bar.
  if (qty > 0) {
    const last = candles[candles.length - 1];
    sell(last.c, last.t, "end_of_data");
    equityCurve[equityCurve.length - 1] = { t: last.t, equity: cash };
  }

  return {
    trades,
    equityCurve,
    metrics: computeMetrics(equityCurve, trades, candles, params),
  };
}

/**
 * Perps-mode simulation — the ONLY place shorts are legal. One signed
 * position, USD (cross) collateral. Model assumptions, all deliberate
 * approximations of venue mechanics (surfaced to the caller via run
 * assumptions):
 * - Notional = equity × positionSizePct% × leverage; fees/slippage per side
 *   on notional; gasUsd still applies flat per fill (set 0 for pure perps).
 * - Funding accrues per bar on |position| × close, positive = longs pay.
 *   Applied before intrabar risk checks, only while a position is open.
 * - Liquidation fires when intrabar equity ≤ maintenanceMarginFraction ×
 *   position notional, at the solved liquidation price (or the open, if the
 *   bar gapped through it). Liquidation precedes stop/take when both could
 *   hit in one bar (pessimistic). Account equity is floored at 0 on a
 *   liquidation exit — losses cannot exceed the account.
 * - No lookahead: signal on bar i fills at open[i+1]; funding/liquidation use
 *   only bar i data on bar i.
 */
function runPerpBacktest(
  dsl: StrategyDSL,
  candles: Candle[],
  params: BacktestParams,
): BacktestResult {
  const signals = computeSignals(dsl, candles);
  const { feeBps, slippageBps, gasUsd, initialEquity } = params;
  const perp = params.perp!;
  if (perp.leverage < 1) throw new Error("perp.leverage must be >= 1");
  if (perp.fundingPerBar && perp.fundingPerBar.length !== candles.length) {
    throw new Error(
      `fundingPerBar length ${perp.fundingPerBar.length} must match candles length ${candles.length}`,
    );
  }
  const direction = dsl.direction ?? "long";
  const dir = direction === "long" ? 1 : -1;
  const mmf = perp.maintenanceMarginFraction;

  let cash = initialEquity; // account equity while flat; excludes uPnL while open
  let sq = 0; // signed position size (+long / −short), coin units
  let entryPrice = 0;
  let entryT = 0;
  let entryCosts = 0;
  let cooldownLeft = 0;
  let pendingEntry = false;
  let pendingExit: Trade["exitReason"] | null = null;

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const open = (rawPrice: number, t: number) => {
    // Long entries buy (pay slippage up), short entries sell (receive less).
    const price = rawPrice * (1 + dir * (slippageBps / 10_000));
    const notional = ((cash * dsl.risk.positionSizePct) / 100) * perp.leverage;
    if (notional <= 0) return; // account is empty — cannot open
    const fee = notional * (feeBps / 10_000);
    cash -= fee + gasUsd;
    entryCosts = fee + gasUsd;
    sq = (dir * notional) / price;
    entryPrice = price;
    entryT = t;
  };

  const close = (rawPrice: number, t: number, reason: Trade["exitReason"]) => {
    // Closing trades in the opposite direction: longs sell, shorts buy back.
    const price = rawPrice * (1 - dir * (slippageBps / 10_000));
    const grossPnl = sq * (price - entryPrice);
    const fee = Math.abs(sq) * price * (feeBps / 10_000);
    cash += grossPnl - fee - gasUsd;
    if (reason === "liquidation") cash = Math.max(cash, 0);
    const entryNotional = Math.abs(sq) * entryPrice;
    const pnlUsd = grossPnl - fee - gasUsd - entryCosts;
    trades.push({
      direction,
      entryT,
      entryPrice,
      exitT: t,
      exitPrice: price,
      qty: Math.abs(sq),
      pnlUsd,
      pnlPct: (pnlUsd / entryNotional) * 100,
      exitReason: reason,
    });
    sq = 0;
    entryCosts = 0;
    cooldownLeft = dsl.risk.cooldownBars ?? 0;
  };

  /** Price at which intrabar equity hits the maintenance margin, or null. */
  const liquidationPrice = (): number | null => {
    const q = Math.abs(sq);
    if (q === 0) return null;
    const p =
      sq > 0
        ? (q * entryPrice - cash) / (q * (1 - mmf)) // equity falls as price falls
        : (cash + q * entryPrice) / (q * (1 + mmf)); // equity falls as price rises
    return p > 0 ? p : null;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // 1) Fills scheduled from the previous bar's signal execute at this open.
    if (pendingExit && sq !== 0) {
      close(bar.o, bar.t, pendingExit);
    }
    pendingExit = null;
    if (pendingEntry && sq === 0 && cooldownLeft === 0) {
      open(bar.o, bar.t);
    }
    pendingEntry = false;

    if (sq !== 0) {
      // 2) Funding accrual on this bar (positive rate: longs pay, shorts receive).
      const rate = perp.fundingPerBar?.[i] ?? 0;
      if (rate !== 0) cash -= sq * rate * bar.c;

      // 3) Intrabar liquidation — checked before stop/take (pessimistic).
      const liq = liquidationPrice();
      if (liq !== null && (sq > 0 ? bar.l <= liq : bar.h >= liq)) {
        close(sq > 0 ? Math.min(bar.o, liq) : Math.max(bar.o, liq), bar.t, "liquidation");
      }
    }

    // 4) Intrabar stop / take-profit, mirrored for shorts.
    if (sq !== 0) {
      const sl = dsl.risk.stopLossPct;
      const tp = dsl.risk.takeProfitPct;
      const stop = sl !== undefined ? entryPrice * (1 - dir * (sl / 100)) : undefined;
      const take = tp !== undefined ? entryPrice * (1 + dir * (tp / 100)) : undefined;
      if (stop !== undefined && (sq > 0 ? bar.l <= stop : bar.h >= stop)) {
        close(sq > 0 ? Math.min(bar.o, stop) : Math.max(bar.o, stop), bar.t, "stop");
      } else if (take !== undefined && (sq > 0 ? bar.h >= take : bar.l <= take)) {
        close(sq > 0 ? Math.max(bar.o, take) : Math.min(bar.o, take), bar.t, "take_profit");
      }
    }

    // 5) Evaluate signals on this (closed) bar; fills happen next bar.
    if (sq !== 0 && signals[i].exit) {
      pendingExit = "signal";
    } else if (sq === 0 && signals[i].entry && cooldownLeft === 0 && cash > 0) {
      pendingEntry = true;
    }

    if (cooldownLeft > 0 && sq === 0) cooldownLeft -= 1;

    equityCurve.push({ t: bar.t, equity: cash + sq * (bar.c - entryPrice) });
  }

  // Mark-to-market close of any open position on the final bar.
  if (sq !== 0) {
    const last = candles[candles.length - 1];
    close(last.c, last.t, "end_of_data");
    equityCurve[equityCurve.length - 1] = { t: last.t, equity: cash };
  }

  return {
    trades,
    equityCurve,
    metrics: computeMetrics(equityCurve, trades, candles, params),
  };
}
