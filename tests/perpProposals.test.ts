import { describe, expect, it } from "vitest";
import { formatPx, formatSz } from "@/lib/hyperliquid/format";
import {
  accountsFromSnapshots,
  clampPerpProposal,
  type PerpAccountLike,
  type PerpCaps,
  type PerpMarketLike,
} from "@/server/trade/perpProposals";

const WALLET = "0x69d1652ae43f819e7518f732b2ea6b1a8ad00336";

const markets: PerpMarketLike[] = [
  { coin: "BTC", szDecimals: 5, maxLeverage: 40, markPx: 100_000 },
  { coin: "ETH", szDecimals: 4, maxLeverage: 25, markPx: 4_000 },
  { coin: "HYPE", szDecimals: 2, maxLeverage: 10, markPx: 50 },
];

const account: PerpAccountLike = {
  address: WALLET,
  accountValue: 10_000,
  totalMarginUsed: 1_000,
  positions: [{ coin: "ETH", side: "short", size: 2 }],
};

const caps: PerpCaps = { maxUsd: 1000, maxPct: 25, maxLeverage: 5 };

const base = {
  walletAddress: WALLET,
  coin: "HYPE",
  side: "long" as const,
  size: "10",
  leverage: 2,
  orderType: "market" as const,
  tif: "Gtc" as const,
  reduceOnly: false,
  sizeUsd: 500,
  maxSlippageBps: 50,
  rationale: "momentum continuation setup after breakout",
  risks: ["liquidation if price drops sharply"],
  confidence: "medium" as const,
  invalidation: "close below the breakout level",
};

