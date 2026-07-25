CREATE TABLE "news_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'cryptopanic' NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"kind" text,
	"source_domain" text,
	"currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"panic_score" double precision,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_items_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "news_sync" (
	"filter_key" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "news_items_published_idx" ON "news_items" USING btree ("published_at");