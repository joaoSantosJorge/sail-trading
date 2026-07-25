/**
 * Hyperliquid wire-format rules for perp order prices and sizes. Pure and
 * client-safe — used by the server (quote building, clamping) and the browser
 * (the signed action must match the quote byte-for-byte).
 *
 * Venue rules: size is rounded to the coin's szDecimals; price allows at most
 * 5 significant figures AND at most (6 - szDecimals) decimal places for
 * perps — integer prices are always allowed. Wire strings must not carry
 * trailing zeros.
 */

function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Round a size to szDecimals and format for the wire. */
export function formatSz(size: number, szDecimals: number): string {
  return trimZeros(size.toFixed(szDecimals));
}

/** Round a price to the venue's tick rules and format for the wire. */
export function formatPx(px: number, szDecimals: number): string {
  if (!Number.isFinite(px) || px <= 0) throw new Error(`invalid price ${px}`);
  if (Number.isInteger(px) && px < 1e15) return px.toFixed(0);
  const maxDecimals = Math.max(0, 6 - szDecimals);
  // 5 significant figures first, then the decimal-place cap.
  const sig = Number(px.toPrecision(5));
  const capped = sig.toFixed(maxDecimals);
  return trimZeros(capped);
}

/** Numeric value the wire string represents (for cap math after rounding). */
export function roundedSz(size: number, szDecimals: number): number {
  return Number(formatSz(size, szDecimals));
}

export function roundedPx(px: number, szDecimals: number): number {
  return Number(formatPx(px, szDecimals));
}
