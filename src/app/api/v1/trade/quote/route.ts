import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { getProposal, setProposalStatus } from "@/server/trade/proposals";
import { QUOTE_TTL_MS, saveQuote } from "@/server/trade/quotes";
import {
  checkApproval,
  fetchQuote,
  NATIVE_TOKEN,
  UniswapError,
  uniswapConfigured,
} from "@/server/uniswap/client";
import type { ValidatedProposal } from "@/server/trade/proposals";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({ proposalId: z.number().int() });

/** Convert a decimal token amount to raw integer units. */
function toRawUnits(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")).toString();
}

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  if (!uniswapConfigured()) {
    return NextResponse.json(
      { error: "UNISWAP_API_KEY is not set — add it to .env.local to enable trading" },
      { status: 503 },
    );
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "proposalId required" }, { status: 400 });
  }

  const row = await getProposal(ctx.userId, parsed.data.proposalId);
  if (!row) return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  if (row.status === "expired") {
    return NextResponse.json({ error: "proposal has expired" }, { status: 410 });
  }
  if (row.status !== "proposed" && row.status !== "approved") {
    return NextResponse.json({ error: `proposal is ${row.status}` }, { status: 409 });
  }
  const proposal = row.proposal as ValidatedProposal;

  try {
    const amountRaw = toRawUnits(proposal.amountIn, proposal.tokenIn.decimals);
    const tokenIn = proposal.tokenIn.address ?? NATIVE_TOKEN;
    const tokenOut = proposal.tokenOut.address ?? NATIVE_TOKEN;

    const quoteResponse = await fetchQuote({
      chainId: proposal.chainId,
      swapper: proposal.walletAddress,
      tokenIn,
      tokenOut,
      amountIn: amountRaw,
      slippageBps: proposal.maxSlippageBps,
    });

    // ERC-20 inputs may need a one-time Permit2 allowance transaction.
    let approvalTx: { to: string; data: string; value: string } | null = null;
    if (proposal.tokenIn.address) {
      const approval = await checkApproval({
        chainId: proposal.chainId,
        walletAddress: proposal.walletAddress,
        token: proposal.tokenIn.address,
        amount: amountRaw,
      });
      if (approval.approval?.to && approval.approval.data) {
        // SAFETY RAIL: the approval must be approve() ON the sold token WITH
        // Permit2 as the spender — anything else is blocked.
        const PERMIT2 = "000000000022d473030f116ddee9f6b43ac78ba3";
        const data = approval.approval.data.toLowerCase();
        const spenderOk =
          data.startsWith("0x095ea7b3") && data.slice(10, 74).endsWith(PERMIT2);
        const targetOk =
          approval.approval.to.toLowerCase() === proposal.tokenIn.address.toLowerCase();
        if (!spenderOk || !targetOk) {
          console.error(
            `[trade/quote] BLOCKED unexpected approval tx to=${approval.approval.to}`,
          );
          return NextResponse.json(
            { error: "blocked: unexpected approval transaction shape" },
            { status: 502 },
          );
        }
        approvalTx = {
          to: approval.approval.to,
          data: approval.approval.data,
          value: approval.approval.value ?? "0x0",
        };
      }
    }

    const quote = quoteResponse.quote ?? {};
    const output = (quote as { output?: { amount?: string } }).output;
    const priceImpact = (quote as { priceImpact?: number }).priceImpact ?? null;

    const quoteId = saveQuote({
      proposalId: row.id,
      userId: ctx.userId,
      chainId: proposal.chainId,
      walletAddress: proposal.walletAddress,
      quote: quote as Record<string, unknown>,
      permitData: (quoteResponse.permitData as Record<string, unknown> | null) ?? null,
    });

    // First user action on the proposal — record intent.
    if (row.status === "proposed") {
      await setProposalStatus(ctx.userId, row.id, "approved");
    }

    return NextResponse.json({
      data: {
        quoteId,
        validForMs: QUOTE_TTL_MS,
        amountIn: proposal.amountIn,
        tokenInSymbol: proposal.tokenIn.symbol,
        tokenOutSymbol: proposal.tokenOut.symbol,
        tokenOutDecimals: proposal.tokenOut.decimals,
        amountOutRaw: output?.amount ?? null,
        priceImpactPct: priceImpact,
        routing: quoteResponse.routing ?? null,
        approvalTx,
        permitData: quoteResponse.permitData ?? null,
      },
    });
  } catch (err) {
    if (err instanceof UniswapError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[trade/quote] error", err);
    return NextResponse.json({ error: "quote failed" }, { status: 502 });
  }
}
