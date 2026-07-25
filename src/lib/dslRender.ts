// Human-readable rendering of a strategy DSL. Pure — usable from server and
// client components. This is what the user reads to confirm an AI-generated
// strategy matches their intent (M3), and how manual strategies are previewed.
import type { Condition, Operand, StrategyDSL } from "@/server/engine/types";

function renderOperand(operand: Operand): string {
  switch (operand.kind) {
    case "price":
      return operand.field;
    case "const":
      return String(operand.value);
    case "indicator":
      return operand.output && operand.output !== "value"
        ? `${operand.id}.${operand.output}`
        : operand.id;
  }
}

const OP_TEXT: Record<string, string> = {
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

export function renderCondition(cond: Condition): string {
  switch (cond.op) {
    case "and":
      return cond.conditions.map((c) => `(${renderCondition(c)})`).join(" AND ");
    case "or":
      return cond.conditions.map((c) => `(${renderCondition(c)})`).join(" OR ");
    case "not":
      return `NOT (${renderCondition(cond.condition)})`;
    default:
      return `${renderOperand(cond.left)} ${OP_TEXT[cond.op]} ${renderOperand(cond.right)}`;
  }
}

export function renderIndicators(dsl: StrategyDSL): string[] {
  return dsl.indicators.map((ind) => {
    const params = Object.entries(ind.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const source = ind.source && ind.source !== "close" ? ` of ${ind.source}` : "";
    return `${ind.id} = ${ind.type.toUpperCase()}(${params})${source}`;
  });
}

export function renderRisk(dsl: StrategyDSL): string[] {
  const r = dsl.risk;
  const lines = [`position size: ${r.positionSizePct}% of equity`];
  if (r.stopLossPct !== undefined) lines.push(`stop loss: -${r.stopLossPct}%`);
  if (r.takeProfitPct !== undefined) lines.push(`take profit: +${r.takeProfitPct}%`);
  if (r.cooldownBars) lines.push(`cooldown: ${r.cooldownBars} bars after exit`);
  return lines;
}
