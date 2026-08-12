-- The signup ceremony: prove the address, THEN build the account.
--
-- Two changes, and they are the same change seen from either end. `signup_codes` can
-- hold a code for an address that has no user row yet — every other credential table
-- here hangs off a `user_id`, which is precisely what a pre-account code cannot do — and
-- `users.username` has to be nullable because the account is created at the moment the
-- code is verified, which is before onboarding has asked for a handle.
--
-- Both are WIDENING. Dropping NOT NULL cannot fail on existing data and cannot lose any:
-- every current row keeps its username, and nothing is backfilled because nothing needs
-- to be. The risk in this migration is entirely on the read side rather than here — a
-- public surface that renders a null handle would publish a blank profile at a blank
-- URL — which is why the guard lives in the serializers and the `/:username` route, and
-- why the type is `string | null` rather than being asserted away at the boundary.

--> statement-breakpoint
CREATE TABLE "signup_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_codes_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_signup_codes_expires" ON "signup_codes" USING btree ("expires_at");