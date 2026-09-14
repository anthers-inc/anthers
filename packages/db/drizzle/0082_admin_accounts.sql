CREATE TABLE "admin_account_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"actor_id" integer,
	"kind" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"account_id" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_sign_in_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sign_in_codes_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "admin_account_events" ADD CONSTRAINT "admin_account_events_account_id_admin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_account_events" ADD CONSTRAINT "admin_account_events_actor_id_admin_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_account_id_admin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."admin_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_admin_account_events_account" ON "admin_account_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_admin_sessions_account" ON "admin_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_admin_sessions_expires" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_admin_sign_in_codes_expires" ON "admin_sign_in_codes" USING btree ("expires_at");