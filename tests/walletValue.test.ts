import { describe, expect, it } from "vitest";
import { txUrl, chainName } from "@/lib/explorers";
import { formatBtc, formatUsd, usdToBtc } from "@/lib/portfolio/value";

describe("usdToBtc", () => {
  it("cross-divides USD value by the BTC spot", () => {
    expect(usdToBtc(50_000, 100_000)).toBe(0.5);
  });

  it("returns null on missing or degenerate inputs", () => {
    expect(usdToBtc(null, 100_000)).toBeNull();
    expect(usdToBtc(50_000, null)).toBeNull();
    expect(usdToBtc(50_000, 0)).toBeNull();
    expect(usdToBtc(50_000, -1)).toBeNull();
    expect(usdToBtc(50_000, Number.NaN)).toBeNull();
  });
});

describe("formatBtc", () => {
  it("uses 4 dp at ≥1 BTC and 8 dp below", () => {
    expect(formatBtc(1.234567891)).toBe("₿1.2346");
    expect(formatBtc(0.123456789)).toBe("₿0.12345679");
  });

  it("renders — for null", () => {
    expect(formatBtc(null)).toBe("—");
  });
});

describe("formatUsd", () => {
  it("formats as USD currency and dashes null", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("—");
  });
});

describe("explorers", () => {
  it("links known chains and nulls unknown ones", () => {
    expect(txUrl(8453, "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(txUrl(10, "0xabc")).toBe("https://optimistic.etherscan.io/tx/0xabc");
    expect(txUrl(999, "0xabc")).toBeNull();
    expect(txUrl(1, null)).toBeNull();
    expect(txUrl(null, "0xabc")).toBeNull();
  });

  it("names chains with a numeric fallback", () => {
    expect(chainName(137)).toBe("Polygon");
    expect(chainName(999)).toBe("999");
    expect(chainName(null)).toBe("—");
  });
});
