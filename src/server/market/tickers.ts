import { fetchBinance24hTickers, type Binance24hTicker } from "./binance";

/**
 * Memoized 24h tickers keyed by Binance symbol (module-level, ~5 min TTL) so
 * page renders and router.refresh() churn stay off the Binance budget —
 * mirrors spot.ts. Serves stale on upstream failure; returns an empty map
 * when there is no cache to fall back to (callers degrade to "—").
 */

const TTL_MS = 5 * 60 * 1000;
let memo: { at: number; bySymbol: Map<string, Binance24hTicker> } | null = null;

export async function getTickers24h(symbols: string[]): Promise<Map<string, Binance24hTicker>> {
  if (symbols.length === 0) return new Map();
  const missing = memo ? symbols.some((s) => !memo!.bySymbol.has(s)) : true;
  if (memo && !missing && Date.now() - memo.at < TTL_MS) return memo.bySymbol;
  try {
    const tickers = await fetchBinance24hTickers(symbols);
    memo = { at: Date.now(), bySymbol: new Map(tickers.map((t) => [t.symbol, t])) };
    return memo.bySymbol;
  } catch (err) {
    console.error("[tickers] Binance 24hr fetch failed; serving stale", err);
    return memo?.bySymbol ?? new Map();
  }
}
