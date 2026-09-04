CREATE TABLE "reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reactions_user_subject" ON "reactions" USING btree ("user_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_reactions_subject" ON "reactions" USING btree ("subject_type","subject_id");