import type { Candle } from "../market/types";
import { atr, bbands, ema, highest, lowest, macd, roc, rsi, sma } from "./indicators";
import type { Condition, Operand, PriceField, StrategyDSL } from "./types";

type Series = Record<string, number[]>; // output name -> aligned values

export type EvalContext = {
  candles: Candle[];
  fields: Record<PriceField, number[]>;
  indicators: Map<string, Series>;
};

function priceField(candles: Candle[], field: PriceField): number[] {
  switch (field) {
    case "open":
      return candles.map((c) => c.o);
    case "high":
      return candles.map((c) => c.h);
    case "low":
      return candles.map((c) => c.l);
    case "close":
      return candles.map((c) => c.c);
    case "volume":
      return candles.map((c) => c.v);
  }
}

export function buildContext(dsl: StrategyDSL, candles: Candle[]): EvalContext {
  const fields: Record<PriceField, number[]> = {
    open: priceField(candles, "open"),
    high: priceField(candles, "high"),
    low: priceField(candles, "low"),
    close: priceField(candles, "close"),
    volume: priceField(candles, "volume"),
  };

  const indicators = new Map<string, Series>();
  for (const ind of dsl.indicators) {
    const src = fields[ind.source ?? "close"];
    const p = ind.params;
    switch (ind.type) {
      case "sma":
        indicators.set(ind.id, { value: sma(src, p.period!) });
        break;
      case "ema":
        indicators.set(ind.id, { value: ema(src, p.period!) });
        break;
      case "rsi":
        indicators.set(ind.id, { value: rsi(src, p.period!) });
        break;
      case "roc":
        indicators.set(ind.id, { value: roc(src, p.period!) });
        break;
      case "highest":
        indicators.set(ind.id, { value: highest(src, p.period!) });
        break;
      case "lowest":
        indicators.set(ind.id, { value: lowest(src, p.period!) });
        break;
      case "atr":
        indicators.set(ind.id, { value: atr(candles, p.period!) });
        break;
      case "macd":
        indicators.set(ind.id, macd(src, p.fast!, p.slow!, p.signal!));
        break;
      case "bbands":
        indicators.set(ind.id, bbands(src, p.period!, p.stdDev!));
        break;
    }
  }

  return { candles, fields, indicators };
}

function operandValue(operand: Operand, i: number, ctx: EvalContext): number {
  if (i < 0) return NaN;
  switch (operand.kind) {
    case "const":
      return operand.value;
    case "price":
      return ctx.fields[operand.field][i];
    case "indicator": {
      const series = ctx.indicators.get(operand.id)!;
      return series[operand.output ?? "value"][i];
    }
  }
}

/**
 * Three-valued evaluation: null means "unknown" (a NaN operand, i.e.
 * indicator warm-up). Unknown propagates through not/and/or so that warm-up
 * can never flip into a tradeable signal — `not(unknown)` stays unknown
 * rather than becoming true. The top level treats unknown as false.
 */
function evalCondition3(cond: Condition, i: number, ctx: EvalContext): boolean | null {
  switch (cond.op) {
    case "and": {
      const results = cond.conditions.map((c) => evalCondition3(c, i, ctx));
      if (results.some((r) => r === false)) return false;
      if (results.some((r) => r === null)) return null;
      return true;
    }
    case "or": {
      const results = cond.conditions.map((c) => evalCondition3(c, i, ctx));
      if (results.some((r) => r === true)) return true;
      if (results.some((r) => r === null)) return null;
      return false;
    }
    case "not": {
      const r = evalCondition3(cond.condition, i, ctx);
      return r === null ? null : !r;
    }
    case "gt":
    case "lt":
    case "gte":
    case "lte": {
      const l = operandValue(cond.left, i, ctx);
      const r = operandValue(cond.right, i, ctx);
      if (Number.isNaN(l) || Number.isNaN(r)) return null;
      if (cond.op === "gt") return l > r;
      if (cond.op === "lt") return l < r;
      if (cond.op === "gte") return l >= r;
      return l <= r;
    }
    case "crosses_above":
    case "crosses_below": {
      const l0 = operandValue(cond.left, i - 1, ctx);
      const r0 = operandValue(cond.right, i - 1, ctx);
      const l1 = operandValue(cond.left, i, ctx);
      const r1 = operandValue(cond.right, i, ctx);
      if ([l0, r0, l1, r1].some(Number.isNaN)) return null;
      return cond.op === "crosses_above" ? l0 <= r0 && l1 > r1 : l0 >= r0 && l1 < r1;
    }
  }
}

export function evalCondition(cond: Condition, i: number, ctx: EvalContext): boolean {
  return evalCondition3(cond, i, ctx) === true;
}

export type BarSignals = { entry: boolean; exit: boolean };

export function computeSignals(dsl: StrategyDSL, candles: Candle[]): BarSignals[] {
  const ctx = buildContext(dsl, candles);
  return candles.map((_, i) => ({
    entry: evalCondition(dsl.entry, i, ctx),
    exit: evalCondition(dsl.exit, i, ctx),
  }));
}
