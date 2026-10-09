CREATE TABLE "storage_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"billing_cycle" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"purposes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_storage_usage_user_cycle" ON "storage_usage" USING btree ("user_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_storage_usage_cycle" ON "storage_usage" USING btree ("billing_cycle");