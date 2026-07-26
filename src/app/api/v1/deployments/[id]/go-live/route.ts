import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { AgentError, requireApprovedAgent } from "@/server/deployments/agents";
import { DeploymentError, goLiveDeployment } from "@/server/deployments/service";
import { clearinghouseState, HyperliquidError } from "@/server/hyperliquid/info";
import { signerConfigured } from "@/server/signer/privy";

export const runtime = "nodejs";

const BodySchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

type Params = { params: Promise<{ id: string }> };

/**
 * Flip a paused paper deployment to live. Preconditions enforced here, in
 * order: signer configured → enclave agent venue-approved for THIS wallet →
 * live account value present. The service re-checks the deployment-side
 * invariants (paused, paper, asset tradeable).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "walletAddress required" }, { status: 400 });
  }
  const walletAddress = parsed.data.walletAddress.toLowerCase();

  if (!signerConfigured()) {
    return NextResponse.json(
      { error: "live trading is not enabled on this server (signer not configured)" },
      { status: 503 },
    );
  }

  try {
    const agent = await requireApprovedAgent(ctx.userId);
    if (agent.masterWallet?.toLowerCase() !== walletAddress) {
      return NextResponse.json(
        { error: "agent is approved for a different wallet — re-approve from this wallet" },
        { status: 422 },
      );
    }
    const ch = await clearinghouseState(walletAddress);
    const deployment = await goLiveDeployment(
      ctx.userId,
      id,
      walletAddress,
      Number(ch.marginSummary.accountValue),
    );
    return NextResponse.json({ deployment });
  } catch (err) {
    if (err instanceof AgentError || err instanceof DeploymentError) {
      const status = err.message.includes("not found") ? 404 : 422;
      return NextResponse.json({ error: err.message }, { status });
    }
    if (err instanceof HyperliquidError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[deployments] go-live error", err);
    return NextResponse.json({ error: "go-live failed" }, { status: 502 });
  }
}
