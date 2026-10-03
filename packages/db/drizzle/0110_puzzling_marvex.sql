CREATE TABLE "creator_netting_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"netting_id" integer NOT NULL,
	"credit_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_nettings" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer,
	"dispute_id" integer,
	"purchase_id" integer,
	"stripe_refund_id" text,
	"amount" numeric NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_creator_nettings_one_source" CHECK ((CASE WHEN "creator_nettings"."dispute_id" IS NOT NULL THEN 1 ELSE 0 END) +
				(CASE WHEN "creator_nettings"."purchase_id" IS NOT NULL THEN 1 ELSE 0 END) <= 1)
);
--> statement-breakpoint
ALTER TABLE "creator_netting_applications" ADD CONSTRAINT "creator_netting_applications_netting_id_creator_nettings_id_fk" FOREIGN KEY ("netting_id") REFERENCES "public"."creator_nettings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_netting_applications" ADD CONSTRAINT "creator_netting_applications_credit_id_creator_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."creator_credits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_nettings" ADD CONSTRAINT "creator_nettings_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_nettings" ADD CONSTRAINT "creator_nettings_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_nettings" ADD CONSTRAINT "creator_nettings_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_netting_applications_pair" ON "creator_netting_applications" USING btree ("netting_id","credit_id");--> statement-breakpoint
CREATE INDEX "idx_creator_netting_applications_credit" ON "creator_netting_applications" USING btree ("credit_id");--> statement-breakpoint
CREATE INDEX "idx_creator_nettings_creator" ON "creator_nettings" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_creator_nettings_dispute" ON "creator_nettings" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "idx_creator_nettings_purchase" ON "creator_nettings" USING btree ("purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_nettings_refund" ON "creator_nettings" USING btree ("stripe_refund_id","purchase_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_creator_nettings_dispute" ON "creator_nettings" USING btree ("dispute_id");