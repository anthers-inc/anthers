CREATE TABLE "credit_acceptances" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"contributor_did" text NOT NULL,
	"role" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"atproto_uri" text,
	CONSTRAINT "credit_acceptances_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "credit_rejections" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"contributor_did" text NOT NULL,
	"role" text NOT NULL,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_acceptances" ADD CONSTRAINT "credit_acceptances_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_rejections" ADD CONSTRAINT "credit_rejections_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_acceptances_work_contributor_role" ON "credit_acceptances" USING btree ("work_id","contributor_did","role");--> statement-breakpoint
CREATE INDEX "idx_credit_acceptances_work" ON "credit_acceptances" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_rejections_work_contributor_role" ON "credit_rejections" USING btree ("work_id","contributor_did","role");--> statement-breakpoint
CREATE INDEX "idx_credit_rejections_work" ON "credit_rejections" USING btree ("work_id");