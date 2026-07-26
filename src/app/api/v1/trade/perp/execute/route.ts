import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUserApi } from "@/server/auth/guards";
import { db } from "@/server/db";
import { executions } from "@/server/db/schema";
import {
  HyperliquidError,
  orderStatus,
  relayExchangeAction,
} from "@/server/hyperliquid/info";
import { getProposal, setProposalStatus } from "@/server/trade/proposals";
import type { ValidatedPerpProposal } from "@/server/trade/perpProposals";
import { takeQuote } from "@/server/trade/quotes";

export const runtime = "nodejs";
export const maxDuration = 60;

const SignatureSchema = z.object({
  r: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  s: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
  v: z.number().int().min(27).max(28),
});
const SignedActionSchema = z.object({
  action: z.record(z.string(), z.unknown()),
  signature: SignatureSchema,
  nonce: z.number().int().positive(),
});
const BodySchema = z.object({
  quoteId: z.string().uuid(),
  order: SignedActionSchema,
  updateLeverage: SignedActionSchema.optional(),
});

/** Nonces are client timestamps; reject anything not minted around now. */
const NONCE_SKEW_MS = 5 * 60 * 1000;

/**
 * Relay a browser-signed perp order to Hyperliquid and confirm the outcome
 * server-side. SAFETY RAILS: only server-minted single-use quoteIds are
 * accepted, and each signed action must byte-match the action stored with the
 * quote — a tampered payload simply doesn't match (and a re-signed one would
 * carry a different action anyway). The server never signs anything.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "quoteId, order{action,signature,nonce} required" }, { status: 400 });
  }
  const body = parsed.data;

  const stored = takeQuote(body.quoteId, ctx.userId);
  if (stored === null) return NextResponse.json({ error: "unknown quoteId" }, { status: 404 });
  if (stored === "expired") {
    return NextResponse.json({ error: "quote expired — get a fresh quote" }, { status: 410 });
  }

  const row = await getProposal(ctx.userId, stored.proposalId);
  if (!row || row.kind !== "perp") {
    return NextResponse.json({ error: "proposal not found" }, { status: 404 });
  }
  if (row.status !== "approved") {
    return NextResponse.json({ error: `proposal is ${row.status}` }, { status: 409 });
  }
  const proposal = row.proposal as ValidatedPerpProposal;

  // SAFETY RAIL: signed actions must equal the server-minted quote actions.
  const q = stored.quote as {
    orderAction: Record<string, unknown>;
    updateLeverageAction: Record<string, unknown> | null;
  };
  if (JSON.stringify(body.order.action) !== JSON.stringify(q.orderAction)) {
    console.error("[trade/perp/execute] BLOCKED order action mismatch");
    return NextResponse.json({ error: "blocked: signed order does not match the quote" }, { status: 400 });
  }
  if (q.updateLeverageAction !== null) {
    if (!body.updateLeverage) {
      return NextResponse.json({ error: "updateLeverage action missing" }, { status: 400 });
    }
    if (JSON.stringify(body.updateLeverage.action) !== JSON.stringify(q.updateLeverageAction)) {
      console.error("[trade/perp/execute] BLOCKED updateLeverage action mismatch");
      return NextResponse.json({ error: "blocked: signed leverage update does not match the quote" }, { status: 400 });
    }
  }
  const now = Date.now();
  for (const signed of [body.order, body.updateLeverage].filter(Boolean) as { nonce: number }[]) {
    if (Math.abs(now - signed.nonce) > NONCE_SKEW_MS) {
      return NextResponse.json({ error: "stale nonce — re-sign and retry" }, { status: 400 });
    }
  }

  try {
    if (body.updateLeverage) {
      const levRes = await relayExchangeAction(body.updateLeverage);
      if (levRes.status !== "ok") {
        return NextResponse.json(
          { error: `leverage update rejected: ${JSON.stringify(levRes).slice(0, 200)}` },
          { status: 502 },
        );
      }
    }

    // Record the attempt before relaying the order (mirrors the EVM flow).
    const [execution] = await db
      .insert(executions)
      .values({
        userId: ctx.userId,
        proposalId: row.id,
        userWallet: proposal.walletAddress,
        venue: "hyperliquid",
        chainId: null,
        quote: stored.quote,
        status: "pending",
      })
      .returning({ id: executions.id });

    const orderRes = await relayExchangeAction(body.order);
    // One status per order in the action's orders array: [entry, ...triggers].
    // The entry (index 0) decides the proposal outcome; TP/SL trigger exits
    // rest until the entry fills.
    const statuses =
      (orderRes as { response?: { data?: { statuses?: unknown[] } } }).response?.data?.statuses ??
      [];
    const status = statuses[0];

    if (orderRes.status !== "ok" || status === undefined || (typeof status === "object" && status !== null && "error" in status)) {
      const reason =
        typeof status === "object" && status !== null && "error" in status
          ? String((status as { error: unknown }).error)
          : JSON.stringify(orderRes).slice(0, 200);
      await db
        .update(executions)
        .set({ status: "failed", receipt: { reason, response: orderRes } })
        .where(eq(executions.id, execution.id));
      return NextResponse.json({ error: `order rejected: ${reason}` }, { status: 502 });
    }

    // Trigger exits (statuses[1..]): collect resting oids; a rejected trigger
    // does NOT fail the execution — the entry already went through — but it
    // is recorded and surfaced so the user knows the exit is NOT in place.
    const triggerOids: number[] = [];
    const triggerErrors: string[] = [];
    for (const t of statuses.slice(1)) {
      if (typeof t === "object" && t !== null && "resting" in t) {
        triggerOids.push((t as { resting: { oid: number } }).resting.oid);
      } else if (typeof t === "object" && t !== null && "error" in t) {
        triggerErrors.push(String((t as { error: unknown }).error));
      }
    }

    let oid: number | null = null;
    let outcome: "confirmed" | "pending" = "pending";
    let fill: { totalSz: string; avgPx: string } | null = null;

    if (typeof status === "object" && status !== null && "filled" in status) {
      const f = (status as { filled: { oid: number; totalSz: string; avgPx: string } }).filled;
      oid = f.oid;
      fill = { totalSz: f.totalSz, avgPx: f.avgPx };
      outcome = "confirmed";
    } else if (typeof status === "object" && status !== null && "resting" in status) {
      oid = (status as { resting: { oid: number } }).resting.oid;
      // Server-side confirm loop: give a resting order a few seconds to fill.
      for (let i = 0; i < 5 && outcome === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const os = await orderStatus(proposal.walletAddress, oid);
        if (os.status === "order" && os.order.status === "filled") outcome = "confirmed";
        if (os.status === "order" && ["canceled", "rejected", "marginCanceled"].includes(os.order.status)) {
          await db
            .update(executions)
            .set({ status: "failed", externalId: String(oid), receipt: { reason: os.order.status } })
            .where(eq(executions.id, execution.id));
          return NextResponse.json({ error: `order ${os.order.status}` }, { status: 502 });
        }
      }
    }

    await db
      .update(executions)
      .set({
        status: outcome,
        externalId: oid !== null ? String(oid) : null,
        receipt: { status, fill, triggerOids, triggerErrors },
      })
      .where(eq(executions.id, execution.id));
    // The user's signed order was accepted by the venue — the proposal is
    // executed even if a Gtc limit order is still resting in the book.
    await setProposalStatus(ctx.userId, row.id, "executed");

    return NextResponse.json({
      data: {
        executionId: execution.id,
        status: outcome,
        oid,
        fill,
        resting: outcome === "pending",
        triggerOids,
        warning:
          triggerErrors.length > 0
            ? `entry placed, but ${triggerErrors.length === 1 ? "a TP/SL order was" : "TP/SL orders were"} rejected: ${triggerErrors.join("; ")} — your exit is NOT in place`
            : null,
      },
    });
  } catch (err) {
    if (err instanceof HyperliquidError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[trade/perp/execute] error", err);
    return NextResponse.json({ error: "execution failed" }, { status: 502 });
  }
}
