import { env } from "../env";
import { TokenBucket } from "../market/rateLimiter";

/**
 * CryptoPanic developer API client. Free tier; exact quota is undocumented —
 * the fetch-through cache (newsCache.ts) keeps usage to a few calls per TTL
 * window regardless.
 */

const BASE = "https://cryptopanic.com/api/developer/v2";

// Conservative: 4 requests/minute upstream.
const bucket = new TokenBucket(4, 4 / 60);

export type CryptoPanicPost = {
  id: number | string;
  title: string;
  url?: string;
  kind?: string;
  source?: { title?: string; domain?: string };
  domain?: string;
  published_at: string;
  currencies?: { code: string }[];
  panic_score?: number;
};

export function newsConfigured(): boolean {
  return Boolean(env.CRYPTOPANIC_API_KEY);
}

/** Fetch latest posts, optionally filtered to currency codes (e.g. ["ETH"]). */
export async function fetchPosts(currencies?: string[]): Promise<CryptoPanicPost[]> {
  if (!env.CRYPTOPANIC_API_KEY) return [];
  await bucket.take();
  const params = new URLSearchParams({ auth_token: env.CRYPTOPANIC_API_KEY, public: "true" });
  if (currencies?.length) params.set("currencies", currencies.join(","));
  const res = await fetch(`${BASE}/posts/?${params}`);
  if (!res.ok) {
    throw new Error(`CryptoPanic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: CryptoPanicPost[] };
  return data.results ?? [];
}
