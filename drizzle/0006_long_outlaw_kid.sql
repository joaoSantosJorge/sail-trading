CREATE TABLE "saved_charts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"name" text NOT NULL,
	"interval" text NOT NULL,
	"drawings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"indicators" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_charts" ADD CONSTRAINT "saved_charts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_charts" ADD CONSTRAINT "saved_charts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_charts_user_updated_idx" ON "saved_charts" USING btree ("user_id","updated_at");