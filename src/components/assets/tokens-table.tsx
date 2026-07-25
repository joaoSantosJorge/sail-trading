import Link from "next/link";
import { db } from "@/server/db";
import { assets } from "@/server/db/schema";
import { assetSnapshot, type AssetSnapshot } from "@/server/market/snapshot";
import { getTickers24h } from "@/server/market/tickers";

const usd = (v: number) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: v < 1 ? 6 : 2,
  });

function compactUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const cls =
    value > 0 ? "text-success" : value < 0 ? "text-destructive" : "text-muted-foreground";
  return (
    <span className={cls}>
      {value > 0 ? "+" : ""}
      {value.toFixed(2)}%
    </span>
  );
}

/**
 * Most-traded tokens: the seeded majors ranked by Binance 24h quote volume
 * (CoinGecko-only assets last). Price/24h come from the live ticker when
 * available — fresher than the daily close the 7d/30d columns are based on.
 */
export async function TokensTable() {
  const rows = await db.select().from(assets).orderBy(assets.id);
  const tickers = await getTickers24h(
    rows.filter((a) => a.binanceSymbol).map((a) => a.binanceSymbol!),
  );

  // Sequential on purpose: hits the candle cache; only cold assets fetch upstream.
  const snapshots = new Map<number, AssetSnapshot | null>();
  for (const a of rows) {
    try {
      snapshots.set(a.id, await assetSnapshot(a));
    } catch {
      snapshots.set(a.id, null);
    }
  }

  const volume = (a: (typeof rows)[number]) =>
    a.binanceSymbol ? (tickers.get(a.binanceSymbol)?.quoteVolume ?? -1) : -1;
  const ranked = [...rows].sort((a, b) => volume(b) - volume(a));

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-muted-foreground">
            <th className="px-4 py-2 font-normal">Symbol</th>
            <th className="px-4 py-2 font-normal">Name</th>
            <th className="px-4 py-2 text-right font-normal">Price</th>
            <th className="px-4 py-2 text-right font-normal">24h</th>
            <th className="px-4 py-2 text-right font-normal">7d</th>
            <th className="px-4 py-2 text-right font-normal">30d</th>
            <th className="px-4 py-2 text-right font-normal">24h volume</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((a) => {
            const s = snapshots.get(a.id) ?? null;
            const ticker = a.binanceSymbol ? (tickers.get(a.binanceSymbol) ?? null) : null;
            const price = ticker?.lastPrice ?? s?.lastClose ?? null;
            const change24h = ticker?.priceChangePercent ?? s?.change24hPct ?? null;
            return (
              <tr key={a.id} className="border-b last:border-0 hover:bg-accent/40">
                <td className="px-4 py-2">
                  <Link href={`/assets/${a.id}`} className="font-medium hover:underline">
                    {a.symbol}
                  </Link>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{a.name}</td>
                <td className="px-4 py-2 text-right font-mono tabular-figures">
                  {price !== null ? usd(price) : "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  <Delta value={change24h} />
                </td>
                <td className="px-4 py-2 text-right">
                  <Delta value={s?.change7dPct ?? null} />
                </td>
                <td className="px-4 py-2 text-right">
                  <Delta value={s?.change30dPct ?? null} />
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-figures text-muted-foreground">
                  {ticker ? compactUsd(ticker.quoteVolume) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
