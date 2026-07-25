/**
 * Cents per million tokens, per model — used to record a real cost on every
 * persisted assistant message. Standard (non-introductory) rates.
 */
const MODEL_PRICING_CENTS_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "claude-sonnet-5": { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 },
  "claude-haiku-4-5": { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
  "claude-opus-4-8": { input: 500, output: 2500, cacheRead: 50, cacheWrite: 625 },
};

export const KNOWN_CHAT_MODELS = Object.keys(MODEL_PRICING_CENTS_PER_MTOK);

function ratesFor(model: string) {
  if (MODEL_PRICING_CENTS_PER_MTOK[model]) return MODEL_PRICING_CENTS_PER_MTOK[model];
  // Date-suffixed variants match by prefix.
  const prefix = Object.keys(MODEL_PRICING_CENTS_PER_MTOK).find((k) => model.startsWith(k));
  return prefix ? MODEL_PRICING_CENTS_PER_MTOK[prefix] : null;
}

export function computeCostCents(
  model: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  const rates = ratesFor(model);
  if (!rates) return 0;
  const cost =
    ((usage.inputTokens ?? 0) * rates.input +
      (usage.outputTokens ?? 0) * rates.output +
      (usage.cacheReadTokens ?? 0) * rates.cacheRead +
      (usage.cacheWriteTokens ?? 0) * rates.cacheWrite) /
    1_000_000;
  return Math.round(cost);
}
