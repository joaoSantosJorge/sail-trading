import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BacktestResultChart } from "@/components/BacktestResultChart";
import { db } from "@/server/db";
import { assets, backtestRuns, strategies } from "@/server/db/schema";
import type { BacktestParams, EquityPoint, Trade } from "@/server/engine/backtest";
import type { Metrics } from "@/server/engine/metrics";
import type { Interval } from "@/server/market/types";

export const dynamic = "force-dynamic";

const fmt = (v: number, digits = 2) =>
  Number.isFinite(v) ? v.toFixed(digits) : v === Infinity ? "∞" : "—";

export default async function BacktestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, Number(id)));
  if (!run) notFound();

  const [strategy] = await db.select().from(strategies).where(eq(strategies.id, run.strategyId));
  const [asset] = await db.select().from(assets).where(eq(assets.id, run.assetId));

  if (run.status !== "done") {
    return (
      <main className="flex w-full flex-col p-6">
        <h1 className="text-2xl font-semibold">Backtest #{run.id}</h1>
        <p className="mt-4 text-sm text-destructive">
          Status: {run.status}
          {run.status === "failed" && ` — ${(run.metrics as { error?: string })?.error}`}
        </p>
      </main>
    );
  }

  const metrics = run.metrics as Metrics;
  const trades = run.trades as Trade[];
  const equityCurve = run.equityCurve as EquityPoint[];
  const runParams = run.params as BacktestParams;

  const stats: [string, string][] = [
    ["Total return", `${fmt(metrics.totalReturnPct)}%`],
    ["Buy & hold", `${fmt(metrics.buyHoldReturnPct)}%`],
    ["CAGR", `${fmt(metrics.cagrPct)}%`],
    ["Max drawdown", `${fmt(metrics.maxDrawdownPct)}%`],
    ["Sharpe", fmt(metrics.sharpe)],
    ["Win rate", `${fmt(metrics.winRatePct, 1)}%`],
    ["Profit factor", fmt(metrics.profitFactor)],
    ["Trades", String(metrics.tradeCount)],
    ["Avg trade P&L", `$${fmt(metrics.avgTradePnlUsd)}`],
    ["Time in market", `${fmt(metrics.timeInMarketPct, 1)}%`],
  ];

  return (
    <main className="flex w-full flex-col gap-6 p-6">
      <div>
        <Link
          href={`/strategies/${run.strategyId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {strategy?.name}
        </Link>
        <h1 className="text-2xl font-semibold">
          Backtest #{run.id} · {asset?.symbol} {run.interval}
        </h1>
        <p className="text-sm text-muted-foreground">
          {new Date(run.fromT).toISOString().slice(0, 10)} →{" "}
          {new Date(run.toT).toISOString().slice(0, 10)} · fee {runParams.feeBps}bps · slippage{" "}
          {runParams.slippageBps}bps · gas ${runParams.gasUsd} · start $
          {runParams.initialEquity.toLocaleString()}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-sm font-medium">{value}</p>
          </div>
        ))}
      </section>

      <BacktestResultChart
        assetId={run.assetId}
        interval={run.interval as Interval}
        fromT={run.fromT}
        toT={run.toT}
        trades={trades}
        equityCurve={equityCurve}
        initialEquity={runParams.initialEquity}
      />

      <section>
        <h2 className="mb-2 font-medium">Trades ({trades.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1.5 font-normal">Entry</th>
                <th className="py-1.5 font-normal">Exit</th>
                <th className="py-1.5 font-normal">Entry px</th>
                <th className="py-1.5 font-normal">Exit px</th>
                <th className="py-1.5 font-normal">P&L</th>
                <th className="py-1.5 font-normal">%</th>
                <th className="py-1.5 font-normal">Reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.entryT} className="border-b last:border-0">
                  <td className="py-1.5">{new Date(t.entryT).toISOString().slice(0, 16)}</td>
                  <td className="py-1.5">{new Date(t.exitT).toISOString().slice(0, 16)}</td>
                  <td className="py-1.5">{t.entryPrice.toFixed(4)}</td>
                  <td className="py-1.5">{t.exitPrice.toFixed(4)}</td>
                  <td className={`py-1.5 ${t.pnlUsd >= 0 ? "text-success" : "text-destructive"}`}>
                    ${t.pnlUsd.toFixed(2)}
                  </td>
                  <td className={`py-1.5 ${t.pnlPct >= 0 ? "text-success" : "text-destructive"}`}>
                    {t.pnlPct.toFixed(2)}%
                  </td>
                  <td className="py-1.5 text-muted-foreground">{t.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
