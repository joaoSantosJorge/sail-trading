import { describe, expect, it } from "vitest";
import {
  isSpamTransfer,
  normalizeTransfer,
  type RawAssetTransfer,
} from "@/server/portfolio/alchemyTransfers";

const OWNER = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function raw(overrides: Partial<RawAssetTransfer> = {}): RawAssetTransfer {
  return {
    uniqueId: "0xabc:log:1",
    hash: "0xabc",
    blockNum: "0x10",
    from: OWNER,
    to: OTHER,
    value: 1.5,
    asset: "ETH",
    category: "external",
    metadata: { blockTimestamp: "2026-07-01T12:00:00.000Z" },
    ...overrides,
  };
}

describe("normalizeTransfer", () => {
  it("derives direction out / in / self case-insensitively", () => {
    expect(normalizeTransfer(raw(), OWNER, "eth-mainnet", 1).direction).toBe("out");
    expect(
      normalizeTransfer(raw({ from: OTHER, to: OWNER.toLowerCase() }), OWNER, "eth-mainnet", 1)
        .direction,
    ).toBe("in");
    expect(
      normalizeTransfer(raw({ from: OWNER, to: OWNER.toLowerCase() }), OWNER, "eth-mainnet", 1)
        .direction,
    ).toBe("self");
  });

  it("parses the block timestamp to ms epoch and keeps provider ids", () => {
    const t = normalizeTransfer(raw(), OWNER, "base-mainnet", 8453);
    expect(t.ts).toBe(Date.parse("2026-07-01T12:00:00.000Z"));
    expect(t.uniqueId).toBe("0xabc:log:1");
    expect(t.txHash).toBe("0xabc");
    expect(t.chainId).toBe(8453);
    expect(t.network).toBe("base-mainnet");
  });

  it("sets counterparty to the other side of the transfer", () => {
    expect(normalizeTransfer(raw(), OWNER, "eth-mainnet", 1).counterparty).toBe(OTHER);
    const incoming = normalizeTransfer(raw({ from: OTHER, to: OWNER }), OWNER, "eth-mainnet", 1);
    expect(incoming.counterparty).toBe(OTHER);
  });

  it("stringifies amounts and tolerates missing values", () => {
    expect(normalizeTransfer(raw({ value: 0.25 }), OWNER, "eth-mainnet", 1).amount).toBe("0.25");
    expect(normalizeTransfer(raw({ value: null }), OWNER, "eth-mainnet", 1).amount).toBeNull();
    expect(
      normalizeTransfer(raw({ metadata: undefined }), OWNER, "eth-mainnet", 1).ts,
    ).toBe(0);
  });
});

describe("isSpamTransfer", () => {
  it("never flags native/external transfers", () => {
    expect(isSpamTransfer({ category: "external", amount: null, assetSymbol: null })).toBe(false);
  });

  it("flags erc20 transfers with zero/absent value or junk symbols", () => {
    expect(isSpamTransfer({ category: "erc20", amount: null, assetSymbol: "USDC" })).toBe(true);
    expect(isSpamTransfer({ category: "erc20", amount: "0", assetSymbol: "USDC" })).toBe(true);
    expect(isSpamTransfer({ category: "erc20", amount: "5", assetSymbol: null })).toBe(true);
    expect(
      isSpamTransfer({ category: "erc20", amount: "5", assetSymbol: "VISIT-SITE-CLAIM.XYZ" }),
    ).toBe(true);
  });

  it("keeps plausible erc20 transfers", () => {
    expect(isSpamTransfer({ category: "erc20", amount: "100", assetSymbol: "USDC" })).toBe(false);
  });
});
