CREATE TABLE "crf_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"amount" numeric NOT NULL,
	"purchase_id" integer,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crf_subsidies" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"billing_cycle" text NOT NULL,
	"estimated_hosting_cost" numeric NOT NULL,
	"creator_earnings" numeric NOT NULL,
	"subsidy_amount" numeric NOT NULL,
	"storage_bytes" bigint DEFAULT 0,
	"project_count" integer DEFAULT 0,
	"post_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"buyer_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"processing_fee" numeric NOT NULL,
	"crf_fee" numeric NOT NULL,
	"creator_earnings" numeric NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"stripe_account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false,
	"payouts_enabled" boolean DEFAULT false,
	"onboarding_complete" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_accounts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "stripe_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id")
);
--> statement-breakpoint
CREATE TABLE "game_jams" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '',
	"theme" text DEFAULT '',
	"cover_image" text DEFAULT '',
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"voting_end_at" timestamp with time zone NOT NULL,
	"max_team_size" integer DEFAULT 0,
	"allow_late_submissions" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_jams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "jam_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"jam_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"submitted_by_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jam_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atproto_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"access_token" text DEFAULT '',
	"refresh_token" text DEFAULT '',
	"dpop_private_pem" text DEFAULT '',
	"dpop_jwk" jsonb DEFAULT '{}'::jsonb,
	"token_endpoint" text DEFAULT '',
	"dpop_nonce" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atproto_sessions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" serial PRIMARY KEY NOT NULL,
	"follower_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"display_name" text DEFAULT '',
	"bio" text DEFAULT '',
	"is_creator" boolean DEFAULT false,
	"avatar" text DEFAULT '',
	"header_image" text DEFAULT '',
	"website_url" text DEFAULT '',
	"location" text DEFAULT '',
	"email_verified" boolean DEFAULT false,
	"atproto_did" text,
	"atproto_handle" text DEFAULT '',
	"atproto_pds_url" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_atproto_did_unique" UNIQUE("atproto_did")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "attention_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"post_id" integer,
	"event_type" text NOT NULL,
	"duration_seconds" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boost_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"billing_cycle" text NOT NULL,
	"is_locked" boolean DEFAULT false,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boost_allocations_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "creator_gates" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"gate_type" text DEFAULT 'boost' NOT NULL,
	"threshold" numeric NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '',
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_distributions" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscriber_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"billing_cycle" text NOT NULL,
	"pool_amount" numeric DEFAULT '0.00' NOT NULL,
	"boost_amount" numeric DEFAULT '0.00' NOT NULL,
	"attention_seconds" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"funding_level" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text DEFAULT '',
	"stripe_subscription_id" text DEFAULT '',
	"is_active" boolean DEFAULT true,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"content_id" integer NOT NULL,
	"file" text NOT NULL,
	"filename" text NOT NULL,
	"file_size" bigint DEFAULT 0,
	"mime_type" text DEFAULT '',
	"platform" text DEFAULT '',
	"version" text DEFAULT '',
	"is_primary" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"post_id" integer,
	"project_id" integer,
	"creator_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"body" text NOT NULL,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "cross_publish_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"platform" text NOT NULL,
	"post_id" integer,
	"external_id" text DEFAULT '',
	"external_url" text DEFAULT '',
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text DEFAULT '',
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_metric_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"cross_publish_id" integer NOT NULL,
	"views" bigint DEFAULT 0,
	"likes" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"shares" integer DEFAULT 0,
	"watch_time_seconds" bigint DEFAULT 0,
	"revenue_cents" bigint DEFAULT 0,
	"snapshot_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inline_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"image" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"platform" text NOT NULL,
	"access_token" text DEFAULT '',
	"refresh_token" text DEFAULT '',
	"token_expires_at" timestamp with time zone,
	"api_key" text DEFAULT '',
	"platform_user_id" text DEFAULT '',
	"platform_username" text DEFAULT '',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_contents" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"content_type" text DEFAULT 'text' NOT NULL,
	"title" text DEFAULT '',
	"thumbnail" text DEFAULT '',
	"body_html" text DEFAULT '',
	"images" jsonb DEFAULT '[]'::jsonb,
	"video_file" text DEFAULT '',
	"audio_file" text DEFAULT '',
	"embed_url" text DEFAULT '',
	"duration_seconds" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"public_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"title" text DEFAULT '',
	"body" text DEFAULT '',
	"body_html" text DEFAULT '',
	"content_type" text DEFAULT 'text' NOT NULL,
	"thumbnail" text DEFAULT '',
	"stream_enabled" boolean DEFAULT true NOT NULL,
	"download_enabled" boolean DEFAULT false NOT NULL,
	"anthers_access" jsonb DEFAULT '[]'::jsonb,
	"boost_access" jsonb DEFAULT '[]'::jsonb,
	"show_on_timeline" boolean DEFAULT true NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"website_url" text DEFAULT '',
	"source_url" text DEFAULT '',
	"estimated_read_minutes" integer,
	"is_published" boolean DEFAULT false NOT NULL,
	"view_count" bigint DEFAULT 0 NOT NULL,
	"download_count" bigint DEFAULT 0 NOT NULL,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "posts_slug_unique" UNIQUE("slug"),
	CONSTRAINT "posts_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "project_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '',
	"short_description" text DEFAULT '',
	"cover_image" text DEFAULT '',
	"page_config" jsonb DEFAULT '{}'::jsonb,
	"is_published" boolean DEFAULT false NOT NULL,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"post_id" integer NOT NULL,
	"score" integer NOT NULL,
	"atproto_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_atproto_uri_unique" UNIQUE("atproto_uri")
);
--> statement-breakpoint
CREATE TABLE "transcoding_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"content_id" integer NOT NULL,
	"media_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0,
	"error_message" text DEFAULT '',
	"hls_manifest_url" text DEFAULT '',
	"output_file_url" text DEFAULT '',
	"waveform_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crf_ledger" ADD CONSTRAINT "crf_ledger_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crf_subsidies" ADD CONSTRAINT "crf_subsidies_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD CONSTRAINT "stripe_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_jams" ADD CONSTRAINT "game_jams_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jam_entries" ADD CONSTRAINT "jam_entries_jam_id_game_jams_id_fk" FOREIGN KEY ("jam_id") REFERENCES "public"."game_jams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jam_entries" ADD CONSTRAINT "jam_entries_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jam_entries" ADD CONSTRAINT "jam_entries_submitted_by_id_users_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jam_votes" ADD CONSTRAINT "jam_votes_entry_id_jam_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."jam_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jam_votes" ADD CONSTRAINT "jam_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atproto_sessions" ADD CONSTRAINT "atproto_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_events" ADD CONSTRAINT "attention_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_events" ADD CONSTRAINT "attention_events_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_events" ADD CONSTRAINT "attention_events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boost_allocations" ADD CONSTRAINT "boost_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boost_allocations" ADD CONSTRAINT "boost_allocations_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_gates" ADD CONSTRAINT "creator_gates_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_distributions" ADD CONSTRAINT "pool_distributions_subscriber_id_users_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_distributions" ADD CONSTRAINT "pool_distributions_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_content_id_post_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."post_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_publish_results" ADD CONSTRAINT "cross_publish_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_publish_results" ADD CONSTRAINT "cross_publish_results_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_metric_snapshots" ADD CONSTRAINT "external_metric_snapshots_cross_publish_id_cross_publish_results_id_fk" FOREIGN KEY ("cross_publish_id") REFERENCES "public"."cross_publish_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inline_images" ADD CONSTRAINT "inline_images_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD CONSTRAINT "platform_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_contents" ADD CONSTRAINT "post_contents_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_posts" ADD CONSTRAINT "project_posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_posts" ADD CONSTRAINT "project_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcoding_jobs" ADD CONSTRAINT "transcoding_jobs_content_id_post_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."post_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crf_subsidies_creator_cycle" ON "crf_subsidies" USING btree ("creator_id","billing_cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jam_entries_jam_post" ON "jam_entries" USING btree ("jam_id","post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jam_votes_entry_user" ON "jam_votes" USING btree ("entry_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_follows_follower_creator" ON "follows" USING btree ("follower_id","creator_id");--> statement-breakpoint
