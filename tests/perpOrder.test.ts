import { describe, expect, it } from "vitest";
import { buildPerpOrderAction } from "@/server/trade/perpOrder";
import type { ValidatedPerpProposal } from "@/server/trade/perpProposals";

const proposal: ValidatedPerpProposal = {
  kind: "perp",
  venue: "hyperliquid",
  walletAddress: "0x69d1652ae43f819e7518f732b2ea6b1a8ad00336",
  coin: "HYPE",
  side: "long",
  size: "10",
  szDecimals: 2,
  leverage: 2,
  orderType: "market",
  limitPx: null,
  tif: "Ioc",
  reduceOnly: false,
  stopLossPx: null,
  takeProfitPx: null,
  notionalUsd: 500,
  markPxAtProposal: 50,
  maxSlippageBps: 50,
  rationale: "test",
  risks: ["test"],
  confidence: "medium",
  invalidation: "test",
  reportId: null,
  source: "manual",
};

describe("buildPerpOrderAction", () => {
  it("mints a single ungrouped order without triggers (byte-stable shape)", () => {
    const q = buildPerpOrderAction(proposal, 42, "50.25");
    expect(q.slPx).toBeNull();
    expect(q.tpPx).toBeNull();
    // JSON.stringify locks the key order — the signed msgpack hash depends on it.
    expect(JSON.stringify(q.orderAction)).toBe(
      '{"type":"order","orders":[{"a":42,"b":true,"p":"50.25","s":"10","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}',
    );
  });

  it("appends reduce-only TP/SL trigger exits for a long, grouped normalTpsl", () => {
    const q = buildPerpOrderAction(
      { ...proposal, stopLossPx: "45", takeProfitPx: "60" },
      42,
      "50.25",
    );
    expect(q.slPx).toBe("45");
    expect(q.tpPx).toBe("60");
    expect(q.orderAction.grouping).toBe("normalTpsl");
    expect(q.orderAction.orders).toHaveLength(3);
    // Exits close a long: sell side, reduce-only, fill limit 10% BELOW trigger.
    expect(JSON.stringify(q.orderAction.orders[1])).toBe(
      '{"a":42,"b":false,"p":"54","s":"10","r":true,"t":{"trigger":{"isMarket":true,"triggerPx":"60","tpsl":"tp"}}}',
    );
    expect(JSON.stringify(q.orderAction.orders[2])).toBe(
      '{"a":42,"b":false,"p":"40.5","s":"10","r":true,"t":{"trigger":{"isMarket":true,"triggerPx":"45","tpsl":"sl"}}}',
    );
  });

  it("mirrors trigger sides and slippage direction for a short", () => {
    const q = buildPerpOrderAction(
      { ...proposal, side: "short", stopLossPx: "55", takeProfitPx: null },
      7,
      "49.75",
    );
    expect(q.orderAction.grouping).toBe("normalTpsl");
    expect(q.orderAction.orders).toHaveLength(2);
    // Closing a short = buy back: fill limit 10% ABOVE the trigger.
    expect(JSON.stringify(q.orderAction.orders[1])).toBe(
      '{"a":7,"b":true,"p":"60.5","s":"10","r":true,"t":{"trigger":{"isMarket":true,"triggerPx":"55","tpsl":"sl"}}}',
    );
  });

  it("keeps limit-order entries verbatim alongside triggers", () => {
    const q = buildPerpOrderAction(
      { ...proposal, orderType: "limit", limitPx: "48", tif: "Gtc", takeProfitPx: "60" },
      42,
      "48",
    );
    expect(JSON.stringify(q.orderAction.orders[0])).toBe(
      '{"a":42,"b":true,"p":"48","s":"10","r":false,"t":{"limit":{"tif":"Gtc"}}}',
    );
  });
});
