-- Move ATProto OAuth onto `@atproto/oauth-client`.
--
-- `atproto_sessions` stops holding hand-managed token fields and holds the SDK's own
-- serialized session instead, keyed by DID rather than user id: the SDK's SessionStore is
-- addressed by token subject and knows nothing about Anthers accounts. On the login path
-- the row is therefore written before the account exists, which is why `user_id` becomes
-- nullable and is reconciled afterwards.
--
-- `atproto_oauth_state` replaces an in-process Map that lost every in-flight authorization
-- on restart and could not survive a callback landing on a different instance.
--
-- Both tables held zero rows when this was written, and any pre-existing session would be
-- unusable by the new client regardless — the DPoP key was stored in a shape only the old
-- hand-rolled code could read.

ALTER TABLE "atproto_sessions" DROP COLUMN IF EXISTS "access_token";
ALTER TABLE "atproto_sessions" DROP COLUMN IF EXISTS "refresh_token";
ALTER TABLE "atproto_sessions" DROP COLUMN IF EXISTS "dpop_private_pem";
ALTER TABLE "atproto_sessions" DROP COLUMN IF EXISTS "dpop_jwk";
ALTER TABLE "atproto_sessions" DROP COLUMN IF EXISTS "token_endpoint";
ALTER TABLE "atproto_sessions" DROP COLUMN IF EXISTS "dpop_nonce";

ALTER TABLE "atproto_sessions" ADD COLUMN "did" text;
ALTER TABLE "atproto_sessions" ADD COLUMN "session" jsonb;

-- No rows exist, so backfilling is a no-op; the constraints go on unconditionally.
DELETE FROM "atproto_sessions" WHERE "did" IS NULL;
ALTER TABLE "atproto_sessions" ALTER COLUMN "did" SET NOT NULL;
ALTER TABLE "atproto_sessions" ALTER COLUMN "session" SET NOT NULL;
ALTER TABLE "atproto_sessions" ADD CONSTRAINT "atproto_sessions_did_unique" UNIQUE("did");

-- A session row now precedes its account on the login path.
ALTER TABLE "atproto_sessions" ALTER COLUMN "user_id" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "atproto_oauth_state" (
	"key" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The TTL sweep scans by age; nothing else reads this column.
CREATE INDEX IF NOT EXISTS "idx_atproto_oauth_state_created" ON "atproto_oauth_state" ("created_at");
