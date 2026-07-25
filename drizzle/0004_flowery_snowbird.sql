CREATE TABLE "wallet_transfer_sync" (
	"user_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"network" text NOT NULL,
	"latest_block" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallet_transfer_sync_user_id_wallet_network_pk" PRIMARY KEY("user_id","wallet","network")
);
--> statement-breakpoint
CREATE TABLE "wallet_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"network" text NOT NULL,
	"chain_id" integer,
	"unique_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"direction" text NOT NULL,
	"category" text NOT NULL,
	"asset_symbol" text,
	"asset_address" text,
	"amount" text,
	"value_usd" double precision,
	"counterparty" text,
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "chain" text DEFAULT 'evm' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "wallet_transfer_sync" ADD CONSTRAINT "wallet_transfer_sync_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transfers" ADD CONSTRAINT "wallet_transfers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transfers_dedupe_idx" ON "wallet_transfers" USING btree ("user_id","wallet","unique_id");--> statement-breakpoint
CREATE INDEX "wallet_transfers_wallet_ts_idx" ON "wallet_transfers" USING btree ("user_id","wallet","ts");