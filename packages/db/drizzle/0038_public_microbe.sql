CREATE TABLE "dmca_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer,
	"complainant_name" text NOT NULL,
	"complainant_email" text NOT NULL,
	"complainant_address" text NOT NULL,
	"complainant_phone" text DEFAULT '',
	"copyrighted_work_description" text NOT NULL,
	"infringing_material_description" text NOT NULL,
	"good_faith_statement" text NOT NULL,
	"authorization_statement" text NOT NULL,
	"fair_use_considered" boolean NOT NULL,
	"attestation_text_snapshot" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actioned_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"counter_notice" jsonb,
	"counter_notice_filed_at" timestamp with time zone,
	"restore_no_earlier_than" timestamp with time zone,
	"suit_filed_at" timestamp with time zone,
	"actor_id" integer,
	"actor_role" text DEFAULT 'operator' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "takedown_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dmca_notices" ADD CONSTRAINT "dmca_notices_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dmca_notices_status" ON "dmca_notices" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "idx_dmca_notices_work" ON "dmca_notices" USING btree ("work_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dmca_notices_restore" ON "dmca_notices" USING btree ("status","restore_no_earlier_than");--> statement-breakpoint
CREATE INDEX "idx_dmca_notices_actor" ON "dmca_notices" USING btree ("actor_id");