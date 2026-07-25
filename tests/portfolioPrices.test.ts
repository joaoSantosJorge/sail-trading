import { beforeEach, describe, expect, it } from "vitest";
import { clearPriceMemo, fillMissingPrices } from "@/server/portfolio/prices";
import type { Position } from "@/server/portfolio/types";

const NOW = Date.parse("2026-07-24T12:00:00Z");

function position(overrides: Partial<Position>): Position {
  return {
    chainId: 1,
    network: "eth-mainnet",
    tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    symbol: "OBS",
    name: "Obscure",
    decimals: 18,
    balance: "10",
    priceUsd: null,
    valueUsd: null,
    ...overrides,
  };
}

describe("fillMissingPrices", () => {
  beforeEach(clearPriceMemo);

  it("prices unpriced ERC-20s via the contract lookup and tags the source", async () => {
    const calls: [string, string[]][] = [];
    const out = await fillMissingPrices(
      [position({})],
      async (platform, addresses) => {
        calls.push([platform, addresses]);
        return { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { usd: 2.5 } };
      },
      () => NOW,
    );
    expect(calls).toEqual([["ethereum", ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]]]);
    expect(out[0]).toMatchObject({ priceUsd: 2.5, valueUsd: 25, priceSource: "coingecko" });
  });

  it("skips already-priced, native, and unsupported-chain positions", async () => {
    const calls: string[] = [];
    const out = await fillMissingPrices(
      [
        position({ priceUsd: 1, valueUsd: 10 }),
        position({ tokenAddress: null, symbol: "ETH" }),
        position({ chainId: 999, network: "unknown" }),
      ],
      async (platform) => {
        calls.push(platform);
        return {};
      },
      () => NOW,
    );
    expect(calls).toEqual([]);
    expect(out.every((p) => p.priceSource === undefined)).toBe(true);
  });

  it("groups by chain platform and leaves unknown tokens unpriced", async () => {
    const calls: [string, string[]][] = [];
    const out = await fillMissingPrices(
      [
        position({ tokenAddress: "0x0000000000000000000000000000000000000001" }),
        position({
          chainId: 8453,
          network: "base-mainnet",
          tokenAddress: "0x0000000000000000000000000000000000000002",
        }),
      ],
      async (platform, addresses) => {
        calls.push([platform, addresses]);
        const prices: Record<string, { usd?: number }> = {};
        if (platform === "base") prices["0x0000000000000000000000000000000000000002"] = { usd: 4 };
        return prices;
      },
      () => NOW,
    );
    expect(calls.map(([p]) => p).sort()).toEqual(["base", "ethereum"]);
    const eth = out.find((p) => p.chainId === 1)!;
    const base = out.find((p) => p.chainId === 8453)!;
    expect(eth.priceUsd).toBeNull();
    expect(base).toMatchObject({ priceUsd: 4, valueUsd: 40, priceSource: "coingecko" });
  });

  it("degrades to unpriced when the fetcher throws, then retries next call", async () => {
    let attempts = 0;
    const failing = async () => {
      attempts += 1;
      throw new Error("rate limited");
    };
    const first = await fillMissingPrices([position({})], failing, () => NOW);
    expect(first[0].priceUsd).toBeNull();
    // Failure memoized nothing — the next sync asks again.
    await fillMissingPrices([position({})], failing, () => NOW);
    expect(attempts).toBe(2);
  });

  it("serves the memo within the TTL instead of refetching", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { usd: 3 } };
    };
    await fillMissingPrices([position({})], fetcher, () => NOW);
    const again = await fillMissingPrices([position({})], fetcher, () => NOW + 60_000);
    expect(calls).toBe(1);
    expect(again[0]).toMatchObject({ priceUsd: 3, priceSource: "coingecko" });
  });

  it("re-sorts so newly priced positions rank by value", async () => {
    const out = await fillMissingPrices(
      [
        position({ symbol: "BIG", priceUsd: 5, valueUsd: 50, tokenAddress: "0x03" }),
        position({ symbol: "HUGE", balance: "100", tokenAddress: "0x0000000000000000000000000000000000000004" }),
      ],
      async () => ({ "0x0000000000000000000000000000000000000004": { usd: 2 } }),
      () => NOW,
    );
    expect(out.map((p) => p.symbol)).toEqual(["HUGE", "BIG"]);
  });
});