describe("clampPerpProposal", () => {
  it("accepts a valid market order and normalizes it", () => {
    const v = clampPerpProposal(base, [account], markets, caps);
    expect(v.kind).toBe("perp");
    expect(v.venue).toBe("hyperliquid");
    expect(v.coin).toBe("HYPE");
    expect(v.size).toBe("10");
    expect(v.tif).toBe("Ioc"); // market orders are always IOC
    expect(v.limitPx).toBeNull();
    expect(v.notionalUsd).toBe(500);
    expect(v.markPxAtProposal).toBe(50);
  });

  it("rejects unregistered wallets", () => {
    expect(() => clampPerpProposal(base, [], markets, caps)).toThrow(/not a registered Hyperliquid wallet/);
  });

  it("rejects unknown coins", () => {
    expect(() =>
      clampPerpProposal({ ...base, coin: "DOGE2" }, [account], markets, caps),
    ).toThrow(/not a Hyperliquid perp market/);
  });

  it("clamps leverage to min(venue max, MAX_PERP_LEVERAGE)", () => {
    expect(() =>
      clampPerpProposal({ ...base, leverage: 6 }, [account], markets, caps),
    ).toThrow(/exceeds the cap of 5x/);
    // Venue max below env cap: HYPE allows 10x, env caps at 5x → 5x; but a
    // coin-specific cap lower than env must win too.
    const lowLev = [{ ...markets[2], maxLeverage: 3 }];
    expect(() =>
      clampPerpProposal({ ...base, leverage: 4 }, [account], lowLev, caps),
    ).toThrow(/exceeds the cap of 3x/);
  });

  it("rejects sizes that round to zero", () => {
    expect(() =>
      clampPerpProposal({ ...base, size: "0.001", sizeUsd: 0.05 }, [account], markets, caps),
    ).toThrow(/rounds to zero/);
  });

  it("rounds size to the venue's szDecimals", () => {
    const v = clampPerpProposal({ ...base, size: "10.12999" }, [account], markets, caps);
    expect(v.size).toBe("10.13"); // nearest; caps are applied to the rounded size
  });

  it("requires limitPx for limit orders and keeps it inside the ±20% band", () => {
    expect(() =>
      clampPerpProposal({ ...base, orderType: "limit" }, [account], markets, caps),
    ).toThrow(/limitPx is required/);
    expect(() =>
      clampPerpProposal(
        { ...base, orderType: "limit", limitPx: 30 },
        [account],
        markets,
        caps,
      ),
    ).toThrow(/away from the mark price/);
    const v = clampPerpProposal(
      { ...base, orderType: "limit", limitPx: 48.1234, tif: "Gtc" },
      [account],
      markets,
      caps,
    );
    expect(v.limitPx).toBe("48.123"); // 5 significant figures
    expect(v.tif).toBe("Gtc");
  });

  it("enforces the notional caps (hard USD and % of account)", () => {
    expect(() =>
      clampPerpProposal({ ...base, size: "25", sizeUsd: 1250 }, [account], markets, caps),
    ).toThrow(/exceeds the cap of 1000.00 USD/);
    // 25% of a small account beats the hard cap.
    const small = { ...account, accountValue: 800, totalMarginUsed: 0 };
    expect(() =>
      clampPerpProposal({ ...base, size: "10", sizeUsd: 500 }, [small], markets, caps),
    ).toThrow(/exceeds the cap of 200.00 USD/);
  });

  it("cross-checks the claimed sizeUsd against size × price", () => {
    expect(() =>
      clampPerpProposal({ ...base, sizeUsd: 10 }, [account], markets, caps),
    ).toThrow(/does not match the computed notional/);
  });

  it("checks free margin for new exposure", () => {
    const tight = { ...account, accountValue: 10_000, totalMarginUsed: 9_900 };
    expect(() =>
      clampPerpProposal({ ...base, leverage: 2, size: "10", sizeUsd: 500 }, [tight], markets, caps),
    ).toThrow(/exceeds the free account margin/);
  });

  it("reduceOnly requires an opposite open position and caps at its size", () => {
    expect(() =>
      clampPerpProposal(
        { ...base, coin: "HYPE", reduceOnly: true },
        [account],
        markets,
        caps,
      ),
    ).toThrow(/needs an open short position/);
    // ETH short 2 exists: closing (long) up to 2 is fine, 3 is not.
    const closeOk = clampPerpProposal(
      { ...base, coin: "ETH", side: "long", size: "0.1", sizeUsd: 400, reduceOnly: true },
      [account],
      markets,
      caps,
    );
    expect(closeOk.reduceOnly).toBe(true);
    expect(() =>
      clampPerpProposal(
        { ...base, coin: "ETH", side: "long", size: "3", sizeUsd: 900, leverage: 5, reduceOnly: true },
        [account],
        markets,
        caps,
      ),
    ).toThrow(/exceeds the open short position/);
  });

  it("accepts SL/TP on a long and rounds them to wire prices", () => {
    const v = clampPerpProposal(
      { ...base, stopLossPx: 45.12345, takeProfitPx: 60.6789 },
      [account],
      markets,
      caps,
    );
    expect(v.stopLossPx).toBe("45.123"); // 5 significant figures
    expect(v.takeProfitPx).toBe("60.679");
  });

  it("accepts SL/TP on a short (mirrored sides)", () => {
    const v = clampPerpProposal(
      { ...base, side: "short", stopLossPx: 55, takeProfitPx: 40 },
      [account],
      markets,
      caps,
    );
    expect(v.stopLossPx).toBe("55");
    expect(v.takeProfitPx).toBe("40");
  });

  it("validates SL/TP against the limit price for limit orders", () => {
    expect(() =>
      clampPerpProposal(
        { ...base, orderType: "limit", limitPx: 48, stopLossPx: 49 },
        [account],
        markets,
        caps,
      ),
    ).toThrow(/must be below the limit price 48/);
    const v = clampPerpProposal(
      { ...base, orderType: "limit", limitPx: 48, stopLossPx: 44, takeProfitPx: 56 },
      [account],
      markets,
      caps,
    );
    expect(v.stopLossPx).toBe("44");
    expect(v.takeProfitPx).toBe("56");
  });

  it("rejects wrong-side triggers", () => {
    expect(() =>
      clampPerpProposal({ ...base, stopLossPx: 55 }, [account], markets, caps),
    ).toThrow(/stopLossPx 55 must be below the mark price 50 for a long/);
    expect(() =>
      clampPerpProposal({ ...base, takeProfitPx: 45 }, [account], markets, caps),
    ).toThrow(/takeProfitPx 45 must be above the mark price 50 for a long/);
    expect(() =>
      clampPerpProposal({ ...base, side: "short", stopLossPx: 45 }, [account], markets, caps),
    ).toThrow(/stopLossPx 45 must be above the mark price 50 for a short/);
    expect(() =>
      clampPerpProposal({ ...base, side: "short", takeProfitPx: 55 }, [account], markets, caps),
    ).toThrow(/takeProfitPx 55 must be below the mark price 50 for a short/);
  });

  it("rejects a trigger that ROUNDS onto the entry price", () => {
    // 49.99999 → 5 sig figs → "50" — collides with the mark after rounding.
    expect(() =>
      clampPerpProposal({ ...base, stopLossPx: 49.99999 }, [account], markets, caps),
    ).toThrow(/must be below the mark price 50/);
  });

  it("rejects triggers outside the ±80% band", () => {
    expect(() =>
      clampPerpProposal({ ...base, stopLossPx: 5 }, [account], markets, caps),
    ).toThrow(/90.0% away from the entry price 50 \(max 80%\)/);
    expect(() =>
      clampPerpProposal({ ...base, side: "short", stopLossPx: 95 }, [account], markets, caps),
    ).toThrow(/90.0% away from the entry price 50/);
  });

  it("rejects SL/TP combined with reduceOnly", () => {
    expect(() =>
      clampPerpProposal(
        { ...base, coin: "ETH", side: "long", size: "0.1", sizeUsd: 400, reduceOnly: true, stopLossPx: 3500 },
        [account],
        markets,
        caps,
      ),
    ).toThrow(/cannot be combined with reduceOnly/);
  });

  it("defaults source to ai and passes manual through", () => {
    expect(clampPerpProposal(base, [account], markets, caps).source).toBe("ai");
    expect(
      clampPerpProposal({ ...base, source: "manual" }, [account], markets, caps).source,
    ).toBe("manual");
  });

  it("leaves SL/TP null when not provided", () => {
    const v = clampPerpProposal(base, [account], markets, caps);
    expect(v.stopLossPx).toBeNull();
    expect(v.takeProfitPx).toBeNull();
  });

  it("skips the margin check for reduceOnly (closing frees margin)", () => {
    const tight = { ...account, accountValue: 1_000, totalMarginUsed: 995 };
    const v = clampPerpProposal(
      { ...base, coin: "ETH", side: "long", size: "0.05", sizeUsd: 200, reduceOnly: true },
      [tight],
      markets,
      caps,
    );
    expect(v.reduceOnly).toBe(true);
  });
});

