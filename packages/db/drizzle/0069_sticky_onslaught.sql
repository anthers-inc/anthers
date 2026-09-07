CREATE TABLE "hosted_identities" (
	"did" text PRIMARY KEY NOT NULL,
	"handle" text,
	"pds_endpoint" text,
	"head_cid" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_listed_at" timestamp with time zone,
	"alerted_at" timestamp with time zone
);
