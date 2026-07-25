import { describe, expect, it } from "vitest";
import { describeSuspicious, foldSymbol } from "@/lib/portfolio/symbols";

describe("foldSymbol", () => {
  it("folds the real-world Cyrillic USDC impersonator and flags it", () => {
    // Exact scam-token symbol: U+0055 U+0405 U+0044 U+0421
    const fake = "UЅDС";
    expect(foldSymbol(fake)).toEqual({ folded: "USDC", suspicious: true });
  });

  it("leaves genuine ASCII symbols untouched and unflagged", () => {
    for (const s of ["USDC", "WETH", "$GGS", "GOP", "SOLX VVV"]) {
      expect(foldSymbol(s)).toEqual({ folded: s, suspicious: false });
    }
  });

  it("allows the app's own swap-pair arrow", () => {
    expect(foldSymbol("ETH→USDC")).toEqual({ folded: "ETH→USDC", suspicious: false });
  });

  it("folds Greek and fullwidth look-alikes", () => {
    expect(foldSymbol("ΕΤΗ")).toEqual({ folded: "ETH", suspicious: true }); // ΕΤΗ
    expect(foldSymbol("ＵＳＤＣ")).toEqual({ folded: "USDC", suspicious: true }); // ＵＳＤＣ
  });

  it("flags unresolvable non-ASCII with best-effort folding", () => {
    const { folded, suspicious } = foldSymbol("US☠DC");
    expect(suspicious).toBe(true);
    expect(folded).toBe("US☠DC");
  });
});

describe("describeSuspicious", () => {
  it("names offending characters with code points, deduped", () => {
    const text = describeSuspicious("UЅDСС");
    expect(text).toContain('"Ѕ" (U+0405)');
    expect(text).toContain('"С" (U+0421)');
    expect(text.match(/U\+0421/g)).toHaveLength(1);
  });
});
