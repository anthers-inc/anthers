-- Badge-model schema rename (Parker, 2026-10-02): the thing a subscription purchases is a
-- Badge. `creator_gates` becomes `badges` (the entity), `seed_allocations` becomes
-- `user_badges` (the holding — a discrete pick of a named Badge per cycle),
-- `works.seed_access` becomes `works.access` (matching the published `org.anthers.work`
-- Lexicon), and `pool_distributions.seed_amount` becomes `badge_amount`.
--
-- ⚠️ The rename statements below are hand-written on purpose, replacing drizzle-kit's
-- create-plus-drop output (it cannot tell a rename from add-plus-drop when the columns
-- change too). The snapshot this journal entry carries is drizzle-kit's own — the end
-- state is identical either way — but the SQL preserves data the generated version would
-- have destroyed.
--
-- `creator_gates` is RENAMED, with `gate_type` dropped: no cross-issuer gate exists at
-- launch (its `anthers_badge` value is exercised nowhere), and the table carries art and
-- labels worth keeping even in dev.
--
-- `seed_allocations` is DROPPED and `user_badges` created EMPTY — the sanctioned
-- pre-launch move. A holding is a discrete pick of a Badge row, and the badge rows it
-- would have to name do not exist yet (Phase B seeds them), so there is no data step that
-- could honestly map the old amount-carrying rows. Anthers is pre-launch and every dev
-- database is disposable per-session (`scripts/session.ts`), so nothing is lost.
ALTER TABLE "creator_gates" RENAME TO "badges";--> statement-breakpoint
-- Postgres keeps the old constraint/index/sequence names through a table rename, and
-- the snapshot records the new ones — rename them too so the next `db:generate` does
-- not see a phantom diff.
ALTER TABLE "badges" RENAME CONSTRAINT "creator_gates_pkey" TO "badges_pkey";--> statement-breakpoint
ALTER TABLE "badges" RENAME CONSTRAINT "creator_gates_creator_id_users_id_fk" TO "badges_creator_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "idx_creator_gates_creator" RENAME TO "idx_badges_creator";--> statement-breakpoint
ALTER SEQUENCE "creator_gates_id_seq" RENAME TO "badges_id_seq";--> statement-breakpoint
ALTER TABLE "badges" DROP COLUMN "gate_type";--> statement-breakpoint
DROP TABLE "seed_allocations" CASCADE;--> statement-breakpoint
CREATE TABLE "user_badges" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"badge_id" integer NOT NULL,
	"billing_cycle" text NOT NULL,
	"is_locked" boolean DEFAULT false,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_badges_atproto_uri_unique" UNIQUE("atproto_uri")
);--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_badges_user_badge_cycle" ON "user_badges" USING btree ("user_id","badge_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_user_badges_badge" ON "user_badges" USING btree ("badge_id");--> statement-breakpoint
ALTER TABLE "works" RENAME COLUMN "seed_access" TO "access";--> statement-breakpoint
ALTER TABLE "pool_distributions" RENAME COLUMN "seed_amount" TO "badge_amount";