import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { SavedDrawing, SavedIndicator } from "../../lib/chart-state";

// ---------------------------------------------------------------------------
// Auth — singular table names to match DrizzleAdapter defaults.
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  name: varchar("name", { length: 255 }),
  image: text("image"),
  hashedPassword: text("hashed_password"),
  lastLoginAt: timestamp("last_login_at", { mode: "date" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const accounts = pgTable("account", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 255 }).notNull(),
  providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: varchar("token_type", { length: 255 }),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
});

export const sessions = pgTable("session", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionToken: text("sessionToken").notNull().unique(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable("verificationToken", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull().unique(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

// ---------------------------------------------------------------------------
// AI chat — threads / messages / tool-call audit (mirrors the tracking app).
// ---------------------------------------------------------------------------

export const chatMessageRoleEnum = pgEnum("chat_message_role", [
  "system",
  "user",
  "assistant",
  "tool",
]);

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }),
    model: varchar("model", { length: 120 }).notNull().default("claude-sonnet-5"),
    retentionDays: integer("retention_days").notNull().default(365),
    // Rolling 2-3 sentence conversation summary, refreshed after each
    // completed assistant turn. Read by the chat-history tools (Phase B).
    summary: text("summary"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("chat_threads_user_created_idx").on(table.userId, table.createdAt),
    index("chat_threads_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: chatMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    // Full AI SDK UIMessage parts array (text, tool calls with input/output/
    // approval state). `content` stays as the flattened text for retention,
    // search, and titles.
    parts: jsonb("parts"),
    context: jsonb("context"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costCents: integer("cost_cents"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("chat_messages_thread_created_idx").on(table.threadId, table.createdAt),
    index("chat_messages_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const chatToolCalls = pgTable(
  "chat_tool_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolName: varchar("tool_name", { length: 120 }).notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    status: varchar("status", { length: 20 }).notNull().default("completed"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("chat_tool_calls_message_idx").on(table.messageId),
    index("chat_tool_calls_thread_idx").on(table.threadId, table.createdAt),
    index("chat_tool_calls_user_idx").on(table.userId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Market data — global, shared across users (public cache).
// ---------------------------------------------------------------------------

export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  coingeckoId: text("coingecko_id").notNull().unique(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  // On-chain identity, filled in when execution support lands (Phase C).
  chainId: integer("chain_id"),
  address: text("address"),
  decimals: integer("decimals"),
  // USDT spot pair on Binance, e.g. "ETHUSDT". Null => no Binance source.
  binanceSymbol: text("binance_symbol"),
  // Hyperliquid perp coin name, e.g. "HYPE". Null => no Hyperliquid source.
  hyperliquidSymbol: text("hyperliquid_symbol"),
});

// Hourly perp funding rates (Hyperliquid), fetch-through cached like candles.
// `t` = funding timestamp ms; `rate` = hourly rate fraction (+ means longs pay).
export const fundingRates = pgTable(
  "funding_rates",
  {
    coin: text("coin").notNull(), // Hyperliquid perp coin name, e.g. "BTC"
    t: bigint("t", { mode: "number" }).notNull(),
    rate: doublePrecision("rate").notNull(),
  },
  (table) => [primaryKey({ columns: [table.coin, table.t] })],
);

// Contiguous [earliestT, latestT] coverage watermark per coin (mirrors candle_sync).
export const fundingSync = pgTable("funding_sync", {
  coin: text("coin").primaryKey(),
  earliestT: bigint("earliest_t", { mode: "number" }).notNull(),
  latestT: bigint("latest_t", { mode: "number" }).notNull(),
});

// One row per closed candle. `t` is the candle open time in ms since epoch (UTC).
export const candles = pgTable(
  "candles",
  {
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id),
    interval: text("interval").notNull(), // "15m" | "1h" | "4h" | "1d"
    t: bigint("t", { mode: "number" }).notNull(),
    o: doublePrecision("o").notNull(),
    h: doublePrecision("h").notNull(),
    l: doublePrecision("l").notNull(),
    c: doublePrecision("c").notNull(),
    v: doublePrecision("v").notNull(),
    source: text("source").notNull(), // "binance" | "hyperliquid" | "coingecko"
  },
  (table) => [primaryKey({ columns: [table.assetId, table.interval, table.t] })],
);

// Coverage watermarks for the fetch-through cache. Records the *requested*
// span (not just returned candles) so an asset younger than `earliestT`
// doesn't trigger refetches of empty history forever.
export const candleSync = pgTable(
  "candle_sync",
  {
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id),
    interval: text("interval").notNull(),
    earliestT: bigint("earliest_t", { mode: "number" }).notNull(),
    latestT: bigint("latest_t", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.assetId, table.interval] })],
);

// ---------------------------------------------------------------------------
// User-scoped domain tables.
// ---------------------------------------------------------------------------

export const wallets = pgTable(
  "wallets",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    // Chain ecosystem the address belongs to ("evm" today; "solana" |
    // "bitcoin" | "sui" | "hyperliquid" when those adapters land).
    chain: text("chain").notNull().default("evm"),
    label: text("label"),
    chainIds: jsonb("chain_ids").$type<number[]>().notNull().default([]),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.address] })],
);

