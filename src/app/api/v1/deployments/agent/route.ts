import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import {
  agentStatusForWallet,
  ensureSignerWallet,
  AGENT_NAME,
  AgentError,
} from "@/server/deployments/agents";
import {
  HyperliquidError,
  hyperliquidIsTestnet,
  relayExchangeAction,
} from "@/server/hyperliquid/info";
import { signerConfigured } from "@/server/signer/privy";
import { SignerError } from "@/server/signer/types";

export const runtime = "nodejs";

/**
 * Enclave agent-wallet plumbing for LIVE deployments. Unlike the trade-page
 * flow (browser-held agent key), the agent key here is minted inside the
 * managed signer's enclave and never exists anywhere else. This route:
 *  (a) GET   — reports the enclave agent + its venue approval for a wallet
 *  (b) POST ensure  — mints the user's enclave wallet (idempotent)
 *  (c) POST approve — relays the user-main-wallet-signed approveAgent for
 *      EXACTLY the stored enclave agent address, then records validUntil.
 */

export async function GET(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const wallet = req.nextUrl.searchParams.get("wallet")?.toLowerCase();
  if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
    return NextResponse.json({ error: "wallet query param required" }, { status: 400 });
  }
  try {
    const status = await agentStatusForWallet(ctx.userId, wallet);
    return NextResponse.json({
      data: {
        configured: signerConfigured(),
        agentName: AGENT_NAME,
        isTestnet: hyperliquidIsTestnet(),
        status, // null = no enclave wallet minted yet
      },
    });
  } catch (err) {
    const message = err instanceof HyperliquidError ? err.message : "agent status failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

const EnsureSchema = z.object({ op: z.literal("ensure") });
const ApproveSchema = z.object({
  op: z.literal("approve"),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
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
const BodySchema = z.discriminatedUnion("op", [EnsureSchema, ApproveSchema]);

export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  try {
    if (parsed.data.op === "ensure") {
      const row = await ensureSignerWallet(ctx.userId);
      return NextResponse.json({
        data: { agentAddress: row.agentAddress, agentName: AGENT_NAME },
      });
    }

    const { wallet, action, signature, nonce } = parsed.data;
    const expectedChain = hyperliquidIsTestnet() ? "Testnet" : "Mainnet";
    if (action.hyperliquidChain !== expectedChain || action.nonce !== nonce) {
      return NextResponse.json({ error: `payload must target ${expectedChain}` }, { status: 400 });
    }
    // SAFETY RAIL: only the user's stored enclave agent may be approved here.
    const row = await ensureSignerWallet(ctx.userId);
    if (action.agentAddress.toLowerCase() !== row.agentAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "blocked: agentAddress is not your enclave agent" },
        { status: 400 },
      );
    }

    const res = await relayExchangeAction({ action, signature, nonce });
    if (res.status !== "ok") {
      return NextResponse.json(
        { error: `approveAgent rejected: ${JSON.stringify(res).slice(0, 200)}` },
        { status: 502 },
      );
    }
    // Record venue truth (validUntil) for the freshly approved agent.
    const status = await agentStatusForWallet(ctx.userId, wallet.toLowerCase());
    return NextResponse.json({ data: { approved: status?.approved ?? true, status } });
  } catch (err) {
    if (err instanceof SignerError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof AgentError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof HyperliquidError ? err.message : "agent request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
