import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/server/db";
import { getMacroSeries, type MacroSeriesResult } from "@/server/macro/macroCache";
import { MACRO_SERIES } from "@/server/macro/registry";
import { MacroChart } from "./macro-chart";

/** Cap points sent to the client — daily series carry ~6k rows since 2000. */
const MAX_POINTS = 1000;

function downsample<T>(points: T[]): T[] {
  if (points.length <= MAX_POINTS) return points;
  const step = Math.ceil(points.length / MAX_POINTS);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function latestLabel(r: MacroSeriesResult): string {
  const last = r.observations[r.observations.length - 1];
  const value =
    r.def.unit === "%"
      ? `${last.value.toFixed(2)}%`
      : last.value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${value}`;
}

/**
 * Macro tab: one card per series with the latest print and a themed area
 * chart. Series that have no data (both upstreams unreachable, or FRED-only
 * without a key) are listed in a footnote instead of rendering empty cards.
 */
export async function MacroGrid() {
  const results = await Promise.all(
    MACRO_SERIES.map((def) => getMacroSeries(db, def.slug).catch(() => null)),
  );
  const loaded = results.filter((r): r is MacroSeriesResult => !!r && r.observations.length > 0);
  const missing = MACRO_SERIES.filter(
    (def) => !loaded.some((r) => r.def.slug === def.slug),
  );

  if (loaded.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No macro data available. Add <code>FRED_API_KEY</code> to <code>.env.local</code> (free key
        at fred.stlouisfed.org) — the keyless DBnomics fallback appears to be unreachable.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 @[64rem]/content:grid-cols-3">
        {loaded.map((r) => {
          const last = r.observations[r.observations.length - 1];
          return (
            <Card key={r.def.slug} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  {r.def.name}
                  {r.stale && <Badge variant="outline">stale</Badge>}
                </CardTitle>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xl font-semibold tabular-nums">
                    {latestLabel(r)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.def.unit !== "%" ? `${r.def.unit} · ` : ""}
                    {last.date} · {r.source}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <MacroChart data={downsample(r.observations)} unit={r.def.unit} />
              </CardContent>
            </Card>
          );
        })}
      </div>
      {missing.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Unavailable without <code>FRED_API_KEY</code> or upstream data:{" "}
          {missing.map((d) => d.name).join(", ")}.
        </p>
      )}
    </div>
  );
}
