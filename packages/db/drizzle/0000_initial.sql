CREATE TABLE `crf_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`amount` text NOT NULL,
	`purchase_id` integer,
	`description` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `crf_subsidies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`billing_cycle` text NOT NULL,
	`estimated_hosting_cost` text NOT NULL,
	`creator_earnings` text NOT NULL,
	`subsidy_amount` text NOT NULL,
	`storage_bytes` integer DEFAULT 0,
	`project_count` integer DEFAULT 0,
	`post_count` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_crf_subsidies_creator_cycle` ON `crf_subsidies` (`creator_id`,`billing_cycle`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`buyer_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`amount` text NOT NULL,
	`processing_fee` text NOT NULL,
	`crf_fee` text NOT NULL,
	`creator_earnings` text NOT NULL,
	`stripe_payment_intent_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_stripe_payment_intent_id_unique` ON `purchases` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE TABLE `stripe_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`stripe_account_id` text NOT NULL,
	`charges_enabled` integer DEFAULT false,
	`payouts_enabled` integer DEFAULT false,
	`onboarding_complete` integer DEFAULT false,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_accounts_user_id_unique` ON `stripe_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_accounts_stripe_account_id_unique` ON `stripe_accounts` (`stripe_account_id`);--> statement-breakpoint
CREATE TABLE `game_jams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '',
	`theme` text DEFAULT '',
	`cover_image` text DEFAULT '',
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`voting_end_at` integer NOT NULL,
	`max_team_size` integer DEFAULT 0,
	`allow_late_submissions` integer DEFAULT false,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_jams_slug_unique` ON `game_jams` (`slug`);--> statement-breakpoint
