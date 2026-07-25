CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"coingecko_id" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"chain_id" integer,
	"address" text,
	"decimals" integer,
	"binance_symbol" text,
	CONSTRAINT "assets_coingecko_id_unique" UNIQUE("coingecko_id")
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"interval" text NOT NULL,
	"from_t" bigint NOT NULL,
	"to_t" bigint NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"metrics" jsonb,
	"trades" jsonb,
	"equity_curve" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candle_sync" (
	"asset_id" integer NOT NULL,
	"interval" text NOT NULL,
	"earliest_t" bigint NOT NULL,
	"latest_t" bigint NOT NULL,
	CONSTRAINT "candle_sync_asset_id_interval_pk" PRIMARY KEY("asset_id","interval")
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"asset_id" integer NOT NULL,
	"interval" text NOT NULL,
	"t" bigint NOT NULL,
	"o" double precision NOT NULL,
	"h" double precision NOT NULL,
	"l" double precision NOT NULL,
	"c" double precision NOT NULL,
	"v" double precision NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "candles_asset_id_interval_t_pk" PRIMARY KEY("asset_id","interval","t")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" serial PRIMARY KEY NOT NULL,
	"proposal_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text,
	"quote" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"positions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"report_md" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_id" integer,
	"name" text NOT NULL,
	"dsl" jsonb NOT NULL,
	"source" text NOT NULL,
	"prompt_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer,
	"proposal" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"chain_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candle_sync" ADD CONSTRAINT "candle_sync_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_proposal_id_trade_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."trade_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD CONSTRAINT "trade_proposals_report_id_research_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."research_reports"("id") ON DELETE no action ON UPDATE no action;