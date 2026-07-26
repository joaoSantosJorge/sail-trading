CREATE TABLE "algo_deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy_id" integer NOT NULL,
	"backtest_run_id" integer,
	"asset_id" integer NOT NULL,
	"dsl" jsonb NOT NULL,
	"interval" text NOT NULL,
	"venue" text DEFAULT 'hyperliquid' NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"status_reason" text,
	"leverage" integer DEFAULT 1 NOT NULL,
	"margin_mode" text DEFAULT 'cross' NOT NULL,
	"sizing_mode" text NOT NULL,
	"sizing_value" double precision NOT NULL,
	"max_drawdown_pct" double precision,
	"daily_loss_limit_usd" double precision,
	"wallet_address" text,
	"last_bar_t" bigint,
	"last_run_at" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"position_size" double precision,
	"entry_px" double precision,
	"entry_bar_t" bigint,
	"entry_oid" text,
	"tp_oid" text,
	"sl_oid" text,
	"cooldown_left" integer DEFAULT 0 NOT NULL,
	"baseline_equity_usd" double precision,
	"realized_pnl_usd" double precision DEFAULT 0 NOT NULL,
	"peak_pnl_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"bar_t" bigint,
	"type" text NOT NULL,
	"signal" jsonb,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_signer_wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'privy' NOT NULL,
	"wallet_id" text NOT NULL,
	"agent_address" text NOT NULL,
	"master_wallet" text,
	"agent_valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "algo_deployments" ADD CONSTRAINT "algo_deployments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_deployments" ADD CONSTRAINT "algo_deployments_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_deployments" ADD CONSTRAINT "algo_deployments_backtest_run_id_backtest_runs_id_fk" FOREIGN KEY ("backtest_run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "algo_deployments" ADD CONSTRAINT "algo_deployments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_deployment_id_algo_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."algo_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_signer_wallets" ADD CONSTRAINT "user_signer_wallets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "algo_deployments_user_created_idx" ON "algo_deployments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "algo_deployments_due_idx" ON "algo_deployments" USING btree ("status","interval","last_bar_t");--> statement-breakpoint
CREATE UNIQUE INDEX "algo_deployments_live_coin_uq" ON "algo_deployments" USING btree ("user_id","asset_id") WHERE status = 'active' and mode = 'live';--> statement-breakpoint
CREATE INDEX "bot_events_deployment_created_idx" ON "bot_events" USING btree ("deployment_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_events_user_created_idx" ON "bot_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_events_evaluated_bar_uq" ON "bot_events" USING btree ("deployment_id","bar_t") WHERE type = 'evaluated';