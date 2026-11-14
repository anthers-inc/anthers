CREATE TABLE "work_collaborators" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_publisher_handovers" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"from_creator_id" integer NOT NULL,
	"to_creator_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "work_collaborators" ADD CONSTRAINT "work_collaborators_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_collaborators" ADD CONSTRAINT "work_collaborators_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_collaborators" ADD CONSTRAINT "work_collaborators_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_publisher_handovers" ADD CONSTRAINT "work_publisher_handovers_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_publisher_handovers" ADD CONSTRAINT "work_publisher_handovers_from_creator_id_users_id_fk" FOREIGN KEY ("from_creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_publisher_handovers" ADD CONSTRAINT "work_publisher_handovers_to_creator_id_users_id_fk" FOREIGN KEY ("to_creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_collaborators_pair" ON "work_collaborators" USING btree ("work_id","creator_id");--> statement-breakpoint
CREATE INDEX "idx_work_collaborators_creator" ON "work_collaborators" USING btree ("creator_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_publisher_handover_pending" ON "work_publisher_handovers" USING btree ("work_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_work_publisher_handovers_work" ON "work_publisher_handovers" USING btree ("work_id","created_at");