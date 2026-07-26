import { describe, expect, it } from "vitest";
import {
  manualPerpInputSchema,
  manualSwapInputSchema,
  manualToProposalInput,
  perpProposalInputSchema,
  tradeProposalInputSchema,
} from "@/lib/ai/action-schemas";
import { clampPerpProposal } from "@/server/trade/perpProposals";
import { clampProposal } from "@/server/trade/proposals";

const WALLET = "0x69d1652ae43f819e7518f732b2ea6b1a8ad00336";

describe("manualToProposalInput", () => {
  const manualPerp = {
    walletAddress: WALLET,
    coin: "HYPE",
    side: "long" as const,
    size: "10",
    leverage: 2,
    orderType: "market" as const,
    sizeUsd: 500,
    stopLossPx: 45,
    takeProfitPx: 60,
    note: "manual breakout entry",
  };

  it("maps the note to rationale and fills defaults that satisfy the strict schema", () => {
    const parsed = manualPerpInputSchema.parse(manualPerp);
    const full = manualToProposalInput(parsed);
    expect(full.source).toBe("manual");
    expect(full.rationale).toBe("manual breakout entry");
    expect(perpProposalInputSchema.safeParse(full).success).toBe(true);
  });

  it("defaults the rationale when the note is empty", () => {
    const full = manualToProposalInput(manualPerpInputSchema.parse({ ...manualPerp, note: "  " }));
    expect(full.rationale).toBe("Manually created by the user on the Trade page.");
    expect(perpProposalInputSchema.safeParse(full).success).toBe(true);
  });

  it("manual perp input passes clampPerpProposal with SL/TP and source=manual", () => {
    const full = manualToProposalInput(manualPerpInputSchema.parse(manualPerp));
    const v = clampPerpProposal(
      full,
      [{ address: WALLET, accountValue: 10_000, totalMarginUsed: 1_000, positions: [] }],
      [{ coin: "HYPE", szDecimals: 2, maxLeverage: 10, markPx: 50 }],
      { maxUsd: 1000, maxPct: 25, maxLeverage: 5 },
    );
    expect(v.source).toBe("manual");
    expect(v.stopLossPx).toBe("45");
    expect(v.takeProfitPx).toBe("60");
  });

  it("manual swap input passes clampProposal with source=manual", () => {
    const parsed = manualSwapInputSchema.parse({
      chainId: 8453,
      walletAddress: WALLET,
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountIn: "0.05",
      sizeUsd: 200,
    });
    const full = manualToProposalInput(parsed);
    expect(tradeProposalInputSchema.safeParse(full).success).toBe(true);
    const v = clampProposal(
      full,
      [
        {
          address: WALLET,
          totalUsd: 10_000,
          positions: [
            {
              chainId: 8453,
              symbol: "ETH",
              tokenAddress: null,
              decimals: 18,
              balance: "1.5",
              priceUsd: 4000,
            },
          ],
        },
      ],
      { maxUsd: 1000, maxPct: 25 },
    );
    expect(v.source).toBe("manual");
    expect(v.tokenOut.symbol).toBe("USDC");
  });

  it("manual schemas reject the AI-only fields", () => {
    expect("rationale" in manualPerpInputSchema.shape).toBe(false);
    expect("source" in manualPerpInputSchema.shape).toBe(false);
    expect("reportId" in manualSwapInputSchema.shape).toBe(false);
  });
});
