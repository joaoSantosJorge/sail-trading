import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { requireUserPage } from "@/server/auth/guards";
import { listProposals, type ValidatedProposal } from "@/server/trade/proposals";
import { uniswapConfigured } from "@/server/uniswap/client";

export const dynamic = "force-dynamic";

export default async function TradePage() {
  const ctx = await requireUserPage();
  const proposals = await listProposals(ctx.userId);

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Trade</h1>
        <p className="text-sm text-muted-foreground">
          Review AI trade proposals and execute swaps from your own wallet — your signature is the
          only authorization. Ask the assistant to propose a trade to get started.
        </p>
      </div>

      {!uniswapConfigured() && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          UNISWAP_API_KEY is not set — proposals can be created and reviewed, but quoting and
          execution are disabled until the key is added.
        </p>
      )}

      {proposals.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No trade proposals yet. Try asking the AI: &ldquo;propose swapping $20 of ETH to USDC on
          Base&rdquo;.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {proposals.map((row) => {
            const p = row.proposal as ValidatedProposal;
            return (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/trade/${row.id}`} className="text-sm font-medium hover:underline">
                    #{row.id} · {p.amountIn} {p.tokenIn.symbol} → {p.tokenOut.symbol} on {p.chainName}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    ${p.sizeUsd.toFixed(2)} · {row.createdAt.toISOString().slice(0, 16).replace("T", " ")}
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
                <Badge variant={row.status === "executed" ? "default" : "outline"}>{row.status}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
