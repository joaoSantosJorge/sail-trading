import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { listSavedCharts } from "@/server/charts/savedCharts";
import { DeleteSavedChartButton } from "./delete-saved-chart-button";

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** My Charts tab: the user's saved layouts, deep-linking into the asset chart. */
export async function MyChartsList({ userId }: { userId: string }) {
  const charts = await listSavedCharts(db, userId);

  if (charts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No saved charts yet. Open an asset from the Tokens tab, draw on the chart, and hit{" "}
        <span className="font-medium text-foreground">Save chart</span> — it will show up here.
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {charts.map((c) => (
        <Card key={c.id} size="sm">
          <CardHeader>
            <CardTitle className="flex items-start justify-between gap-2 text-sm">
              <Link
                href={`/assets/${c.assetId}?chart=${c.id}`}
                className="hover:underline"
              >
                {c.name}
              </Link>
              <DeleteSavedChartButton chartId={c.id} name={c.name} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{c.symbol}</span> · {c.interval}
            </span>
            <span>
              {c.drawingCount} drawing{c.drawingCount === 1 ? "" : "s"} · {c.indicatorCount}{" "}
              indicator{c.indicatorCount === 1 ? "" : "s"}
            </span>
            <span>updated {timeAgo(c.updatedAt)}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
