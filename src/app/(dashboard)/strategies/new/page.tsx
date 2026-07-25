"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const EXAMPLE_DSL = {
  version: 1,
  name: "RSI Dip in Uptrend",
  description:
    "Buys oversold dips (RSI<30) only while price is above the 200-bar SMA; exits on RSI recovery above 55, with an 8% stop loss.",
  interval: "1d",
  indicators: [
    { id: "rsi14", type: "rsi", params: { period: 14 } },
    { id: "sma200", type: "sma", params: { period: 200 } },
  ],
  entry: {
    op: "and",
    conditions: [
      { op: "lt", left: { kind: "indicator", id: "rsi14" }, right: { kind: "const", value: 30 } },
      { op: "gt", left: { kind: "price", field: "close" }, right: { kind: "indicator", id: "sma200" } },
    ],
  },
  exit: {
    op: "crosses_above",
    left: { kind: "indicator", id: "rsi14" },
    right: { kind: "const", value: 55 },
  },
  risk: { positionSizePct: 100, stopLossPct: 8, cooldownBars: 1 },
};

const PLACEHOLDER =
  "e.g. Buy when the 20-day moving average crosses above the 50-day. Sell on the cross back below, or if I'm down more than 10%.";

export default function NewStrategyPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [jsonText, setJsonText] = useState(JSON.stringify(EXAMPLE_DSL, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/strategies/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(`/strategies/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function createManual() {
    setBusy(true);
    setError(null);
    try {
      const dsl = JSON.parse(jsonText);
      const res = await fetch("/api/v1/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dsl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(`/strategies/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <div>
        <Link href="/strategies" className="text-sm text-gray-500 hover:underline">
          ← strategies
        </Link>
        <h1 className="text-2xl font-semibold">New strategy</h1>
      </div>

      <section className="flex flex-col gap-3">
        <p className="text-sm text-gray-500">
          Describe your strategy in plain English. The AI turns it into precise, backtestable rules
          — you&apos;ll see exactly how it was interpreted before running anything.
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={PLACEHOLDER}
          className="h-28 w-full rounded border border-black/[.1] bg-transparent p-3 text-sm dark:border-white/[.15]"
        />
        <button
          onClick={generate}
          disabled={busy || prompt.trim().length < 10}
          className="self-start rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate strategy"}
        </button>
      </section>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <details className="text-sm">
        <summary className="cursor-pointer text-gray-500">
          Advanced: write the DSL JSON by hand
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            className="h-[420px] w-full rounded border border-black/[.1] bg-transparent p-3 font-mono text-xs dark:border-white/[.15]"
          />
          <button
            onClick={createManual}
            disabled={busy}
            className="self-start rounded border border-black/[.15] px-4 py-2 text-sm disabled:opacity-50 dark:border-white/[.2]"
          >
            {busy ? "Creating…" : "Create from JSON"}
          </button>
        </div>
      </details>
    </main>
  );
}
