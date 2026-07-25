CREATE TABLE "contract_coin_map" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"coingecko_id" text,
	"symbol" text,
	"name" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_coin_map_chain_id_address_pk" PRIMARY KEY("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE "history_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"tx_key" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "history_tags" ADD CONSTRAINT "history_tags_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "history_tags_dedupe_idx" ON "history_tags" USING btree ("user_id","wallet","tx_key","tag");--> statement-breakpoint
CREATE INDEX "history_tags_user_wallet_idx" ON "history_tags" USING btree ("user_id","wallet");