export const holdingsSnapshots = pgTable("holdings_snapshots", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  wallet: text("wallet").notNull(),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  positions: jsonb("positions").notNull(), // [{ token, chainId, balance, usd }]
  perps: jsonb("perps"), // PerpPosition[] — null for wallets without a perps venue
});

// On-chain transfer history cache — fetch-through like candles/news: only
// blocks past the per-(wallet, network) watermark are fetched on sync.
export const walletTransfers = pgTable(
  "wallet_transfers",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    network: text("network").notNull(), // "eth-mainnet" | ... (adapter-defined)
    chainId: integer("chain_id"), // null for future non-EVM networks
    uniqueId: text("unique_id").notNull(), // provider dedupe key
    txHash: text("tx_hash").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    direction: text("direction").notNull(), // in | out | self
    category: text("category").notNull(), // external | internal | erc20 | ...
    assetSymbol: text("asset_symbol"),
    assetAddress: text("asset_address"),
    amount: text("amount"), // decimal string — no float loss
    valueUsd: doublePrecision("value_usd"), // reserved: historical pricing backfill
    counterparty: text("counterparty"),
    raw: jsonb("raw"),
  },
  (table) => [
    uniqueIndex("wallet_transfers_dedupe_idx").on(table.userId, table.wallet, table.uniqueId),
    index("wallet_transfers_wallet_ts_idx").on(table.userId, table.wallet, table.ts),
  ],
);

// ERC-20 contract → CoinGecko coin id, global like assets (token identity is
// public data). A row with coingecko_id NULL is a negative cache — CoinGecko
// doesn't know the token; retried once resolved_at is >30 days old.
export const contractCoinMap = pgTable(
  "contract_coin_map",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(), // lowercase
    coingeckoId: text("coingecko_id"),
    symbol: text("symbol"),
    name: text("name"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.address] })],
);

// Free-text user tags on history items. tx_key is the transaction-level key
// shared by both history sources: txHash, or "exec:<id>" for a pending
// execution that has no hash yet.
export const historyTags = pgTable(
  "history_tags",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    txKey: text("tx_key").notNull(),
    tag: text("tag").notNull(), // stored as typed; matched case-insensitively
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("history_tags_dedupe_idx").on(table.userId, table.wallet, table.txKey, table.tag),
    index("history_tags_user_wallet_idx").on(table.userId, table.wallet),
  ],
);

// Per-(wallet, network) sync watermark — mirrors candle_sync.
export const walletTransferSync = pgTable(
  "wallet_transfer_sync",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    network: text("network").notNull(),
    latestBlock: text("latest_block").notNull(), // hex block number
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.wallet, table.network] })],
);

