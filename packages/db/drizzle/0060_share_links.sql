CREATE TABLE "share_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"work_id" integer NOT NULL,
	"sharer_id" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "attention_events" ADD COLUMN "via_share_link" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_sharer_id_users_id_fk" FOREIGN KEY ("sharer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_share_links_sharer_work" ON "share_links" USING btree ("sharer_id","work_id");--> statement-breakpoint
CREATE INDEX "idx_share_links_work" ON "share_links" USING btree ("work_id");