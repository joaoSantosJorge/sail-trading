import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireUserPage } from "@/server/auth/guards";
import { db } from "@/server/db";
import {
  assets,
  backtestRuns,
  researchReports,
  strategies,
  tradeProposals,
} from "@/server/db/schema";
import type { Metrics } from "@/server/engine/metrics";
import type { StrategyDSL } from "@/server/engine/types";
import type { ValidatedProposal } from "@/server/trade/proposals";

export const dynamic = "force-dynamic";

const date = (d: Date) => d.toISOString().slice(0, 10);

export default async function DocumentsPage() {
  const ctx = await requireUserPage();

  const [strategyRows, runRows, reportRows, proposalRows] = await Promise.all([
    db.select().from(strategies).where(eq(strategies.userId, ctx.userId)).orderBy(desc(strategies.createdAt)),
    db
      .select({ run: backtestRuns, strategyName: strategies.name, assetSymbol: assets.symbol })
      .from(backtestRuns)
      .innerJoin(strategies, eq(backtestRuns.strategyId, strategies.id))
      .innerJoin(assets, eq(backtestRuns.assetId, assets.id))
      .where(eq(backtestRuns.userId, ctx.userId))
      .orderBy(desc(backtestRuns.createdAt)),
    db.select().from(researchReports).where(eq(researchReports.userId, ctx.userId)).orderBy(desc(researchReports.createdAt)),
    db.select().from(tradeProposals).where(eq(tradeProposals.userId, ctx.userId)).orderBy(desc(tradeProposals.createdAt)),
  ]);

  return (
    <main className="flex w-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Strategies, backtests, research reports, and trade proposals — everything the AI
            produces with your approval lives here.
          </p>
        </div>
        <Link
          href="/strategies/new"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          New strategy
        </Link>
      </div>

      <Tabs defaultValue="strategies">
        <TabsList>
          <TabsTrigger value="strategies">Strategies ({strategyRows.length})</TabsTrigger>
          <TabsTrigger value="backtests">Backtests ({runRows.length})</TabsTrigger>
          <TabsTrigger value="reports">Reports ({reportRows.length})</TabsTrigger>
          <TabsTrigger value="proposals">Proposals ({proposalRows.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="strategies">
          <ul className="divide-y rounded-lg border">
            {strategyRows.map((s) => {
              const dsl = s.dsl as StrategyDSL;
              return (
                <li key={s.id} className="px-4 py-3">
                  <Link href={`/strategies/${s.id}`} className="text-sm font-medium hover:underline">
                    {s.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {dsl.interval} · {s.source} · {date(s.createdAt)}
                  </p>
                </li>
              );
            })}
            {strategyRows.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                No strategies yet — ask the AI to create one.
              </li>
            )}
          </ul>
        </TabsContent>

        <TabsContent value="backtests">
          <ul className="divide-y rounded-lg border">
            {runRows.map(({ run, strategyName, assetSymbol }) => {
              const m = run.metrics as Metrics | null;
              return (
                <li key={run.id} className="px-4 py-3">
                  <Link href={`/backtests/${run.id}`} className="text-sm font-medium hover:underline">
                    #{run.id} · {strategyName} on {assetSymbol} ({run.interval})
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {run.status}
                    {run.status === "done" && m
                      ? ` · ${m.totalReturnPct >= 0 ? "+" : ""}${m.totalReturnPct.toFixed(1)}% vs B&H ${m.buyHoldReturnPct >= 0 ? "+" : ""}${m.buyHoldReturnPct.toFixed(1)}% · ${m.tradeCount} trades`
                      : ""}
                    {" · "}
                    {date(run.createdAt)}
                  </p>
                </li>
              );
            })}
            {runRows.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">No backtests yet.</li>
            )}
          </ul>
        </TabsContent>

        <TabsContent value="reports">
          <ul className="divide-y rounded-lg border">
            {reportRows.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <Link href={`/documents/reports/${r.id}`} className="text-sm font-medium hover:underline">
                  {r.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {r.model} · {date(r.createdAt)}
                  {r.wallet ? ` · ${r.wallet.slice(0, 8)}…` : ""}
                </p>
              </li>
            ))}
            {reportRows.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                No reports yet — after a good analysis in chat, ask the AI to save it as a report.
              </li>
            )}
          </ul>
        </TabsContent>

        <TabsContent value="proposals">
          <ul className="divide-y rounded-lg border">
            {proposalRows.map((p) => {
              const v = p.proposal as ValidatedProposal;
              return (
                <li key={p.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <Link href={`/trade/${p.id}`} className="text-sm font-medium hover:underline">
                      Proposal #{p.id} · {v.amountIn} {v.tokenIn.symbol} → {v.tokenOut.symbol}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {date(p.createdAt)}
                      {p.reportId !== null && (
                        <>
                          {" · "}
                          <Link href={`/documents/reports/${p.reportId}`} className="hover:underline">
                            thesis #{p.reportId}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                  <Badge variant="outline">{p.status}</Badge>
                </li>
              );
            })}
            {proposalRows.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                Trade proposals arrive in the trade phase.
              </li>
            )}
          </ul>
        </TabsContent>
      </Tabs>
    </main>
  );
}
