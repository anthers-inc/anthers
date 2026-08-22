CREATE TABLE "atproto_pending_signups" (
	"token" text PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text DEFAULT '' NOT NULL,
	"pds_url" text DEFAULT '' NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
