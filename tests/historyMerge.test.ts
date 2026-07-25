import { describe, expect, it } from "vitest";
import { mergeHistory } from "@/server/portfolio/history";
import type { HistoryItem } from "@/server/portfolio/types";

function item(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    ts: 0,
    type: "transfer",
    direction: "in",
    assetSymbol: "ETH",
    amount: "1",
    counterparty: null,
    chainId: 1,
    network: "eth-mainnet",
    txHash: null,
    status: null,
    category: "external",
    txKey: "0xkey",
    tags: [],
    ...overrides,
  };
}

describe("mergeHistory", () => {
  it("sorts newest first across both sources", () => {
    const merged = mergeHistory(
      [item({ ts: 100 }), item({ ts: 300 })],
      [item({ ts: 200, type: "trade" })],
      10,
    );
    expect(merged.map((m) => m.ts)).toEqual([300, 200, 100]);
  });

  it("dedupes txHash collisions preferring the trade row", () => {
    const merged = mergeHistory(
      [item({ ts: 100, txHash: "0xsame" }), item({ ts: 90, txHash: "0xother" })],
      [item({ ts: 101, txHash: "0xsame", type: "trade", status: "confirmed" })],
      10,
    );
    expect(merged).toHaveLength(2);
    const same = merged.find((m) => m.txHash === "0xsame");
    expect(same?.type).toBe("trade");
    expect(same?.status).toBe("confirmed");
  });

  it("keeps transfers without a txHash despite trade hashes", () => {
    const merged = mergeHistory(
      [item({ ts: 100, txHash: null })],
      [item({ ts: 200, txHash: "0xa", type: "trade" })],
      10,
    );
    expect(merged).toHaveLength(2);
  });

  it("slices to the limit after merging", () => {
    const transfers = Array.from({ length: 10 }, (_, i) => item({ ts: i }));
    const merged = mergeHistory(transfers, [], 3);
    expect(merged).toHaveLength(3);
    expect(merged[0].ts).toBe(9);
  });
});
