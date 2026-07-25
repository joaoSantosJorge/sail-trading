import { config } from "dotenv";
config({ path: ".env.local" });

// Seed the asset registry with ~20 majors (all with Binance USDT pairs) and a
// dev user for local login. chainId/address/decimals stay null until Phase C.
const SEED_ASSETS: { coingeckoId: string; symbol: string; name: string; binanceSymbol: string }[] = [
  { coingeckoId: "bitcoin", symbol: "BTC", name: "Bitcoin", binanceSymbol: "BTCUSDT" },
  { coingeckoId: "ethereum", symbol: "ETH", name: "Ethereum", binanceSymbol: "ETHUSDT" },
  { coingeckoId: "solana", symbol: "SOL", name: "Solana", binanceSymbol: "SOLUSDT" },
  { coingeckoId: "binancecoin", symbol: "BNB", name: "BNB", binanceSymbol: "BNBUSDT" },
  { coingeckoId: "ripple", symbol: "XRP", name: "XRP", binanceSymbol: "XRPUSDT" },
  { coingeckoId: "cardano", symbol: "ADA", name: "Cardano", binanceSymbol: "ADAUSDT" },
  { coingeckoId: "dogecoin", symbol: "DOGE", name: "Dogecoin", binanceSymbol: "DOGEUSDT" },
  { coingeckoId: "avalanche-2", symbol: "AVAX", name: "Avalanche", binanceSymbol: "AVAXUSDT" },
  { coingeckoId: "chainlink", symbol: "LINK", name: "Chainlink", binanceSymbol: "LINKUSDT" },
  { coingeckoId: "polkadot", symbol: "DOT", name: "Polkadot", binanceSymbol: "DOTUSDT" },
  { coingeckoId: "polygon-ecosystem-token", symbol: "POL", name: "Polygon", binanceSymbol: "POLUSDT" },
  { coingeckoId: "uniswap", symbol: "UNI", name: "Uniswap", binanceSymbol: "UNIUSDT" },
  { coingeckoId: "aave", symbol: "AAVE", name: "Aave", binanceSymbol: "AAVEUSDT" },
  { coingeckoId: "arbitrum", symbol: "ARB", name: "Arbitrum", binanceSymbol: "ARBUSDT" },
  { coingeckoId: "optimism", symbol: "OP", name: "Optimism", binanceSymbol: "OPUSDT" },
  { coingeckoId: "litecoin", symbol: "LTC", name: "Litecoin", binanceSymbol: "LTCUSDT" },
  { coingeckoId: "cosmos", symbol: "ATOM", name: "Cosmos Hub", binanceSymbol: "ATOMUSDT" },
  { coingeckoId: "near", symbol: "NEAR", name: "NEAR Protocol", binanceSymbol: "NEARUSDT" },
  { coingeckoId: "injective-protocol", symbol: "INJ", name: "Injective", binanceSymbol: "INJUSDT" },
  { coingeckoId: "pepe", symbol: "PEPE", name: "Pepe", binanceSymbol: "PEPEUSDT" },
];

async function main() {
  const { db } = await import("./index");
  const { assets, users } = await import("./schema");
  const { hash } = await import("bcryptjs");

  await db.insert(assets).values(SEED_ASSETS).onConflictDoNothing();

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
