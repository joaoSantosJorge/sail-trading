import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUserPage } from "@/server/auth/guards";
import { listProposals, type ValidatedProposal } from "@/server/trade/proposals";
import type { ValidatedPerpProposal } from "@/server/trade/perpProposals";
import { uniswapConfigured } from "@/server/uniswap/client";

export const dynamic = "force-dynamic";

export default async function TradePage() {
  const ctx = await requireUserPage();
  const proposals = await listProposals(ctx.userId);

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Trade</h1>
          <p className="text-sm text-muted-foreground">
            Review trade proposals and execute them from your own wallet — your signature is the
            only authorization. Create one manually or ask the assistant.
          </p>
        </div>
        <Button render={<Link href="/trade/new" />}>New trade</Button>
      </div>

      {!uniswapConfigured() && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          UNISWAP_API_KEY is not set — proposals can be created and reviewed, but quoting and
          execution are disabled until the key is added.
        </p>
      )}

      {proposals.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No trade proposals yet. Create one with &ldquo;New trade&rdquo;, or ask the AI:
          &ldquo;propose swapping $20 of ETH to USDC on Base&rdquo;.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {proposals.map((row) => {
            const perp = row.kind === "perp" ? (row.proposal as ValidatedPerpProposal) : null;
            const swap = perp ? null : (row.proposal as ValidatedProposal);
            const label = perp
              ? `${perp.side.toUpperCase()} ${perp.size} ${perp.coin}-PERP ${perp.leverage}x ${
                  perp.orderType === "market" ? "@ market" : `@ ${perp.limitPx}`
                }`
              : `${swap!.amountIn} ${swap!.tokenIn.symbol} → ${swap!.tokenOut.symbol} on ${swap!.chainName}`;
            const usd = perp ? perp.notionalUsd : swap!.sizeUsd;
            const triggers = perp
              ? [
                  perp.stopLossPx !== null ? `SL ${perp.stopLossPx}` : null,
                  perp.takeProfitPx !== null ? `TP ${perp.takeProfitPx}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "";
            return (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/trade/${row.id}`} className="text-sm font-medium hover:underline">
                    #{row.id} · {label}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    ${usd.toFixed(2)}
                    {triggers && ` · ${triggers}`} ·{" "}
                    {row.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    {row.expiresAt ? ` · expires ${row.expiresAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}
                    {row.reportId !== null && (
                      <>
                        {" · "}
                        <Link
                          href={`/documents/reports/${row.reportId}`}
                          className="hover:underline"
                        >
                          thesis #{row.reportId}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {(perp ?? swap)!.source === "manual" && <Badge variant="outline">manual</Badge>}
                  <Badge variant={row.status === "executed" ? "default" : "outline"}>
                    {row.status}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
