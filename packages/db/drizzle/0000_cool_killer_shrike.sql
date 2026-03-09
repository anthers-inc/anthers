CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"user_id" integer NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" varchar(150) NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" varchar(255),
	"display_name" varchar(150) DEFAULT '',
	"bio" text DEFAULT '',
	"is_creator" boolean DEFAULT false,
	"avatar" varchar(500) DEFAULT '',
	"header_image" varchar(500) DEFAULT '',
	"website_url" varchar(500) DEFAULT '',
	"location" varchar(100) DEFAULT '',
	"email_verified" boolean DEFAULT false,
	"atproto_did" varchar(255),
	"atproto_handle" varchar(255) DEFAULT '',
	"atproto_pds_url" varchar(500) DEFAULT '',
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_atproto_did_unique" UNIQUE("atproto_did")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" varchar(64) NOT NULL,
	"type" varchar(20) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text DEFAULT '',
	"pricing_model" varchar(20) DEFAULT 'free' NOT NULL,
	"price" numeric(10, 2),
	"min_price" numeric(10, 2),
	"published" boolean DEFAULT false,
	"cover_image" varchar(500) DEFAULT '',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;