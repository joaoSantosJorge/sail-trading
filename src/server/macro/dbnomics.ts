import { TokenBucket } from "../market/rateLimiter";
import { MACRO_START_DATE, type DbnomicsRef } from "./registry";

/**
 * DBnomics observations client — keyless aggregator serving BLS/FED series
 * natively. Fallback source when FRED_API_KEY is not configured (or FRED is
 * down); the 6h cache keeps usage minimal.
 */

const BASE = "https://api.db.nomics.world/v22/series";

// Keyless public API — stay polite: 1 request/second.
const bucket = new TokenBucket(2, 1);

export type MacroObservation = { date: string; value: number };

type DbnomicsDoc = {
  period: string[];
  period_start_day?: string[];
  value: (number | string | null)[];
};

/** Fetch one DBnomics series; "NA"/null observations dropped. */
export async function fetchDbnomicsObservations(ref: DbnomicsRef): Promise<MacroObservation[]> {
  await bucket.take();
  const url = `${BASE}/${ref.provider}/${ref.dataset}/${encodeURIComponent(ref.series)}?observations=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DBnomics ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { series?: { docs?: DbnomicsDoc[] } };
  const doc = data.series?.docs?.[0];
  if (!doc) throw new Error(`DBnomics: series not found ${ref.provider}/${ref.dataset}/${ref.series}`);

  // Monthly periods come as "2026-06"; period_start_day (when present) is the
  // full "YYYY-MM-DD". Normalize everything to a full date.
  const dates = doc.period_start_day ?? doc.period;
  const out: MacroObservation[] = [];
  for (let i = 0; i < dates.length; i++) {
    const raw = doc.value[i];
    const value = typeof raw === "string" ? Number(raw) : raw;
    if (value === null || !Number.isFinite(value)) continue;
    const date = dates[i].length === 7 ? `${dates[i]}-01` : dates[i];
    if (date < MACRO_START_DATE) continue;
    out.push({ date, value: value as number });
  }
  return out;
}