CREATE TABLE `jam_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`jam_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`submitted_by_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`jam_id`) REFERENCES `game_jams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitted_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_jam_entries_jam_project` ON `jam_entries` (`jam_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `jam_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`score` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `jam_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_jam_votes_entry_user` ON `jam_votes` (`entry_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `atproto_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`access_token` text DEFAULT '',
	`refresh_token` text DEFAULT '',
	`dpop_private_pem` text DEFAULT '',
	`dpop_jwk` text DEFAULT '{}',
	`token_endpoint` text DEFAULT '',
	`dpop_nonce` text DEFAULT '',
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atproto_sessions_user_id_unique` ON `atproto_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `follows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`follower_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`atproto_uri` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follows_atproto_uri_unique` ON `follows` (`atproto_uri`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_follows_follower_creator` ON `follows` (`follower_id`,`creator_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`user_id` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`display_name` text DEFAULT '',
	`bio` text DEFAULT '',
	`is_creator` integer DEFAULT false,
	`avatar` text DEFAULT '',
	`header_image` text DEFAULT '',
	`website_url` text DEFAULT '',
	`location` text DEFAULT '',
	`email_verified` integer DEFAULT false,
	`atproto_did` text,
	`atproto_handle` text DEFAULT '',
	`atproto_pds_url` text DEFAULT '',
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_atproto_did_unique` ON `users` (`atproto_did`);--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token` text NOT NULL,
	`type` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_tokens_token_unique` ON `verification_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `attention_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`project_id` integer,
	`post_id` integer,
	`event_type` text NOT NULL,
	`duration_seconds` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_attention_user_date` ON `attention_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_attention_creator_date` ON `attention_events` (`creator_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `boost_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`amount` text NOT NULL,
	`billing_cycle` text NOT NULL,
	`is_locked` integer DEFAULT false,
	`atproto_uri` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boost_allocations_atproto_uri_unique` ON `boost_allocations` (`atproto_uri`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_boost_user_creator_cycle` ON `boost_allocations` (`user_id`,`creator_id`,`billing_cycle`);--> statement-breakpoint
CREATE TABLE `creator_gates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`gate_type` text DEFAULT 'boost' NOT NULL,
	`threshold` text NOT NULL,
	`label` text NOT NULL,
	`description` text DEFAULT '',
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pool_distributions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`billing_cycle` text NOT NULL,
	`pool_amount` text DEFAULT '0.00' NOT NULL,
	`boost_amount` text DEFAULT '0.00' NOT NULL,
	`attention_seconds` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pool_dist_sub_creator_cycle` ON `pool_distributions` (`subscriber_id`,`creator_id`,`billing_cycle`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`tier` text DEFAULT 'free' NOT NULL,
	`funding_level` integer DEFAULT 0 NOT NULL,
	`stripe_customer_id` text DEFAULT '',
	`stripe_subscription_id` text DEFAULT '',
	`is_active` integer DEFAULT true,
	`current_period_start` integer,
	`current_period_end` integer,
	`canceled_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_id_unique` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`file` text NOT NULL,
	`filename` text NOT NULL,
	`file_size` integer DEFAULT 0,
	`mime_type` text DEFAULT '',
	`platform` text DEFAULT '',
	`version` text DEFAULT '',
	`is_primary` integer DEFAULT false,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bookmarks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer,
	`post_id` integer,
	`creator_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bookmarks_user` ON `bookmarks` (`user_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer,
	`post_id` integer,
	`body` text NOT NULL,
	`atproto_uri` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comments_atproto_uri_unique` ON `comments` (`atproto_uri`);--> statement-breakpoint
CREATE TABLE `cross_publish_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`platform` text NOT NULL,
	`project_id` integer,
	`post_id` integer,
	`external_id` text DEFAULT '',
	`external_url` text DEFAULT '',
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text DEFAULT '',
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cross_publish_user_platform` ON `cross_publish_results` (`user_id`,`platform`);--> statement-breakpoint
CREATE TABLE `external_metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cross_publish_id` integer NOT NULL,
	`views` integer DEFAULT 0,
	`likes` integer DEFAULT 0,
	`comments` integer DEFAULT 0,
	`shares` integer DEFAULT 0,
	`watch_time_seconds` integer DEFAULT 0,
	`revenue_cents` integer DEFAULT 0,
	`snapshot_date` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`cross_publish_id`) REFERENCES `cross_publish_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ext_metric_publish_date` ON `external_metric_snapshots` (`cross_publish_id`,`snapshot_date`);--> statement-breakpoint
CREATE TABLE `inline_images` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`image` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `platform_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`platform` text NOT NULL,
	`access_token` text DEFAULT '',
	`refresh_token` text DEFAULT '',
	`token_expires_at` integer,
	`api_key` text DEFAULT '',
	`platform_user_id` text DEFAULT '',
	`platform_username` text DEFAULT '',
	`is_active` integer DEFAULT true,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_conn_user_platform` ON `platform_connections` (`user_id`,`platform`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`project_id` integer,
	`title` text DEFAULT '',
	`body` text DEFAULT '',
	`body_html` text DEFAULT '',
	`content_type` text DEFAULT 'text' NOT NULL,
	`video_file` text DEFAULT '',
	`audio_file` text DEFAULT '',
	`thumbnail` text DEFAULT '',
	`duration_seconds` integer,
	`is_premium` integer DEFAULT false,
	`visibility` text DEFAULT 'public' NOT NULL,
	`is_published` integer DEFAULT false,
	`estimated_read_minutes` integer,
	`atproto_uri` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_atproto_uri_unique` ON `posts` (`atproto_uri`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creator_id` integer NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '',
	`short_description` text DEFAULT '',
	`media_type` text DEFAULT 'game' NOT NULL,
	`tags` text DEFAULT '[]',
	`is_published` integer DEFAULT false,
	`pricing_type` text DEFAULT 'free' NOT NULL,
	`price` text,
	`min_price` text,
	`suggested_price` text,
	`cover_image` text DEFAULT '',
	`embed_url` text DEFAULT '',
	`website_url` text DEFAULT '',
	`source_url` text DEFAULT '',
	`view_count` integer DEFAULT 0,
	`download_count` integer DEFAULT 0,
	`atproto_uri` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_atproto_uri_unique` ON `projects` (`atproto_uri`);--> statement-breakpoint
CREATE INDEX `idx_project_views` ON `projects` (`view_count`);--> statement-breakpoint
CREATE INDEX `idx_project_downloads` ON `projects` (`download_count`);--> statement-breakpoint
CREATE TABLE `ratings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`score` integer NOT NULL,
	`atproto_uri` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ratings_atproto_uri_unique` ON `ratings` (`atproto_uri`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ratings_user_project` ON `ratings` (`user_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`image` text NOT NULL,
	`caption` text DEFAULT '',
	`sort_order` integer DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transcoding_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`media_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` integer DEFAULT 0,
	`error_message` text DEFAULT '',
	`hls_manifest_url` text DEFAULT '',
	`output_file_url` text DEFAULT '',
	`waveform_data` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