describe("accountsFromSnapshots", () => {
  it("derives account facts from the Task 2 snapshot shape", () => {
    const accounts = accountsFromSnapshots([
      {
        address: WALLET,
        chain: "hyperliquid",
        positions: [
          { network: "hyperliquid", symbol: "USDC", valueUsd: 5000 },
          { network: "hyperliquid", symbol: "HYPE", valueUsd: 100 },
        ],
        perps: [
          { coin: "ETH", side: "short", size: 2, marginUsed: 300 },
          { coin: "BTC", side: "long", size: 0.01, marginUsed: 200 },
        ],
      },
      { address: "0xother", chain: "evm", positions: [], perps: [] },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({
      address: WALLET,
      accountValue: 5000,
      totalMarginUsed: 500,
      positions: [
        { coin: "ETH", side: "short", size: 2 },
        { coin: "BTC", side: "long", size: 0.01 },
      ],
    });
  });
});

describe("wire formatting", () => {
  it("formats sizes to szDecimals without trailing zeros", () => {
    expect(formatSz(10.129, 2)).toBe("10.13");
    expect(formatSz(10, 2)).toBe("10");
    expect(formatSz(0.04679, 5)).toBe("0.04679");
  });

  it("formats prices to 5 significant figures and the decimal cap", () => {
    expect(formatPx(118_452.7, 5)).toBe("118450"); // 5 sig figs, integer ok
    expect(formatPx(57.46812, 2)).toBe("57.468"); // 5 sig figs within 4 decimals
    expect(formatPx(0.0123456, 0)).toBe("0.012346"); // 6 decimals cap
    expect(formatPx(4000, 4)).toBe("4000");
  });
});
