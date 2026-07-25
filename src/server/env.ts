import { z } from "zod";

// NOTE: never import this module from client components. A `server-only`
// guard is deliberately omitted for now because seed scripts and vitest run
// outside the Next.js runtime; revisit once auth/keys grow (M4+).
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Optional in M1: CoinGecko public (keyless) access works at low rate.
  COINGECKO_API_KEY: z.string().optional(),
  // Optional so the app boots without AI features; chat falls back to a
  // canned reply and strategy generation throws a clear error when missing.
  ANTHROPIC_API_KEY: z.string().optional(),
  // NextAuth JWT secret. Optional at parse time so seed scripts/vitest can
  // import this module; NextAuth itself fails loudly without it at runtime.
  AUTH_SECRET: z.string().optional(),
  // Phase B integrations — features degrade gracefully when unset.
  ALCHEMY_API_KEY: z.string().optional(),
  CRYPTOPANIC_API_KEY: z.string().optional(),
  // Phase C — Uniswap Trading API (trade execution).
  UNISWAP_API_KEY: z.string().optional(),
  // Macro data (FRED). Optional — DBnomics keyless fallback covers most series.
  FRED_API_KEY: z.string().optional(),
  // Hyperliquid info API base override (testnet: https://api.hyperliquid-testnet.xyz).
  // The API is keyless; unset means mainnet.
  HYPERLIQUID_API_URL: z.string().optional(),
});

export const env = EnvSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  CRYPTOPANIC_API_KEY: process.env.CRYPTOPANIC_API_KEY,
  UNISWAP_API_KEY: process.env.UNISWAP_API_KEY,
  FRED_API_KEY: process.env.FRED_API_KEY,
  HYPERLIQUID_API_URL: process.env.HYPERLIQUID_API_URL,
});
