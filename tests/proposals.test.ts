import { describe, expect, it } from "vitest";
import {
  clampProposal,
  ProposalError,
  type SnapshotLike,
} from "@/server/trade/proposals";

const WALLET = "0xabc0000000000000000000000000000000000abc";

const snapshot: SnapshotLike = {
  address: WALLET,
  totalUsd: 10_000,
  positions: [
    {
      chainId: 8453,
      symbol: "ETH",
      tokenAddress: null,
      decimals: 18,
      balance: "1.5",
      priceUsd: 2000,
    },
    {
      chainId: 8453,
      symbol: "USDC",
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
      balance: "500",
      priceUsd: 1,
    },
  ],
};

const CAPS = { maxUsd: 1000, maxPct: 25 };

const base = {
  chainId: 8453,
  walletAddress: WALLET,
  tokenIn: "ETH",
  tokenOut: "USDC",
  amountIn: "0.01",
  sizeUsd: 20,
  maxSlippageBps: 50,
  rationale: "Take profit into stables after the recent run-up.",
  risks: ["ETH may keep rallying after the exit"],
  confidence: "medium" as const,
  invalidation: "ETH reclaims its 90d high",
};

describe("clampProposal", () => {
  it("accepts a valid proposal and normalizes token details", () => {
    const v = clampProposal(base, [snapshot], CAPS);
    expect(v.tokenIn.symbol).toBe("ETH");
    expect(v.tokenIn.balance).toBe("1.5");
    expect(v.tokenOut.symbol).toBe("USDC");
    expect(v.tokenOut.address).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(v.chainName).toBe("Base");
  });

  it("rejects an unregistered wallet", () => {
    expect(() =>
      clampProposal({ ...base, walletAddress: "0x" + "9".repeat(40) }, [snapshot], CAPS),
    ).toThrow(/not registered/);
  });

  it("rejects tokenIn not held in the snapshot on that chain", () => {
    expect(() => clampProposal({ ...base, tokenIn: "WBTC" }, [snapshot], CAPS)).toThrow(
      /not held/,
    );
    // Held symbol but wrong chain
    expect(() => clampProposal({ ...base, chainId: 1 }, [snapshot], CAPS)).toThrow(/not held/);
  });

  it("rejects amounts above the snapshot balance", () => {
    expect(() => clampProposal({ ...base, amountIn: "2.0" }, [snapshot], CAPS)).toThrow(
      /exceeds the snapshot balance/,
    );
  });

  it("rejects unknown tokenOut and lists the known ones", () => {
    expect(() => clampProposal({ ...base, tokenOut: "SHIB" }, [snapshot], CAPS)).toThrow(
      /not a known token .*USDC/,
    );
  });

  it("rejects sizeUsd above the hard cap", () => {
    expect(() =>
      clampProposal({ ...base, sizeUsd: 1500, amountIn: "0.7" }, [snapshot], CAPS),
    ).toThrow(/exceeds the cap/);
  });

  it("rejects sizeUsd above the portfolio-percentage cap", () => {
    // 25% of 10k = 2500 > 1000 hard cap; shrink portfolio so pct binds: 25% of 3000 = 750
    const small = { ...snapshot, totalUsd: 3000 };
    expect(() =>
      clampProposal({ ...base, sizeUsd: 900, amountIn: "0.45" }, [small], CAPS),
    ).toThrow(/exceeds the cap of 750/);
  });

  it("rejects when amountIn's implied USD value blows the cap even if sizeUsd lies", () => {
    expect(() =>
      clampProposal({ ...base, amountIn: "1.0", sizeUsd: 100 }, [snapshot], CAPS),
    ).toThrow(/worth ~2000\.00 USD/);
  });

  it("rejects slippage above 100 bps via the schema", () => {
    expect(() =>
      clampProposal({ ...base, maxSlippageBps: 250 }, [snapshot], CAPS),
    ).toThrow(ProposalError);
  });

  it("rejects unsupported chains and same-token swaps", () => {
    expect(() => clampProposal({ ...base, chainId: 137 }, [snapshot], CAPS)).toThrow(
      /not supported/,
    );
    expect(() =>
      clampProposal({ ...base, tokenIn: "USDC", tokenOut: "USDC", amountIn: "10" }, [snapshot], CAPS),
    ).toThrow(/same token/);
  });
});
