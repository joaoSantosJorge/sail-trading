import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, http, type Chain } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { executions } from "@/server/db/schema";
import { setProposalStatus } from "@/server/trade/proposals";

export const runtime = "nodejs";
export const maxDuration = 120;

const CHAINS: Record<number, Chain> = { 1: mainnet, 8453: base, 42161: arbitrum };

const BodySchema = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

/**
 * Client reports the signed transaction hash; the SERVER verifies the receipt
 * on-chain before marking the execution confirmed (never trusts the client's
 * word for success).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  const executionId = Number(id);
  if (!Number.isInteger(executionId)) {
    return NextResponse.json({ error: "invalid execution id" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "txHash (0x…64 hex) required" }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(executions)
    .where(and(eq(executions.id, executionId), eq(executions.userId, ctx.userId)));
  if (!row) return NextResponse.json({ error: "execution not found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ error: `execution is ${row.status}` }, { status: 409 });
  }

  const chain = CHAINS[row.chainId];
  if (!chain) return NextResponse.json({ error: "unsupported chain" }, { status: 400 });

  await db
    .update(executions)
    .set({ txHash: parsed.data.txHash })
    .where(eq(executions.id, executionId));

  try {
    const client = createPublicClient({ chain, transport: http() });
    const receipt = await client.waitForTransactionReceipt({
      hash: parsed.data.txHash as `0x${string}`,
      timeout: 90_000,
    });

    const status = receipt.status === "success" ? "confirmed" : "failed";
    await db
      .update(executions)
      .set({
        status,
        receipt: {
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          status: receipt.status,
          from: receipt.from,
          to: receipt.to,
        },
      })
      .where(eq(executions.id, executionId));

    if (status === "confirmed") {
      try {
        await setProposalStatus(ctx.userId, row.proposalId, "executed");
      } catch {
        // status race (e.g. already executed) — the execution row is the record
      }
    }

    return NextResponse.json({ data: { status, txHash: parsed.data.txHash } });
  } catch (err) {
    console.error("[executions] receipt verification failed", err);
    return NextResponse.json(
      {
        data: { status: "pending", txHash: parsed.data.txHash },
        warning: "receipt not yet verifiable — it may still confirm; re-check later",
      },
      { status: 202 },
    );
  }
}
