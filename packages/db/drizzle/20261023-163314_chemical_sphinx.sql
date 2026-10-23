CREATE TABLE "space_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"did" text NOT NULL,
	"space_uri" text NOT NULL,
	"collection" text NOT NULL,
	"rkey" text NOT NULL,
	"op" text NOT NULL,
	"record" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_spaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"did" text NOT NULL,
	"space_type" text DEFAULT 'org.anthers.userSpace' NOT NULL,
	"space_uri" text NOT NULL,
	"read_policy" jsonb NOT NULL,
	"write_policy" jsonb NOT NULL,
	"app_access" jsonb NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space_outbox" ADD CONSTRAINT "space_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_spaces" ADD CONSTRAINT "user_spaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_space_outbox_pending" ON "space_outbox" USING btree ("user_id","collection","rkey") WHERE "space_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_space_outbox_due" ON "space_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_space_outbox_user" ON "space_outbox" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_spaces_user_type" ON "user_spaces" USING btree ("user_id","space_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_spaces_uri" ON "user_spaces" USING btree ("space_uri");--> statement-breakpoint
CREATE INDEX "idx_user_spaces_did" ON "user_spaces" USING btree ("did");