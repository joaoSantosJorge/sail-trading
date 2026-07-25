/**
 * Homoglyph handling for token symbols. Scam airdrops impersonate real
 * tokens by spelling their symbol with look-alike Unicode characters
 * (e.g. "UЅDС" with Cyrillic Ѕ/С for USDC). There is no authoritative
 * "correct" symbol to fetch — the honest fix is to fold the look-alikes to
 * their Latin shapes for display and flag the token as suspicious.
 *
 * Pure and client-safe — no server imports.
 */

// Common Cyrillic/Greek look-alikes → the Latin letter they imitate.
// Not exhaustive Unicode confusables — targeted at ticker-symbol alphabets.
const CONFUSABLES: Record<string, string> = {
  // Cyrillic uppercase
  А: "A", В: "B", Е: "E", Ѕ: "S", І: "I", Ј: "J", К: "K", М: "M", Н: "H",
  О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", Ѡ: "W", Ԁ: "D", Ғ: "F",
  // Cyrillic lowercase
  а: "a", в: "b", е: "e", ѕ: "s", і: "i", ј: "j", к: "k", м: "m", н: "h",
  о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ԁ: "d",
  // Greek uppercase
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N",
  Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  // Greek lowercase
  ο: "o", ν: "v", ρ: "p", τ: "t", υ: "u", κ: "k",
};

// "→" (U+2192) is allowed: the app's own trade rows label swaps "ETH→USDC".
const NON_ASCII = /[^\x20-\x7e→]/;

export type FoldedSymbol = {
  /** Display form: NFKC-normalized with look-alikes mapped to Latin. */
  folded: string;
  /** True when the original symbol contains any non-ASCII character. */
  suspicious: boolean;
};

export function foldSymbol(symbol: string): FoldedSymbol {
  // NFKC resolves fullwidth/compatibility forms (ＵＳＤＣ → USDC) first.
  const normalized = symbol.normalize("NFKC");
  const folded = [...normalized].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  return { folded, suspicious: NON_ASCII.test(symbol) };
}

/** Tooltip text naming the offending characters with their code points. */
export function describeSuspicious(symbol: string): string {
  const offenders = [...new Set([...symbol].filter((ch) => NON_ASCII.test(ch)))]
    .map((ch) => `"${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`)
    .join(", ");
  return `Symbol uses look-alike characters: ${offenders}. This is not the verified token — likely a scam airdrop. Do not swap or approve it.`;
}
