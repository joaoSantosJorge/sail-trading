import { formatPx } from "@/lib/hyperliquid/format";
import type { ValidatedPerpProposal } from "./perpProposals";

/**
 * Pure builder for the Hyperliquid order action a quote mints. Extracted from
 * the quote route so the exact wire shape is unit-tested: key order matters —
 * the browser agent key signs these objects verbatim and the L1 action hash
 * is computed over the msgpack of exactly this structure.
 */

/**
 * How far through the trigger price the triggered MARKET exit may fill
 * (its limit px). Matches the Hyperliquid UI default of 10%.
 */
export const TRIGGER_SLIPPAGE_PCT = 10;

export type PerpOrderQuote = {
  orderAction: {
    type: "order";
    orders: Record<string, unknown>[];
    grouping: "na" | "normalTpsl";
  };
  /** Entry wire price (echo of the input). */
  px: string;
  /** Stop-loss trigger price, null when the proposal has none. */
  slPx: string | null;
  /** Take-profit trigger price, null when the proposal has none. */
  tpPx: string | null;
};

/**
 * Build the order action for a proposal: the entry order plus optional
 * reduce-only TP/SL trigger exits, grouped as normalTpsl so the venue links
 * them to the entry (children rest until the entry fills; one exit filling
 * cancels the other).
 */
export function buildPerpOrderAction(
  proposal: ValidatedPerpProposal,
  assetIndex: number,
  entryPx: string,
): PerpOrderQuote {
  const entryOrder = {
    a: assetIndex,
    b: proposal.side === "long",
    p: entryPx,
    s: proposal.size,
    r: proposal.reduceOnly,
    t: { limit: { tif: proposal.tif } },
  };

  // Exits close the position: opposite side, always reduce-only. Their limit
  // px bounds how far past the trigger the market exit may fill — through the
  // trigger in the closing direction (down when selling a long, up when
  // buying back a short).
  const closeSide = proposal.side !== "long";
  const trigger = (tpsl: "tp" | "sl", triggerPx: string) => ({
    a: assetIndex,
    b: closeSide,
    p: formatPx(
      Number(triggerPx) * (closeSide ? 1 + TRIGGER_SLIPPAGE_PCT / 100 : 1 - TRIGGER_SLIPPAGE_PCT / 100),
      proposal.szDecimals,
    ),
    s: proposal.size,
    r: true,
    t: { trigger: { isMarket: true, triggerPx, tpsl } },
  });

  const orders: Record<string, unknown>[] = [entryOrder];
  if (proposal.takeProfitPx !== null) orders.push(trigger("tp", proposal.takeProfitPx));
  if (proposal.stopLossPx !== null) orders.push(trigger("sl", proposal.stopLossPx));

  return {
    orderAction: {
      type: "order",
      orders,
      grouping: orders.length > 1 ? "normalTpsl" : "na",
    },
    px: entryPx,
    slPx: proposal.stopLossPx,
    tpPx: proposal.takeProfitPx,
  };
}
