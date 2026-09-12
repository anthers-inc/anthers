ALTER TABLE "votes" ADD COLUMN "atproto_uri" text;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_atproto_uri_unique" UNIQUE("atproto_uri");