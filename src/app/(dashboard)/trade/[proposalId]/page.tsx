import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { PerpTradeFlow } from "@/components/trade/perp-trade-flow";
import { TradeFlow } from "@/components/trade/trade-flow";
import { requireUserPage } from "@/server/auth/guards";
import { hyperliquidIsTestnet } from "@/server/hyperliquid/info";
import { getProposal, type ValidatedProposal } from "@/server/trade/proposals";
import type { ValidatedPerpProposal } from "@/server/trade/perpProposals";
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

  const isPerp = row.kind === "perp";
  const perp = isPerp ? (row.proposal as ValidatedPerpProposal) : null;
  const swap = isPerp ? null : (row.proposal as ValidatedProposal);

  const title = perp
    ? `${perp.side.toUpperCase()} ${perp.size} ${perp.coin}-PERP`
    : `${swap!.amountIn} ${swap!.tokenIn.symbol} → ${swap!.tokenOut.symbol}`;
  const subtitle = perp
    ? `Hyperliquid perps · ${perp.leverage}x · ~$${perp.notionalUsd.toFixed(2)}`
    : `${swap!.chainName} · ~$${swap!.sizeUsd.toFixed(2)}`;
  const shared = (perp ?? swap)!;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
      <div>
        <Link href="/trade" className="text-sm text-muted-foreground hover:underline">
          ← trade
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <Badge variant={row.status === "executed" ? "default" : "outline"}>{row.status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {subtitle} · wallet {shared.walletAddress.slice(0, 8)}…{shared.walletAddress.slice(-4)}
          {row.expiresAt ? ` · expires ${row.expiresAt.toLocaleString()}` : ""}
        </p>
      </div>

      <div className="rounded-lg border p-4 text-sm">
        <h2 className="mb-1 font-medium">AI rationale</h2>
        <p className="leading-relaxed">{shared.rationale}</p>
        <h3 className="mt-3 mb-1 font-medium">Risks</h3>
        <ul className="list-disc space-y-0.5 pl-5">
          {shared.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          <span className="font-medium">Invalidation:</span> {shared.invalidation} ·{" "}
          <span className="font-medium">Confidence:</span> {shared.confidence}
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

      {perp ? (
        <PerpTradeFlow
          proposalId={row.id}
          status={row.status}
          proposal={perp}
          isTestnet={hyperliquidIsTestnet()}
        />
      ) : (
        <TradeFlow
          proposalId={row.id}
          status={row.status}
          proposal={swap!}
          tradingConfigured={uniswapConfigured()}
        />
      )}
    </main>
  );
}
