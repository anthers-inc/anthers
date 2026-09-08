CREATE TABLE "hosted_accounts" (
	"did" text PRIMARY KEY NOT NULL,
	"user_id" integer,
	"handle" text NOT NULL,
	"sealed_password" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_signups" ADD COLUMN "hosted_handle" text;--> statement-breakpoint
ALTER TABLE "hosted_accounts" ADD CONSTRAINT "hosted_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;