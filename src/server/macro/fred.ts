import { env } from "../env";
import { TokenBucket } from "../market/rateLimiter";
import { MACRO_START_DATE } from "./registry";

/**
 * FRED (Federal Reserve Economic Data) observations client. Free key,
 * 120 req/min official limit — the 6h fetch-through cache (macroCache.ts)
 * keeps real usage to a handful of calls per window.
 */

const BASE = "https://api.stlouisfed.org/fred/series/observations";

// Conservative: 2 requests/second burst 2.
const bucket = new TokenBucket(2, 2);

export type MacroObservation = { date: string; value: number };

export function fredConfigured(): boolean {
  return Boolean(env.FRED_API_KEY);
}

/** Fetch a FRED series since MACRO_START_DATE; missing values (".") dropped. */
export async function fetchFredObservations(seriesId: string): Promise<MacroObservation[]> {
  if (!env.FRED_API_KEY) return [];
  await bucket.take();
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: env.FRED_API_KEY,
    file_type: "json",
    observation_start: MACRO_START_DATE,
  });
  const res = await fetch(`${BASE}?${params}`);
  if (!res.ok) {
    throw new Error(`FRED ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { observations?: { date: string; value: string }[] };
  return (data.observations ?? [])
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value));
}
