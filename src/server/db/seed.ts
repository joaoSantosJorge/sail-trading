import { config } from "dotenv";
config({ path: ".env.local" });

// Seed the asset registry with ~20 majors and a dev user for local login.
// chainId/address/decimals stay null until Phase C. hyperliquidSymbol is the
// perp coin name on Hyperliquid (Binance still wins as candle source when both
// are set); PEPE is deliberately unmapped — Hyperliquid lists it as kPEPE
// (1000×), whose prices don't match. HYPE is the flagship Hyperliquid-only asset.
const SEED_ASSETS: {
  coingeckoId: string;
  symbol: string;
  name: string;
  binanceSymbol: string | null;
  hyperliquidSymbol: string | null;
}[] = [
  { coingeckoId: "bitcoin", symbol: "BTC", name: "Bitcoin", binanceSymbol: "BTCUSDT", hyperliquidSymbol: "BTC" },
  { coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum", binanceSymbol: "ETHUSDT", hyperliquidSymbol: "ETH" },
  { coingeckoId: "solana", symbol: "SOL", name: "Solana", binanceSymbol: "SOLUSDT", hyperliquidSymbol: "SOL" },
  { coingeckoId: "binancecoin", symbol: "BNB", name: "BNB", binanceSymbol: "BNBUSDT", hyperliquidSymbol: "BNB" },
  { coingeckoId: "ripple", symbol: "XRP", name: "XRP", binanceSymbol: "XRPUSDT", hyperliquidSymbol: "XRP" },
  { coingeckoId: "cardano", symbol: "ADA", name: "Cardano", binanceSymbol: "ADAUSDT", hyperliquidSymbol: "ADA" },
  { coingeckoId: "dogecoin", symbol: "DOGE", name: "Dogecoin", binanceSymbol: "DOGEUSDT", hyperliquidSymbol: "DOGE" },
  { coingeckoId: "avalanche-2", symbol: "AVAX", name: "Avalanche", binanceSymbol: "AVAXUSDT", hyperliquidSymbol: "AVAX" },
  { coingeckoId: "chainlink", symbol: "LINK", name: "Chainlink", binanceSymbol: "LINKUSDT", hyperliquidSymbol: "LINK" },
  { coingeckoId: "polkadot", symbol: "DOT", name: "Polkadot", binanceSymbol: "DOTUSDT", hyperliquidSymbol: "DOT" },
  { coingeckoId: "polygon-ecosystem-token", symbol: "POL", name: "Polygon", binanceSymbol: "POLUSDT", hyperliquidSymbol: null },
  { coingeckoId: "uniswap", symbol: "UNI", name: "Uniswap", binanceSymbol: "UNIUSDT", hyperliquidSymbol: "UNI" },
  { coingeckoId: "aave", symbol: "AAVE", name: "Aave", binanceSymbol: "AAVEUSDT", hyperliquidSymbol: "AAVE" },
  { coingeckoId: "arbitrum", symbol: "ARB", name: "Arbitrum", binanceSymbol: "ARBUSDT", hyperliquidSymbol: "ARB" },
  { coingeckoId: "optimism", symbol: "OP", name: "Optimism", binanceSymbol: "OPUSDT", hyperliquidSymbol: "OP" },
  { coingeckoId: "litecoin", symbol: "LTC", name: "Litecoin", binanceSymbol: "LTCUSDT", hyperliquidSymbol: "LTC" },
  { coingeckoId: "cosmos", symbol: "ATOM", name: "Cosmos Hub", binanceSymbol: "ATOMUSDT", hyperliquidSymbol: "ATOM" },
  { coingeckoId: "near", symbol: "NEAR", name: "NEAR Protocol", binanceSymbol: "NEARUSDT", hyperliquidSymbol: "NEAR" },
  { coingeckoId: "injective-protocol", symbol: "INJ", name: "Injective", binanceSymbol: "INJUSDT", hyperliquidSymbol: "INJ" },
  { coingeckoId: "pepe", symbol: "PEPE", name: "Pepe", binanceSymbol: "PEPEUSDT", hyperliquidSymbol: null },
  { coingeckoId: "hyperliquid", symbol: "HYPE", name: "Hyperliquid", binanceSymbol: null, hyperliquidSymbol: "HYPE" },
];

async function main() {
  const { db } = await import("./index");
  const { assets, users } = await import("./schema");
  const { hash } = await import("bcryptjs");
  const { sql } = await import("drizzle-orm");

  // Upsert so re-seeding backfills newly added source mappings on existing rows.
  await db
    .insert(assets)
    .values(SEED_ASSETS)
    .onConflictDoUpdate({
      target: assets.coingeckoId,
      set: { hyperliquidSymbol: sql`excluded.hyperliquid_symbol` },
    });

  const devEmail = process.env.SEED_USER_EMAIL ?? "dev@local.test";
  const devPassword = process.env.SEED_USER_PASSWORD ?? "password123";
  await db
    .insert(users)
    .values({ email: devEmail, name: "Dev User", hashedPassword: await hash(devPassword, 12) })
    .onConflictDoNothing();

  const rows = await db.select().from(assets);
  console.log(`Seeded. ${rows.length} assets; dev user ${devEmail} / ${devPassword}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
