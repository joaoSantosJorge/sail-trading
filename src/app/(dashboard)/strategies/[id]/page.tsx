import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BacktestLauncher } from "@/components/BacktestLauncher";
import { renderCondition, renderIndicators, renderRisk } from "@/lib/dslRender";
import { db } from "@/server/db";
import { assets, backtestRuns, strategies } from "@/server/db/schema";
import type { Metrics } from "@/server/engine/metrics";
import type { StrategyDSL } from "@/server/engine/types";

export const dynamic = "force-dynamic";

export default async function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [strategy] = await db.select().from(strategies).where(eq(strategies.id, Number(id)));
  if (!strategy) notFound();
  const dsl = strategy.dsl as StrategyDSL;

  const assetRows = await db
    .select({ id: assets.id, symbol: assets.symbol, name: assets.name })
    .from(assets)
    .orderBy(assets.id);
  const runs = await db
    .select()
    .from(backtestRuns)
    .where(eq(backtestRuns.strategyId, strategy.id))
    .orderBy(desc(backtestRuns.createdAt));

  return (
    <main className="flex w-full flex-col gap-6 p-6">
      <div>
        <Link href="/strategies" className="text-sm text-muted-foreground hover:underline">
          ← strategies
        </Link>
        <h1 className="text-2xl font-semibold">{strategy.name}</h1>
        <p className="text-sm text-muted-foreground">
          {dsl.interval} · {strategy.source}
        </p>
      </div>

      <section className="flex flex-col gap-2 text-sm">
        <p>{dsl.description}</p>
        <div className="rounded-lg border p-4 font-mono text-xs leading-relaxed">
          {renderIndicators(dsl).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="mt-2">
            <span className="text-success">ENTER</span> when {renderCondition(dsl.entry)}
          </p>
          <p>
            <span className="text-destructive">EXIT</span> when {renderCondition(dsl.exit)}
          </p>
          <p className="mt-2 text-muted-foreground">{renderRisk(dsl).join(" · ")}</p>
        </div>
      </section>

      <BacktestLauncher strategyId={strategy.id} assets={assetRows} />

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Backtest runs</h2>
        {runs.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
        <ul className="flex flex-col gap-1 text-sm">
          {runs.map((run) => {
            const asset = assetRows.find((a) => a.id === run.assetId);
            const metrics = run.metrics as Metrics | null;
            return (
              <li key={run.id}>
                <Link href={`/backtests/${run.id}`} className="hover:underline">
                  #{run.id} · {asset?.symbol} {run.interval} · {run.status}
                  {run.status === "done" && metrics && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {metrics.totalReturnPct.toFixed(1)}% ({metrics.tradeCount} trades)
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Raw DSL</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg border p-3 text-xs">
          {JSON.stringify(dsl, null, 2)}
        </pre>
      </details>
    </main>
  );
}
