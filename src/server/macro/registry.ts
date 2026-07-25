/**
 * Registry of macro-economic series the app can chart. FRED is the primary
 * source (keyed); DBnomics is the keyless fallback using its native providers
 * (BLS for CPI/unemployment, FED for rates/M2 — DBnomics does not mirror FRED
 * as a provider). `dbnomics: null` = FRED-only series (no clean keyless code).
 * DBnomics codes verified live 2026-07-25.
 */

export type MacroTransform = "none" | "yoyPct";

export type DbnomicsRef = { provider: string; dataset: string; series: string };

export type MacroSeriesDef = {
  slug: string;
  name: string;
  unit: string;
  transform: MacroTransform;
  fred: { seriesId: string };
  dbnomics: DbnomicsRef | null;
};

/** Earliest observation fetched/served — keeps payloads chart-sized. */
export const MACRO_START_DATE = "2000-01-01";

export const MACRO_SERIES: MacroSeriesDef[] = [
  {
    slug: "cpi-yoy",
    name: "CPI inflation (YoY)",
    unit: "%",
    transform: "yoyPct",
    fred: { seriesId: "CPIAUCSL" },
    dbnomics: { provider: "BLS", dataset: "cu", series: "CUSR0000SA0" },
  },
  {
    slug: "core-cpi-yoy",
    name: "Core CPI inflation (YoY)",
    unit: "%",
    transform: "yoyPct",
    fred: { seriesId: "CPILFESL" },
    dbnomics: { provider: "BLS", dataset: "cu", series: "CUSR0000SA0L1E" },
  },
  {
    slug: "fed-funds",
    name: "Fed funds rate",
    unit: "%",
    transform: "none",
    fred: { seriesId: "FEDFUNDS" },
    dbnomics: { provider: "FED", dataset: "H15", series: "RIFSPFF_N.M" },
  },
  {
    slug: "treasury-10y",
    name: "10Y treasury yield",
    unit: "%",
    transform: "none",
    fred: { seriesId: "DGS10" },
    dbnomics: { provider: "FED", dataset: "H15", series: "RIFLGFCY10_N.B" },
  },
  {
    slug: "fed-balance-sheet",
    name: "Fed balance sheet (QE proxy)",
    unit: "$M",
    transform: "none",
    fred: { seriesId: "WALCL" },
    dbnomics: null,
  },
  {
    slug: "m2",
    name: "M2 money supply",
    unit: "$B",
    transform: "none",
    fred: { seriesId: "M2SL" },
    dbnomics: { provider: "FED", dataset: "H6_H6_M2", series: "M2.M" },
  },
  {
    slug: "unemployment",
    name: "Unemployment rate",
    unit: "%",
    transform: "none",
    fred: { seriesId: "UNRATE" },
    dbnomics: { provider: "BLS", dataset: "ln", series: "LNS14000000" },
  },
  {
    slug: "dxy",
    name: "US dollar index (broad)",
    unit: "index",
    transform: "none",
    fred: { seriesId: "DTWEXBGS" },
    dbnomics: null,
  },
];

export const MACRO_SLUGS = MACRO_SERIES.map((s) => s.slug);

export function getMacroSeriesDef(slug: string): MacroSeriesDef | null {
  return MACRO_SERIES.find((s) => s.slug === slug) ?? null;
}