// A user's saved chart layout: drawings + indicators for one asset/interval.
export const savedCharts = pgTable(
  "saved_charts",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id),
    name: text("name").notNull(),
    interval: text("interval").notNull(), // ChartInterval
    drawings: jsonb("drawings").$type<SavedDrawing[]>().notNull().default([]),
    indicators: jsonb("indicators").$type<SavedIndicator[]>().notNull().default([]),
    // Reserved for future chart settings (candle type, log scale, …).
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("saved_charts_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const strategies = pgTable(
  "strategies",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: integer("parent_id"),
    name: text("name").notNull(),
    dsl: jsonb("dsl").notNull(),
    source: text("source").notNull(), // "ai" | "manual"
    promptText: text("prompt_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("strategies_user_created_idx").on(table.userId, table.createdAt)],
);

export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    strategyId: integer("strategy_id")
      .notNull()
      .references(() => strategies.id),
    assetId: integer("asset_id")
      .notNull()
      .references(() => assets.id),
    interval: text("interval").notNull(),
    fromT: bigint("from_t", { mode: "number" }).notNull(),
    toT: bigint("to_t", { mode: "number" }).notNull(),
    params: jsonb("params").notNull(), // { feeBps, slippageBps, gasUsd, initialEquity }
    status: text("status").notNull().default("running"), // running | done | failed
    metrics: jsonb("metrics"),
    trades: jsonb("trades"),
    equityCurve: jsonb("equity_curve"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("backtest_runs_user_created_idx").on(table.userId, table.createdAt)],
);

export const researchReports = pgTable("research_reports", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  wallet: text("wallet"),
  title: text("title").notNull().default("Research report"),
  reportMd: text("report_md").notNull(),
  inputs: jsonb("inputs").notNull(), // exact tool-call provenance used
  model: text("model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tradeProposals = pgTable("trade_proposals", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reportId: integer("report_id").references(() => researchReports.id),
  walletAddress: text("wallet_address"),
  kind: text("kind").notNull().default("swap"), // swap | perp
  proposal: jsonb("proposal").notNull(),
  status: text("status").notNull().default("proposed"), // proposed | approved | executed | dismissed | expired
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const executions = pgTable("executions", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  proposalId: integer("proposal_id")
    .notNull()
    .references(() => tradeProposals.id),
  userWallet: text("user_wallet"),
  // Where the execution settles: "evm" broadcasts a tx (chainId + txHash),
  // "hyperliquid" posts a signed order to the venue (externalId = order id).
  venue: text("venue").notNull().default("evm"),
  chainId: integer("chain_id"), // null for non-EVM venues
  txHash: text("tx_hash"),
  externalId: text("external_id"), // venue-side id (Hyperliquid oid)
  quote: jsonb("quote").notNull(),
  status: text("status").notNull().default("pending"), // pending | confirmed | failed
  receipt: jsonb("receipt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Market news cache — global, public data (Phase B).
// ---------------------------------------------------------------------------

export const newsItems = pgTable(
  "news_items",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull().default("cryptopanic"),
    externalId: text("external_id").notNull().unique(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    kind: text("kind"), // news | media
    sourceDomain: text("source_domain"),
    currencies: jsonb("currencies").$type<string[]>().notNull().default([]), // ["BTC","ETH"]
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    panicScore: doublePrecision("panic_score"),
    raw: jsonb("raw"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("news_items_published_idx").on(table.publishedAt)],
);

// TTL watermark per upstream filter (e.g. "all", "currency:ETH").
export const newsSync = pgTable("news_sync", {
  filterKey: text("filter_key").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Macro-economic series cache — global, public data.
// ---------------------------------------------------------------------------

// Raw upstream values; transforms (e.g. CPI YoY) are applied at read time so
// upstream revisions only require an upsert, never a recompute of stored rows.
export const macroObservations = pgTable(
  "macro_observations",
  {
    slug: text("slug").notNull(), // registry slug, e.g. "cpi-yoy"
    date: text("date").notNull(), // "YYYY-MM-DD" period start
    value: doublePrecision("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.slug, table.date] })],
);

// TTL watermark per series; `source` records which upstream last refreshed it.
export const macroSync = pgTable("macro_sync", {
  slug: text("slug").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(), // "fred" | "dbnomics"
});
