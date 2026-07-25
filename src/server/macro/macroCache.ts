import { asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { macroObservations, macroSync } from "../db/schema";
import { fetchDbnomicsObservations } from "./dbnomics";
import { fetchFredObservations, fredConfigured, type MacroObservation } from "./fred";
import { getMacroSeriesDef, type DbnomicsRef, type MacroSeriesDef } from "./registry";

/**
 * Fetch-through macro cache, mirroring the news-cache pattern: a TTL
 * watermark per series; within TTL every request is served from the DB, past
 * it one upstream refresh runs. Refresh is a full refetch + upsert because
 * upstream values get revised (CPI, M2). FRED is used when configured, else
 * DBnomics; each falls through to the other on failure. Raw values are
 * stored; transforms (yoyPct) run at read time.
 */

export type MacroDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const TTL_MS = 6 * 60 * 60 * 1000;

export type MacroDeps = {
  fetchFred: (seriesId: string) => Promise<MacroObservation[]>;
  fetchDbnomics: (ref: DbnomicsRef) => Promise<MacroObservation[]>;
  fredConfigured: () => boolean;
  now: () => number;
};

const defaultDeps: MacroDeps = {
  fetchFred: fetchFredObservations,
  fetchDbnomics: fetchDbnomicsObservations,
  fredConfigured,
  now: Date.now,
};

export type MacroSeriesResult = {
  def: MacroSeriesDef;
  observations: MacroObservation[];
  stale: boolean;
  source: string | null; // "fred" | "dbnomics" | null (never fetched)
};

async function upsertObservations(
  db: MacroDb,
  slug: string,
  obs: MacroObservation[],
): Promise<void> {
  // Chunked multi-row upserts — a full daily series since 2000 is ~6k rows.
  const CHUNK = 1000;
  for (let i = 0; i < obs.length; i += CHUNK) {
    const values = obs.slice(i, i + CHUNK).map((o) => ({ slug, date: o.date, value: o.value }));
    await db
      .insert(macroObservations)
      .values(values)
      .onConflictDoUpdate({
        target: [macroObservations.slug, macroObservations.date],
        set: { value: sql`excluded.value` },
      });
  }
}

async function refresh(
  db: MacroDb,
  def: MacroSeriesDef,
  deps: MacroDeps,
): Promise<string | null> {
  const attempts: { source: string; run: () => Promise<MacroObservation[]> }[] = [];
  if (deps.fredConfigured()) {
    attempts.push({ source: "fred", run: () => deps.fetchFred(def.fred.seriesId) });
  }
  if (def.dbnomics) {
    const ref = def.dbnomics;
    attempts.push({ source: "dbnomics", run: () => deps.fetchDbnomics(ref) });
  }
  for (const attempt of attempts) {
    try {
      const obs = await attempt.run();
      if (obs.length === 0) continue; // unconfigured or empty — try the other
      await upsertObservations(db, def.slug, obs);
      await db
        .insert(macroSync)
        .values({ slug: def.slug, fetchedAt: new Date(deps.now()), source: attempt.source })
        .onConflictDoUpdate({
          target: macroSync.slug,
          set: { fetchedAt: new Date(deps.now()), source: attempt.source },
        });
      return attempt.source;
    } catch (err) {
      console.error(`[macro] ${def.slug} refresh via ${attempt.source} failed`, err);
    }
  }
  return null;
}

/** yoyPct: percent change vs the same month one year earlier. */
function applyTransform(def: MacroSeriesDef, obs: MacroObservation[]): MacroObservation[] {
  if (def.transform === "none") return obs;
  const byMonth = new Map(obs.map((o) => [o.date.slice(0, 7), o.value]));
  const out: MacroObservation[] = [];
  for (const o of obs) {
    const month = o.date.slice(0, 7);
    const prevYearMonth = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
    const base = byMonth.get(prevYearMonth);
    if (base === undefined || base === 0) continue;
    out.push({ date: o.date, value: 100 * (o.value / base - 1) });
  }
  return out;
}

/**
 * Serve a macro series, refreshing from upstream when its TTL expired.
 * `stale` is true when a refresh was due but every upstream failed (cached
 * rows are still served).
 */
export async function getMacroSeries(
  db: MacroDb,
  slug: string,
  deps: MacroDeps = defaultDeps,
): Promise<MacroSeriesResult | null> {
  const def = getMacroSeriesDef(slug);
  if (!def) return null;

  const [row] = await db.select().from(macroSync).where(eq(macroSync.slug, slug));
  const expired = !row || deps.now() - row.fetchedAt.getTime() > TTL_MS;
  let source = row?.source ?? null;
  let stale = false;
  if (expired) {
    const refreshed = await refresh(db, def, deps);
    if (refreshed) source = refreshed;
    else stale = true;
  }

  const rows = await db
    .select()
    .from(macroObservations)
    .where(eq(macroObservations.slug, slug))
    .orderBy(asc(macroObservations.date));

  return {
    def,
    observations: applyTransform(
      def,
      rows.map((r) => ({ date: r.date, value: r.value })),
    ),
    stale,
    source,
  };
}
