import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import {
  extraAgents,
  HyperliquidError,
  hyperliquidIsTestnet,
  relayExchangeAction,
} from "@/server/hyperliquid/info";

export const runtime = "nodejs";

/**
 * Agent-wallet plumbing for the perp trade flow. The agent PRIVATE key lives
 * only in the browser (sessionStorage); this route merely (a) reports which
 * agents the venue says are approved and (b) relays the user-wallet-signed
 * approveAgent action. Agent keys are trade-only by protocol — they can never
 * withdraw funds.
 */

export async function GET(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  }
  try {
    const agents = await extraAgents(wallet);
    return NextResponse.json({ data: { agents, isTestnet: hyperliquidIsTestnet() } });
  } catch (err) {
    const message = err instanceof HyperliquidError ? err.message : "agent lookup failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

const BodySchema = z.object({
  action: z.object({
    type: z.literal("approveAgent"),
    signatureChainId: z.string().regex(/^0x[0-9a-fA-F]+$/),
    hyperliquidChain: z.enum(["Mainnet", "Testnet"]),
    agentAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    agentName: z.string().min(1).max(30),
    nonce: z.number().int().positive(),
  }),
  signature: z.object({
    r: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    s: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
    v: z.number().int().min(27).max(28),
  }),
  nonce: z.number().int().positive(),
});

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid approveAgent payload" }, { status: 400 });
  }
  const { action, signature, nonce } = parsed.data;
  const expectedChain = hyperliquidIsTestnet() ? "Testnet" : "Mainnet";
  if (action.hyperliquidChain !== expectedChain || action.nonce !== nonce) {
    return NextResponse.json({ error: `payload must target ${expectedChain}` }, { status: 400 });
  }

  try {
    const res = await relayExchangeAction({ action, signature, nonce });
    if (res.status !== "ok") {
      return NextResponse.json(
        { error: `approveAgent rejected: ${JSON.stringify(res).slice(0, 200)}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ data: { approved: true } });
  } catch (err) {
    const message = err instanceof HyperliquidError ? err.message : "approveAgent relay failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
