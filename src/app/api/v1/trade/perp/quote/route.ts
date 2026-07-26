import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { formatPx } from "@/lib/hyperliquid/format";
import { requireUserApi } from "@/server/auth/guards";
import { HYPERLIQUID_CHAIN_ID } from "@/server/hyperliquid/constants";
import { hyperliquidIsTestnet, metaAndAssetCtxs, HyperliquidError } from "@/server/hyperliquid/info";
import { buildPerpOrderAction } from "@/server/trade/perpOrder";
import { getProposal, setProposalStatus } from "@/server/trade/proposals";
import { MAX_PX_BAND_PCT, type ValidatedPerpProposal } from "@/server/trade/perpProposals";
import { QUOTE_TTL_MS, saveQuote } from "@/server/trade/quotes";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({ proposalId: z.number().int() });

/**
 * Mint a short-lived, single-use perp order quote: the EXACT wire action the
 * browser's agent key must sign. /execute only accepts a signed action that
 * byte-matches what was stored here — the client can never trade anything the
 * server didn't price.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "proposalId required" }, { status: 400 });
  }

  const row = await getProposal(ctx.userId, parsed.data.proposalId);
  if (!row) return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  if (row.kind !== "perp") {
    return NextResponse.json({ error: "not a perp proposal" }, { status: 400 });
  }
  if (row.status === "expired") {
    return NextResponse.json({ error: "proposal has expired" }, { status: 410 });
  }
  if (row.status !== "proposed" && row.status !== "approved") {
    return NextResponse.json({ error: `proposal is ${row.status}` }, { status: 409 });
  }
  const proposal = row.proposal as ValidatedPerpProposal;

  try {
    const [meta, ctxs] = await metaAndAssetCtxs();
    const assetIndex = meta.universe.findIndex((u) => u.name === proposal.coin);
    if (assetIndex < 0) {
      return NextResponse.json({ error: `market ${proposal.coin} not found` }, { status: 502 });
    }
    const markPx = Number(ctxs[assetIndex]?.markPx ?? 0);
    if (!Number.isFinite(markPx) || markPx <= 0) {
      return NextResponse.json({ error: "no live mark price" }, { status: 502 });
    }

    // Wire price: market orders become IOC-limit at mark ± slippage; limit
    // prices are re-checked against the LIVE mark (it may have moved since
    // the proposal was clamped).
    let px: string;
    if (proposal.orderType === "market") {
      const slip = proposal.maxSlippageBps / 10_000;
      px = formatPx(markPx * (proposal.side === "long" ? 1 + slip : 1 - slip), proposal.szDecimals);
    } else {
      px = proposal.limitPx!;
      const deviationPct = (Math.abs(Number(px) - markPx) / markPx) * 100;
      if (deviationPct > MAX_PX_BAND_PCT) {
        return NextResponse.json(
          {
            error: `limit price ${px} is now ${deviationPct.toFixed(1)}% from the live mark ${markPx} — the market moved; dismiss and re-propose`,
          },
          { status: 409 },
        );
      }
    }

    // EXACT wire actions (key order matters for the L1 action hash — the
    // client signs these objects verbatim). Entry plus optional reduce-only
    // TP/SL trigger exits, built by the unit-tested pure builder.
    const { orderAction, slPx, tpPx } = buildPerpOrderAction(proposal, assetIndex, px);
    // Honor the clamped leverage before opening new exposure (skipped for
    // reduceOnly — closing needs no leverage change).
    const updateLeverageAction = proposal.reduceOnly
      ? null
      : {
          type: "updateLeverage",
          asset: assetIndex,
          isCross: true,
          leverage: proposal.leverage,
        };

    const quoteId = saveQuote({
      proposalId: row.id,
      userId: ctx.userId,
      chainId: HYPERLIQUID_CHAIN_ID,
      walletAddress: proposal.walletAddress,
      quote: { orderAction, updateLeverageAction, coin: proposal.coin, markPx, px, slPx, tpPx },
      permitData: null,
    });

    if (row.status === "proposed") {
      await setProposalStatus(ctx.userId, row.id, "approved");
    }

    return NextResponse.json({
      data: {
        quoteId,
        validForMs: QUOTE_TTL_MS,
        coin: proposal.coin,
        side: proposal.side,
        size: proposal.size,
        px,
        markPx,
        notionalUsd: Number(proposal.size) * Number(px),
        leverage: proposal.leverage,
        tif: proposal.tif,
        reduceOnly: proposal.reduceOnly,
        slPx,
        tpPx,
        orderAction,
        updateLeverageAction,
        isTestnet: hyperliquidIsTestnet(),
      },
    });
  } catch (err) {
    if (err instanceof HyperliquidError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[trade/perp/quote] error", err);
    return NextResponse.json({ error: "quote failed" }, { status: 502 });
  }
}
