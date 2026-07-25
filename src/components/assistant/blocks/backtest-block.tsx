"use client";

import { useEffect, useState } from "react";
import { backtestSpecSchema } from "@/lib/ai/render-schemas";
import { BacktestResultChart } from "@/components/BacktestResultChart";
import type { BacktestParams, EquityPoint, Trade } from "@/server/engine/backtest";
import type { Metrics } from "@/server/engine/metrics";
import type { Interval } from "@/server/market/types";
import { BlockError, BlockFrame, BlockPending } from "./block-frame";

type RunPayload = {
  id: number;
  assetId: number;
  interval: Interval;
  fromT: number;
  toT: number;
  status: string;
  params: BacktestParams;
  metrics: Metrics;
  trades: Trade[];
  equityCurve: EquityPoint[];
  strategyName: string;
  assetSymbol: string;
};

const fmt = (v: number, digits = 2) =>
  Number.isFinite(v) ? v.toFixed(digits) : v === Infinity ? "∞" : "—";

function RunView({ runId }: { runId: number }) {
  const [run, setRun] = useState<RunPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/backtests/${runId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        return res.json() as Promise<{ data: RunPayload }>;
      })
      .then(({ data }) => {
        if (!cancelled) setRun(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) return <BlockError tool="render_backtest" detail={error} />;
  if (!run) return <BlockPending label="Loading backtest…" />;
  if (run.status !== "done") return <BlockError tool="render_backtest" detail={`run is ${run.status}`} />;

  const m = run.metrics;
  const stats: [string, string][] = [
    ["Return", `${fmt(m.totalReturnPct)}%`],
    ["Buy & hold", `${fmt(m.buyHoldReturnPct)}%`],
    ["Max DD", `${fmt(m.maxDrawdownPct)}%`],
    ["Sharpe", fmt(m.sharpe)],
    ["Win rate", `${fmt(m.winRatePct, 1)}%`],
    ["Trades", String(m.tradeCount)],
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-md border px-2 py-1.5">
            <p className="truncate text-[11px] text-muted-foreground">{label}</p>
            <p className="text-sm font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <BacktestResultChart
        assetId={run.assetId}
        interval={run.interval}
        fromT={run.fromT}
        toT={run.toT}
        trades={run.trades}
        equityCurve={run.equityCurve}
        initialEquity={run.params.initialEquity}
      />
      <p className="text-[11px] text-muted-foreground">
        Run #{run.id} · {run.strategyName} on {run.assetSymbol} ({run.interval})
      </p>
    </div>
  );
}

/**
 * Backtest results block rendered from a render_backtest spec ({runId}) —
 * the block fetches the persisted run from /api/v1/backtests/[id].
 */
export function BacktestBlock({ args, streaming }: { args: unknown; streaming?: boolean }) {
  const parsed = backtestSpecSchema.safeParse(args);
  if (!parsed.success) {
    return streaming ? (
      <BlockPending label="Preparing backtest view…" />
    ) : (
      <BlockError tool="render_backtest" />
    );
  }
  return (
    <BlockFrame title={parsed.data.title}>
      <RunView runId={parsed.data.runId} />
    </BlockFrame>
  );
}
