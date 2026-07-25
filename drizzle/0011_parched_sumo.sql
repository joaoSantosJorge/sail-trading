CREATE TABLE "funding_rates" (
	"coin" text NOT NULL,
	"t" bigint NOT NULL,
	"rate" double precision NOT NULL,
	CONSTRAINT "funding_rates_coin_t_pk" PRIMARY KEY("coin","t")
);
--> statement-breakpoint
CREATE TABLE "funding_sync" (
	"coin" text PRIMARY KEY NOT NULL,
	"earliest_t" bigint NOT NULL,
	"latest_t" bigint NOT NULL
);