CREATE INDEX "idx_attention_user_date" ON "attention_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_attention_creator_date" ON "attention_events" USING btree ("creator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_boost_user_creator_cycle" ON "boost_allocations" USING btree ("user_id","creator_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_creator_gates_creator" ON "creator_gates" USING btree ("creator_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pool_dist_sub_creator_cycle" ON "pool_distributions" USING btree ("subscriber_id","creator_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_assets_content" ON "assets" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "idx_bookmarks_user" ON "bookmarks" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_cross_publish_user_platform" ON "cross_publish_results" USING btree ("user_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ext_metric_publish_date" ON "external_metric_snapshots" USING btree ("cross_publish_id","snapshot_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_conn_user_platform" ON "platform_connections" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "idx_post_contents_post" ON "post_contents" USING btree ("post_id","position");--> statement-breakpoint
CREATE INDEX "idx_posts_creator" ON "posts" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_posts_content_type" ON "posts" USING btree ("content_type");--> statement-breakpoint
CREATE INDEX "idx_posts_created" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_posts_public_id" ON "posts" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_posts" ON "project_posts" USING btree ("project_id","post_id");--> statement-breakpoint
CREATE INDEX "idx_project_posts_project" ON "project_posts" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_project_posts_post" ON "project_posts" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ratings_user_post" ON "ratings" USING btree ("user_id","post_id");--> statement-breakpoint
CREATE INDEX "idx_transcoding_content" ON "transcoding_jobs" USING btree ("content_id");