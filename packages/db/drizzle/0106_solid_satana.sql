CREATE TABLE "signup_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"difficulty" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signup_challenges_challenge_unique" UNIQUE("challenge")
);
--> statement-breakpoint
CREATE INDEX "idx_signup_challenges_expires" ON "signup_challenges" USING btree ("expires_at");