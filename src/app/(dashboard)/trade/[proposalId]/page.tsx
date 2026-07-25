import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { TradeFlow } from "@/components/trade/trade-flow";
import { requireUserPage } from "@/server/auth/guards";
import { getProposal, type ValidatedProposal } from "@/server/trade/proposals";
import { uniswapConfigured } from "@/server/uniswap/client";

export const dynamic = "force-dynamic";

export default async function ProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const ctx = await requireUserPage();
  const { proposalId } = await params;
  const row = await getProposal(ctx.userId, Number(proposalId));
  if (!row) notFound();
  const p = row.proposal as ValidatedProposal;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <Link href="/trade" className="text-sm text-muted-foreground hover:underline">
          ← trade
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {p.amountIn} {p.tokenIn.symbol} → {p.tokenOut.symbol}
          </h1>
          <Badge variant={row.status === "executed" ? "default" : "outline"}>{row.status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {p.chainName} · ~${p.sizeUsd.toFixed(2)} · wallet {p.walletAddress.slice(0, 8)}…
          {p.walletAddress.slice(-4)}
          {row.expiresAt ? ` · expires ${row.expiresAt.toLocaleString()}` : ""}
        </p>
      </div>

      <div className="rounded-lg border p-4 text-sm">
        <h2 className="mb-1 font-medium">AI rationale</h2>
        <p className="leading-relaxed">{p.rationale}</p>
        <h3 className="mt-3 mb-1 font-medium">Risks</h3>
        <ul className="list-disc space-y-0.5 pl-5">
          {p.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          <span className="font-medium">Invalidation:</span> {p.invalidation} ·{" "}
          <span className="font-medium">Confidence:</span> {p.confidence}
        </p>
        {row.reportId !== null && (
          <p className="mt-3 text-sm">
            <Link
              href={`/documents/reports/${row.reportId}`}
              className="font-medium text-primary hover:underline"
            >
              View thesis report →
            </Link>
          </p>
        )}
      </div>

      <TradeFlow
        proposalId={row.id}
        status={row.status}
        proposal={p}
        tradingConfigured={uniswapConfigured()}
      />
    </main>
  );
}
