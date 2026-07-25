/**
 * Deterministic identity chip for a token: 1–2 letters of the symbol on a
 * gradient hashed from symbol+address, so a token keeps its colors across
 * renders, wallets, and sessions. Presentational only — no network fetches
 * for logos.
 */

const GRADIENT_STOPS = ["#2171cc", "#e07937", "#8072c2", "#4eb068", "#00a3c9"];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function TokenAvatar({ symbol, seed }: { symbol: string; seed?: string | null }) {
  const h = hash(`${symbol}:${seed ?? ""}`);
  const from = GRADIENT_STOPS[h % GRADIENT_STOPS.length];
  const to = GRADIENT_STOPS[(h + 2) % GRADIENT_STOPS.length];
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white/90"
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}
