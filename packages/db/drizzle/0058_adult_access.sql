ALTER TABLE "accounts" ADD COLUMN "adult_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "adult_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "adult_verified_method" text;