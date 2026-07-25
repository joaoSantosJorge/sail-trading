import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { executions } from "@/server/db/schema";
import { getProposal } from "@/server/trade/proposals";
import { takeQuote } from "@/server/trade/quotes";
import { buildSwap, UniswapError } from "@/server/uniswap/client";
import { isAllowedTarget } from "@/server/uniswap/routers";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  quoteId: z.string().uuid(),
  /** EIP-712 Permit2 signature, when the quote carried permitData. */
  signature: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "quoteId required" }, { status: 400 });
  }

  const stored = takeQuote(parsed.data.quoteId, ctx.userId);
  if (stored === null) {
    return NextResponse.json({ error: "unknown quote — request a new one" }, { status: 404 });
  }
  if (stored === "expired") {
    return NextResponse.json(
      { error: "quote expired (30s validity) — request a new one" },
      { status: 400 },
    );
  }

  // Re-check the proposal is still actionable at send time.
  const proposal = await getProposal(ctx.userId, stored.proposalId);
  if (!proposal || proposal.status === "expired" || proposal.status === "dismissed") {
    return NextResponse.json(
      { error: `proposal is ${proposal?.status ?? "missing"}` },
      { status: 409 },
    );
  }

  try {
    const swap = await buildSwap({
      quote: stored.quote,
      permitData: stored.permitData,
      signature: parsed.data.signature,
    });
    const tx = swap.swap;
    if (!tx?.to || !tx.data) {
      return NextResponse.json({ error: "Uniswap returned no transaction" }, { status: 502 });
    }

    // SAFETY RAIL: the transaction target must be a known Uniswap router or
    // Permit2 on this chain. Anything else is blocked outright.
    if (!isAllowedTarget(stored.chainId, tx.to)) {
      console.error(`[trade/swap] BLOCKED unknown target ${tx.to} on chain ${stored.chainId}`);
      return NextResponse.json(
        { error: `blocked: transaction target ${tx.to} is not an allowlisted Uniswap contract` },
        { status: 502 },
      );
    }

    const [execution] = await db
      .insert(executions)
      .values({
        userId: ctx.userId,
        proposalId: stored.proposalId,
        userWallet: stored.walletAddress,
        chainId: stored.chainId,
        quote: stored.quote,
        status: "pending",
      })
      .returning({ id: executions.id });

    return NextResponse.json({
      data: {
        executionId: execution.id,
        tx: { to: tx.to, data: tx.data, value: tx.value ?? "0x0", chainId: stored.chainId },
      },
    });
  } catch (err) {
    if (err instanceof UniswapError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[trade/swap] error", err);
    return NextResponse.json({ error: "swap build failed" }, { status: 502 });
  }
}
