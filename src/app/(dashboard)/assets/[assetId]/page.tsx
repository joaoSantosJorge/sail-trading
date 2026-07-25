import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AskAiButton } from "@/components/assets/ask-ai-button";
import { AssetChartPro } from "@/components/assets/kline-chart";
import { hasIntradaySource } from "@/server/market/candleCache";
import { isChartInterval, type ChartInterval } from "@/server/market/types";
import { requireUserPage } from "@/server/auth/guards";
import { getSavedChart } from "@/server/charts/savedCharts";
import { db } from "@/server/db";
import { assets, backtestRuns, strategies } from "@/server/db/schema";
import type { Metrics } from "@/server/engine/metrics";
import { assetSnapshot } from "@/server/market/snapshot";
import { getNews } from "@/server/news/newsCache";

export const dynamic = "force-dynamic";

const usd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 1 ? 6 : 2 });

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const cls = value > 0 ? "text-success" : value < 0 ? "text-destructive" : "text-muted-foreground";
  return <span className={cls}>{value > 0 ? "+" : ""}{value.toFixed(2)}%</span>;
}

export default async function AssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ assetId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireUserPage();
  const { assetId } = await params;
  const sp = await searchParams;
  const id = Number(assetId);
  if (!Number.isInteger(id)) notFound();

  const [asset] = await db.select().from(assets).where(eq(assets.id, id));
  if (!asset) notFound();

  // Deep link to a saved chart: ?chart=<id>. Missing/unowned ids are ignored.
  const savedChartId = Number(sp.chart);
  const savedChart =
    Number.isInteger(savedChartId) && savedChartId > 0
      ? await getSavedChart(db, ctx.userId, savedChartId)
      : null;
  const savedForAsset = savedChart && savedChart.assetId === asset.id ? savedChart : null;

  // Interval precedence: explicit ?interval= → saved chart → 1d. Sub-daily
  // intervals need an intraday source (Binance/Hyperliquid); fall back to 1d.
  const requested =
    sp.interval && isChartInterval(sp.interval)
      ? sp.interval
      : savedForAsset && isChartInterval(savedForAsset.interval)
        ? savedForAsset.interval
        : "1d";
  const initialInterval: ChartInterval =
    !hasIntradaySource(asset) && requested !== "1d" ? "1d" : requested;

  const [snapshot, news, runs] = await Promise.all([
    assetSnapshot(asset),
    getNews(db, { currencies: [asset.symbol], limit: 6 }),
    db
      .select({ run: backtestRuns, strategyName: strategies.name })
      .from(backtestRuns)
      .innerJoin(strategies, eq(backtestRuns.strategyId, strategies.id))
      .where(and(eq(backtestRuns.assetId, id), eq(backtestRuns.userId, ctx.userId)))
      .orderBy(desc(backtestRuns.createdAt))
      .limit(5),
  ]);

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <Link href="/assets" className="text-sm text-muted-foreground hover:underline">
            ← assets
          </Link>
          <h1 className="text-2xl font-semibold">
            {asset.name} <span className="text-muted-foreground">({asset.symbol}/USD)</span>
          </h1>
          {snapshot && (
            <span className="font-mono text-xl tabular-figures">{usd(snapshot.lastClose)}</span>
          )}
          {snapshot && <Delta value={snapshot.change24hPct} />}
        </div>
        <AskAiButton
          prompt={`Give me a concise research take on ${asset.symbol}: recent price action, momentum, and anything notable. Chart it with the overlays you find most relevant.`}
          label={`Ask AI about ${asset.symbol}`}
        />
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="flex min-h-[480px] flex-col rounded-lg border p-3">
          <AssetChartPro
            assetId={asset.id}
            symbol={asset.symbol}
            hasIntraday={hasIntradaySource(asset)}
            lastPrice={snapshot?.lastClose}
            initialInterval={initialInterval}
            initialState={
              savedForAsset
                ? { drawings: savedForAsset.drawings, indicators: savedForAsset.indicators }
                : null
            }
            saved={savedForAsset ? { id: savedForAsset.id, name: savedForAsset.name } : null}
          />
        </div>

        <div className="flex flex-col gap-4">
          {snapshot && (
            <div className="rounded-lg border p-4">
              <h2 className="mb-2 text-sm font-medium">Stats (daily candles)</h2>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">24h</dt><dd><Delta value={snapshot.change24hPct} /></dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">7d</dt><dd><Delta value={snapshot.change7dPct} /></dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">30d</dt><dd><Delta value={snapshot.change30dPct} /></dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">90d high</dt><dd className="font-mono tabular-figures">{usd(snapshot.high90d)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">90d low</dt><dd className="font-mono tabular-figures">{usd(snapshot.low90d)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">vs 90d high</dt><dd><Delta value={snapshot.distanceFrom90dHighPct} /></dd></div>
              </dl>
              <p className="mt-2 text-[11px] text-muted-foreground">as of {snapshot.lastCandleDate} (last closed bar)</p>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <h2 className="mb-2 text-sm font-medium">{asset.symbol} news</h2>
            {!news.configured ? (
              <p className="text-xs text-muted-foreground">
                Add CRYPTOPANIC_API_KEY to enable per-asset news.
              </p>
            ) : news.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent headlines.</p>
            ) : (
              <ul className="space-y-2">
                {news.items.map((n) => (
                  <li key={n.id}>
                    <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium leading-snug hover:underline">
                      {n.title}
                    </a>
                    <p className="text-[11px] text-muted-foreground">{n.sourceDomain}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-lg border p-4">
            <h2 className="mb-2 text-sm font-medium">Backtests on {asset.symbol}</h2>
            {runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None yet — ask the AI to backtest a strategy on {asset.symbol}.
              </p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {runs.map(({ run, strategyName }) => {
                  const m = run.metrics as Metrics | null;
                  return (
                    <li key={run.id}>
                      <Link href={`/backtests/${run.id}`} className="hover:underline">
                        #{run.id} {strategyName}
                        {run.status === "done" && m
                          ? ` — ${m.totalReturnPct >= 0 ? "+" : ""}${m.totalReturnPct.toFixed(1)}%`
                          : ` — ${run.status}`}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
