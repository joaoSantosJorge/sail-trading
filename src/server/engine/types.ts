import { z } from "zod";
import type { Interval } from "../market/types";

export type PriceField = "open" | "high" | "low" | "close" | "volume";

export type IndicatorType =
  | "sma"
  | "ema"
  | "rsi"
  | "macd"
  | "bbands"
  | "atr"
  | "roc"
  | "highest"
  | "lowest";

export type IndicatorDef = {
  id: string;
  type: IndicatorType;
  source?: PriceField; // default "close"; ignored by atr (needs h/l/c)
  params: {
    period?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    stdDev?: number;
  };
};

export type IndicatorOutput = "value" | "macd" | "signal" | "hist" | "upper" | "mid" | "lower";

export type Operand =
  | { kind: "price"; field: PriceField }
  | { kind: "indicator"; id: string; output?: IndicatorOutput }
  | { kind: "const"; value: number };

export type Condition =
  | { op: "gt" | "lt" | "gte" | "lte"; left: Operand; right: Operand }
  | { op: "crosses_above" | "crosses_below"; left: Operand; right: Operand }
  | { op: "and" | "or"; conditions: Condition[] }
  | { op: "not"; condition: Condition };

export type StrategyDSL = {
  version: 1;
  name: string;
  description: string;
  interval: Interval;
  /**
   * Default "long". "short" strategies run ONLY on the perps engine
   * (runBacktest with params.perp) — the spot path throws rather than
   * silently approximating a short.
   */
  direction?: "long" | "short";
  indicators: IndicatorDef[];
  entry: Condition;
  exit: Condition;
  risk: {
    positionSizePct: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    cooldownBars?: number;
  };
};

// ---------- Zod schemas (mirror the types 1:1) ----------

const PriceFieldSchema = z.enum(["open", "high", "low", "close", "volume"]);

const IndicatorDefSchema = z.object({
  id: z.string().min(1).max(32),
  type: z.enum(["sma", "ema", "rsi", "macd", "bbands", "atr", "roc", "highest", "lowest"]),
  source: PriceFieldSchema.optional(),
  params: z.object({
    period: z.number().int().min(2).max(500).optional(),
    fast: z.number().int().min(2).max(500).optional(),
    slow: z.number().int().min(2).max(500).optional(),
    signal: z.number().int().min(2).max(500).optional(),
    stdDev: z.number().min(0.1).max(10).optional(),
  }),
});

const OperandSchema = z.union([
  z.object({ kind: z.literal("price"), field: PriceFieldSchema }),
  z.object({
    kind: z.literal("indicator"),
    id: z.string(),
    output: z.enum(["value", "macd", "signal", "hist", "upper", "mid", "lower"]).optional(),
  }),
  z.object({ kind: z.literal("const"), value: z.number() }),
]);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      op: z.enum(["gt", "lt", "gte", "lte", "crosses_above", "crosses_below"]),
      left: OperandSchema,
      right: OperandSchema,
    }),
    z.object({
      op: z.enum(["and", "or"]),
      conditions: z.array(ConditionSchema).min(1).max(8),
    }),
    z.object({ op: z.literal("not"), condition: ConditionSchema }),
  ]),
) as z.ZodType<Condition>;

export const StrategyDSLSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  description: z.string().max(2000),
  interval: z.enum(["15m", "1h", "4h", "1d"]),
  direction: z.enum(["long", "short"]).optional(),
  indicators: z.array(IndicatorDefSchema).max(8),
  entry: ConditionSchema,
  exit: ConditionSchema,
  risk: z.object({
    positionSizePct: z.number().min(1).max(100),
    stopLossPct: z.number().min(0.1).max(95).optional(),
    takeProfitPct: z.number().min(0.1).max(1000).optional(),
    cooldownBars: z.number().int().min(0).max(500).optional(),
  }),
});

// ---------- Semantic validation (what Zod alone can't express) ----------

