import { randomUUID } from "node:crypto";

/**
 * Server-side quote store: /swap only accepts a quoteId minted by /quote, so
 * quote payloads can never be tampered with client-side and freshness is
 * enforced server-side. In-memory (single-node deployment); entries expire
 * after QUOTE_TTL_MS.
 */

export const QUOTE_TTL_MS = 30_000;

export type StoredQuote = {
  proposalId: number;
  userId: string;
  chainId: number;
  walletAddress: string;
  quote: Record<string, unknown>;
  permitData: Record<string, unknown> | null;
  quotedAt: number;
};

const store = (globalThis as { __sailQuotes?: Map<string, StoredQuote> }).__sailQuotes ?? new Map();
(globalThis as { __sailQuotes?: Map<string, StoredQuote> }).__sailQuotes = store;

export function saveQuote(entry: Omit<StoredQuote, "quotedAt">): string {
  // Opportunistic cleanup of expired entries.
  const now = Date.now();
  for (const [key, value] of store) {
    if (now - value.quotedAt > QUOTE_TTL_MS * 4) store.delete(key);
  }
  const id = randomUUID();
  store.set(id, { ...entry, quotedAt: now });
  return id;
}

export function takeQuote(id: string, userId: string): StoredQuote | "expired" | null {
  const entry = store.get(id);
  if (!entry || entry.userId !== userId) return null;
  if (Date.now() - entry.quotedAt > QUOTE_TTL_MS) {
    store.delete(id);
    return "expired";
  }
  store.delete(id); // single use
  return entry;
}
