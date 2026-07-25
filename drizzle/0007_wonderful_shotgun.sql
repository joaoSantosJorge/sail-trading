CREATE TABLE "macro_observations" (
	"slug" text NOT NULL,
	"date" text NOT NULL,
	"value" double precision NOT NULL,
	CONSTRAINT "macro_observations_slug_date_pk" PRIMARY KEY("slug","date")
);
--> statement-breakpoint
CREATE TABLE "macro_sync" (
	"slug" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL
);
