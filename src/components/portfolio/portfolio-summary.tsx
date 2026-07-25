import { Card, CardContent } from "@/components/ui/card";
import { formatBtc, formatUsd, usdToBtc } from "@/lib/portfolio/value";

/** Huge totals compact to "$4.48B" so they never clip the tile; full value in the title attr. */
function displayUsd(v: number): string {
  if (Math.abs(v) < 1e8) return formatUsd(v);
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

/**
 * Aggregate stat tiles across every saved wallet. Server-safe presentational
 * component — the page computes the numbers from the latest snapshots.
 */
export function PortfolioSummary({
  totalUsd,
  btcUsd,
  walletCount,
  assetCount,
}: {
  totalUsd: number;
  btcUsd: number | null;
  walletCount: number;
  assetCount: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card size="sm" className="sm:col-span-1">
        <CardContent className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Total value
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums" title={formatUsd(totalUsd)}>
            {displayUsd(totalUsd)}
          </span>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {formatBtc(usdToBtc(totalUsd, btcUsd))}
          </span>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Wallets tracked
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums">{walletCount}</span>
          <span className="text-sm text-muted-foreground">across 5 EVM chains</span>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Assets held
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums">{assetCount}</span>
          <span className="text-sm text-muted-foreground">from the latest synced snapshots</span>
        </CardContent>
      </Card>
    </div>
  );
}
