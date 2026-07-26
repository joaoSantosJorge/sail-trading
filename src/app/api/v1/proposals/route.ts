import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  manualPerpInputSchema,
  manualSwapInputSchema,
  manualToProposalInput,
} from "@/lib/ai/action-schemas";
import { requireUserApi } from "@/server/auth/guards";
import {
  createProposal,
  listProposals,
  ProposalError,
  validateProposal,
} from "@/server/trade/proposals";
import { createPerpProposal, validatePerpProposal } from "@/server/trade/perpProposals";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;
  const rows = await listProposals(ctx.userId);
  return NextResponse.json({
    data: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      reportId: r.reportId,
      proposal: r.proposal,
      walletAddress: r.walletAddress,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

const BodySchema = z.discriminatedUnion("kind", [
  manualSwapInputSchema.extend({ kind: z.literal("swap") }),
  manualPerpInputSchema.extend({ kind: z.literal("perp") }),
]);

/**
 * Manually create a trade proposal from the Trade page. Feeds the SAME
 * validate/clamp path as the AI tools — the caps and price-band invariants
 * cannot be bypassed — then lands on the same review-and-sign flow.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireUserApi();
  if (ctx instanceof NextResponse) return ctx;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `invalid proposal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      },
      { status: 400 },
    );
  }

  try {
    const { kind, ...manual } = parsed.data;
    const raw = manualToProposalInput(manual);
    const action =
      kind === "perp"
        ? await createPerpProposal(ctx.userId, await validatePerpProposal(ctx.userId, raw))
        : await createProposal(ctx.userId, await validateProposal(ctx.userId, raw));
    return NextResponse.json({ data: action });
  } catch (err) {
    if (err instanceof ProposalError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[proposals] create error", err);
    return NextResponse.json({ error: "failed to create proposal" }, { status: 502 });
  }
}
