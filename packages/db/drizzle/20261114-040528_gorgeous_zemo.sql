CREATE TABLE "badge_collaborators" (
	"id" serial PRIMARY KEY NOT NULL,
	"badge_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "badge_publisher_handovers" (
	"id" serial PRIMARY KEY NOT NULL,
	"badge_id" integer NOT NULL,
	"from_creator_id" integer NOT NULL,
	"to_creator_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "badge_collaborators" ADD CONSTRAINT "badge_collaborators_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_collaborators" ADD CONSTRAINT "badge_collaborators_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_collaborators" ADD CONSTRAINT "badge_collaborators_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_publisher_handovers" ADD CONSTRAINT "badge_publisher_handovers_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_publisher_handovers" ADD CONSTRAINT "badge_publisher_handovers_from_creator_id_users_id_fk" FOREIGN KEY ("from_creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_publisher_handovers" ADD CONSTRAINT "badge_publisher_handovers_to_creator_id_users_id_fk" FOREIGN KEY ("to_creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_badge_collaborators_pair" ON "badge_collaborators" USING btree ("badge_id","creator_id");--> statement-breakpoint
CREATE INDEX "idx_badge_collaborators_creator" ON "badge_collaborators" USING btree ("creator_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_badge_publisher_handover_pending" ON "badge_publisher_handovers" USING btree ("badge_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_badge_publisher_handovers_badge" ON "badge_publisher_handovers" USING btree ("badge_id","created_at");