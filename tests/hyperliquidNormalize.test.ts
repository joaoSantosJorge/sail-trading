import { describe, expect, it } from "vitest";
import type { HlClearinghouseState, HlLedgerUpdate, HlSpotClearinghouseState } from "@/server/hyperliquid/info";
import {
  normalizeLedgerUpdates,
  normalizePerpState,
  normalizeSpotBalances,
} from "@/server/hyperliquid/normalize";

// Fixtures mirror real mainnet response shapes (numbers as strings, signed szi).
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

const perpState: HlClearinghouseState = {
  assetPositions: [
    {
      type: "oneWay",
      position: {
        coin: "ETH",
        szi: "2.5",
        entryPx: "3000.0",
        positionValue: "7812.5",
        unrealizedPnl: "312.5",
        liquidationPx: "2410.55",
        marginUsed: "781.25",
        maxLeverage: 25,
        leverage: { type: "cross", value: 10 },
        returnOnEquity: "0.4",
      },
    },
    {
      type: "oneWay",
      position: {
        coin: "HYPE",
        szi: "-100.0",
        entryPx: "55.5",
        positionValue: "5772.0",
        unrealizedPnl: "-222.0",
        liquidationPx: "61.87",
        marginUsed: "1154.4",
        maxLeverage: 10,
        leverage: { type: "isolated", value: 5 },
        returnOnEquity: "-0.19",
      },
    },
    {
      // Flat position rows (szi 0) must be dropped.
      type: "oneWay",
      position: {
        coin: "BTC",
        szi: "0.0",
        entryPx: null,
        positionValue: "0.0",
        unrealizedPnl: "0.0",
        liquidationPx: null,
        marginUsed: "0.0",
        maxLeverage: 40,
        leverage: { type: "cross", value: 1 },
        returnOnEquity: "0.0",
      },
    },
  ],
  marginSummary: {
    accountValue: "10250.75",
    totalNtlPos: "13584.5",
    totalRawUsd: "10250.75",
    totalMarginUsed: "1935.65",
  },
  withdrawable: "8315.1",
  time: 1_753_000_000_000,
};

describe("normalizePerpState", () => {
  it("maps open positions with sign-derived sides and drops flat ones", () => {
    const { perps } = normalizePerpState(perpState);
    expect(perps).toHaveLength(2);
    expect(perps[0]).toEqual({
      venue: "hyperliquid",
      coin: "ETH",
      side: "long",
      size: 2.5,
      notionalUsd: 7812.5,
      entryPx: 3000,
      liquidationPx: 2410.55,
      leverage: 10,
      marginMode: "cross",
      marginUsed: 781.25,
      unrealizedPnl: 312.5,
    });
    expect(perps[1].side).toBe("short");
    expect(perps[1].size).toBe(100);
    expect(perps[1].marginMode).toBe("isolated");
  });

  it("emits the account value as one synthetic USDC position", () => {
    const { marginPosition, withdrawable } = normalizePerpState(perpState);
    expect(marginPosition).toMatchObject({
      network: "hyperliquid",
      symbol: "USDC",
      balance: "10250.75",
      priceUsd: 1,
      valueUsd: 10250.75,
      tokenAddress: null,
    });
    expect(withdrawable).toBe(8315.1);
  });

  it("returns no margin position for an empty account", () => {
    const empty: HlClearinghouseState = {
      ...perpState,
      assetPositions: [],
      marginSummary: { ...perpState.marginSummary, accountValue: "0.0" },
      withdrawable: "0.0",
    };
    const { marginPosition, perps } = normalizePerpState(empty);
    expect(marginPosition).toBeNull();
    expect(perps).toEqual([]);
  });
});

describe("normalizeSpotBalances", () => {
  const spot: HlSpotClearinghouseState = {
    balances: [
      { coin: "USDC", token: 0, total: "1500.5", hold: "0.0", entryNtl: "1500.5" },
      { coin: "HYPE", token: 150, total: "20.0", hold: "0.0", entryNtl: "900.0" },
      { coin: "PURR", token: 1, total: "5000.0", hold: "0.0", entryNtl: "100.0" },
      { coin: "SOL", token: 5, total: "0", hold: "0.0", entryNtl: "0.0" },
    ],
  };
  const mids = { HYPE: "57.5", BTC: "118000.0" };

  it("prices USDC at 1, other coins from same-named perp mids, else unpriced", () => {
    const positions = normalizeSpotBalances(spot, mids);
    expect(positions).toHaveLength(3); // zero balance dropped
    const bySymbol = Object.fromEntries(positions.map((p) => [p.symbol, p]));
    expect(bySymbol.USDC.valueUsd).toBe(1500.5);
    expect(bySymbol.HYPE.priceUsd).toBe(57.5);
    expect(bySymbol.HYPE.valueUsd).toBe(1150);
    expect(bySymbol.HYPE.priceSource).toBe("hyperliquid");
    expect(bySymbol.PURR.priceUsd).toBeNull();
    expect(bySymbol.PURR.valueUsd).toBeNull();
    expect(bySymbol.PURR.priceSource).toBeUndefined();
  });
});

describe("normalizeLedgerUpdates", () => {
  const updates: HlLedgerUpdate[] = [
    { time: 1000, hash: "0xaaa", delta: { type: "deposit", usdc: "500.0" } },
    { time: 2000, hash: "0xbbb", delta: { type: "withdraw", usdc: "120.0" } },
    {
      time: 3000,
      hash: "0x0",
      delta: { type: "accountClassTransfer", usdc: "50.0" },
    },
    {
      time: 4000,
      hash: "0xccc",
      delta: { type: "spotTransfer", token: "HYPE", amount: "2.0", destination: "0xdead...", user: ADDRESS },
    },
    {
      time: 5000,
      hash: "0xddd",
      delta: { type: "spotTransfer", token: "HYPE", amount: "3.0", destination: ADDRESS, user: "0xbeef" },
    },
  ];

  it("maps directions, composes unique ids, and carries amounts", () => {
    const transfers = normalizeLedgerUpdates(updates, ADDRESS);
    expect(transfers.map((t) => t.direction)).toEqual(["in", "out", "self", "out", "in"]);
    expect(transfers[0]).toMatchObject({
      network: "hyperliquid",
      chainId: null,
      uniqueId: "0xaaa:1000:deposit",
      txHash: "0xaaa",
      ts: 1000,
      category: "deposit",
      assetSymbol: "USDC",
      amount: "500.0",
    });
    // Zero-hash internal updates still get distinct dedupe keys.
    expect(transfers[2].uniqueId).toBe("0x0:3000:accountClassTransfer");
    expect(transfers[3].assetSymbol).toBe("HYPE");
    expect(transfers[4].counterparty).toBe("0xbeef");
  });
});
