"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type StrategyOption = { id: number; name: string; interval: string };
type AssetOption = { id: number; symbol: string; name: string; intraday: boolean };

/**
 * New-deployment form. M1: paper mode only — the bot simulates fills and
 * builds a track record before any real order is possible (live mode is the
 * next milestone).
 */
export function DeployForm({
  strategies,
  assets,
  initialStrategyId,
}: {
  strategies: StrategyOption[];
  assets: AssetOption[];
  initialStrategyId?: number;
}) {
  const router = useRouter();
  const [strategyId, setStrategyId] = useState<number>(initialStrategyId ?? strategies[0]?.id ?? 0);
  const [assetId, setAssetId] = useState<number>(assets[0]?.id ?? 0);
  const [leverage, setLeverage] = useState(1);
  const [sizingMode, setSizingMode] = useState<"pct_equity" | "fixed_usd">("pct_equity");
  const [sizingValue, setSizingValue] = useState(10);
  const [maxDrawdownPct, setMaxDrawdownPct] = useState<string>("");
  const [dailyLossLimitUsd, setDailyLossLimitUsd] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = strategies.find((s) => s.id === strategyId);
  const intradayNeeded = selected !== undefined && selected.interval !== "1d";
  const eligibleAssets = intradayNeeded ? assets.filter((a) => a.intraday) : assets;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategyId,
        assetId,
        leverage,
        sizingMode,
        sizingValue,
        ...(maxDrawdownPct !== "" ? { maxDrawdownPct: Number(maxDrawdownPct) } : {}),
        ...(dailyLossLimitUsd !== "" ? { dailyLossLimitUsd: Number(dailyLossLimitUsd) } : {}),
      }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as
      | { deployment?: { id: number }; error?: string }
      | null;
    if (!res.ok || !body?.deployment) {
      setError(body?.error ?? "failed to create deployment");
      return;
    }
    router.push(`/deployments/${body.deployment.id}`);
    router.refresh();
  };

  const field = "flex flex-col gap-1 text-sm";
  const input = "rounded-md border bg-background px-2 py-1.5 text-sm";

  return (
    <form onSubmit={(e) => void submit(e)} className="flex max-w-md flex-col gap-4">
      <label className={field}>
        Strategy
        <select
          className={input}
          value={strategyId}
          onChange={(e) => setStrategyId(Number(e.target.value))}
        >
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.interval})
            </option>
          ))}
        </select>
      </label>

      <label className={field}>
        Asset
        <select className={input} value={assetId} onChange={(e) => setAssetId(Number(e.target.value))}>
          {eligibleAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.symbol} — {a.name}
            </option>
          ))}
        </select>
        {intradayNeeded && (
          <span className="text-xs text-muted-foreground">
            Intraday strategy — only assets with an intraday candle source are listed.
          </span>
        )}
      </label>

      <label className={field}>
        Leverage: {leverage}x
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
        />
      </label>

      <div className="flex gap-3">
        <label className={`${field} flex-1`}>
          Sizing
          <select
            className={input}
            value={sizingMode}
            onChange={(e) => setSizingMode(e.target.value as "pct_equity" | "fixed_usd")}
          >
            <option value="pct_equity">% of equity</option>
            <option value="fixed_usd">Fixed USD</option>
          </select>
        </label>
        <label className={`${field} flex-1`}>
          {sizingMode === "pct_equity" ? "Percent per trade" : "USD per trade"}
          <input
            className={input}
            type="number"
            min={sizingMode === "pct_equity" ? 1 : 10}
            max={sizingMode === "pct_equity" ? 100 : undefined}
            step={sizingMode === "pct_equity" ? 1 : 10}
            value={sizingValue}
            onChange={(e) => setSizingValue(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="flex gap-3">
        <label className={`${field} flex-1`}>
          Max drawdown % <span className="text-xs text-muted-foreground">(optional kill switch)</span>
          <input
            className={input}
            type="number"
            min={1}
            max={100}
            placeholder="off"
            value={maxDrawdownPct}
            onChange={(e) => setMaxDrawdownPct(e.target.value)}
          />
        </label>
        <label className={`${field} flex-1`}>
          Daily loss limit $ <span className="text-xs text-muted-foreground">(optional)</span>
          <input
            className={input}
            type="number"
            min={1}
            placeholder="off"
            value={dailyLossLimitUsd}
            onChange={(e) => setDailyLossLimitUsd(e.target.value)}
          />
        </label>
      </div>

      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Deployments start in <strong>paper mode</strong>: the bot evaluates every closed candle and
        simulates fills with a $10,000 account, but places no real orders. Live trading arrives in a
        later release.
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={busy || strategies.length === 0}
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create paper deployment"}
      </button>
    </form>
  );
}
