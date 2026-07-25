"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type AssetOption = { id: number; symbol: string; name: string };

export function BacktestLauncher({
  strategyId,
  assets,
}: {
  strategyId: number;
  assets: AssetOption[];
}) {
  const router = useRouter();
  const [assetId, setAssetId] = useState(assets[0]?.id ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/backtests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyId, assetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(`/backtests/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-black/[.1] p-4 dark:border-white/[.15]">
      <h2 className="font-medium">Run backtest</h2>
      <div className="flex items-center gap-3">
        <select
          value={assetId}
          onChange={(e) => setAssetId(Number(e.target.value))}
          className="rounded border border-black/[.1] bg-transparent px-2 py-1.5 text-sm dark:border-white/[.15] dark:bg-black"
        >
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.symbol} — {a.name}
            </option>
          ))}
        </select>
        <button
          onClick={run}
          disabled={busy}
          className="rounded bg-foreground px-4 py-1.5 text-sm text-background disabled:opacity-50"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Uses the strategy&apos;s interval, ~2000 bars of history, 0.30% fee + 0.10% slippage + $1 gas
        per side, $10,000 starting equity.
      </p>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
