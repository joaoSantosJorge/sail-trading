ALTER TABLE "executions" ADD COLUMN "user_wallet" text;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD COLUMN "wallet_address" text;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD COLUMN "expires_at" timestamp with time zone;