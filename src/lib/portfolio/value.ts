/**
 * Pure, client-safe value helpers (no server imports). BTC values are always
 * DERIVED at read time from USD (valueUsd / btcUsd) — never stored, since
 * BTC/USD moves.
 */

export function usdToBtc(valueUsd: number | null, btcUsd: number | null): number | null {
  if (valueUsd === null || btcUsd === null || !Number.isFinite(btcUsd) || btcUsd <= 0) {
    return null;
  }
  return valueUsd / btcUsd;
}

export function formatUsd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Satoshi-aware precision: ≥1 BTC → 4 dp, below → 8 dp (full sats). */
export function formatBtc(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const dp = Math.abs(v) >= 1 ? 4 : 8;
  return `₿${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp })}`;
}
