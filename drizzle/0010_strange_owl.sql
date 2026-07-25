ALTER TABLE "executions" ALTER COLUMN "chain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "venue" text DEFAULT 'evm' NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD COLUMN "kind" text DEFAULT 'swap' NOT NULL;