const OUTPUTS_BY_TYPE: Record<IndicatorType, IndicatorOutput[]> = {
  sma: ["value"],
  ema: ["value"],
  rsi: ["value"],
  roc: ["value"],
  atr: ["value"],
  highest: ["value"],
  lowest: ["value"],
  macd: ["macd", "signal", "hist"],
  bbands: ["upper", "mid", "lower"],
};

const REQUIRED_PARAMS: Record<IndicatorType, ("period" | "fast" | "slow" | "signal" | "stdDev")[]> = {
  sma: ["period"],
  ema: ["period"],
  rsi: ["period"],
  roc: ["period"],
  atr: ["period"],
  highest: ["period"],
  lowest: ["period"],
  macd: ["fast", "slow", "signal"],
  bbands: ["period", "stdDev"],
};

function conditionDepth(cond: Condition): number {
  if (cond.op === "and" || cond.op === "or") {
    return 1 + Math.max(...cond.conditions.map(conditionDepth));
  }
  if (cond.op === "not") return 1 + conditionDepth(cond.condition);
  return 1;
}

function collectIndicatorRefs(cond: Condition, out: { id: string; output?: IndicatorOutput }[]): void {
  switch (cond.op) {
    case "and":
    case "or":
      cond.conditions.forEach((c) => collectIndicatorRefs(c, out));
      break;
    case "not":
      collectIndicatorRefs(cond.condition, out);
      break;
    default:
      for (const operand of [cond.left, cond.right]) {
        if (operand.kind === "indicator") out.push(operand);
      }
  }
}

/** Longest warm-up any indicator needs before it produces values. */
export function warmupBars(dsl: StrategyDSL): number {
  let max = 1;
  for (const ind of dsl.indicators) {
    const { period = 0, fast = 0, slow = 0, signal = 0 } = ind.params;
    max = Math.max(max, period, fast + signal, slow + signal);
  }
  return max;
}

/** Returns human-readable problems; empty array means the DSL is sound. */
export function validateSemantics(dsl: StrategyDSL): string[] {
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const ind of dsl.indicators) {
    if (ids.has(ind.id)) errors.push(`duplicate indicator id "${ind.id}"`);
    ids.add(ind.id);
    for (const p of REQUIRED_PARAMS[ind.type]) {
      if (ind.params[p] === undefined) {
        errors.push(`indicator "${ind.id}" (${ind.type}) is missing required param "${p}"`);
      }
    }
    if (ind.type === "macd" && ind.params.fast && ind.params.slow && ind.params.fast >= ind.params.slow) {
      errors.push(`indicator "${ind.id}": macd fast period must be < slow period`);
    }
  }

  const byId = new Map(dsl.indicators.map((i) => [i.id, i]));
  for (const [label, cond] of [
    ["entry", dsl.entry],
    ["exit", dsl.exit],
  ] as const) {
    if (conditionDepth(cond) > 3) errors.push(`${label} condition nests deeper than 3 levels`);
    const refs: { id: string; output?: IndicatorOutput }[] = [];
    collectIndicatorRefs(cond, refs);
    for (const ref of refs) {
      const ind = byId.get(ref.id);
      if (!ind) {
        errors.push(`${label} references undeclared indicator "${ref.id}"`);
        continue;
      }
      const allowed = OUTPUTS_BY_TYPE[ind.type];
      const output = ref.output ?? "value";
      if (!allowed.includes(output)) {
        errors.push(
          `${label} uses output "${output}" of "${ref.id}" (${ind.type}); allowed: ${allowed.join(", ")}`,
        );
      }
    }
  }

  return errors;
}

/** Full parse + semantic check. Throws with readable message on failure. */
export function parseStrategyDSL(raw: unknown): StrategyDSL {
  const parsed = StrategyDSLSchema.parse(raw) as StrategyDSL;
  const problems = validateSemantics(parsed);
  if (problems.length > 0) {
    throw new Error(`invalid strategy: ${problems.join("; ")}`);
  }
  return parsed;
}
