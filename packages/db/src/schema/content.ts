// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * Posts — the universal, content-type-agnostic unit of published content.
 *
 * Everything a creator publishes is a Post. Delivery (stream and/or download)
 * and access (free / paid / subscriber- or boost-gated) are orthogonal, per-post
 * switches. Projects (below) are collections that group posts; they are NOT a
 * content type. See Architecture › "30.1 - Unified Post & Content Model".
 */
export const posts = pgTable(
	"posts",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		slug: text("slug").notNull().unique(),
		title: text("title").default(""),
		body: text("body").default(""),
		bodyHtml: text("body_html").default(""),
		// text | image | audio | video | game | software | physical | service
		contentType: text("content_type").notNull().default("text"),

		// ── Delivery (orthogonal; ≥1 enforced at the app layer) ──
		streamEnabled: boolean("stream_enabled").notNull().default(true),
		downloadEnabled: boolean("download_enabled").notNull().default(false),

		// ── Stream payload / media (type-specific; transcode outputs live in
		// transcoding_jobs, gallery images in gallery_images, downloads in assets) ──
		videoFile: text("video_file").default(""),
		audioFile: text("audio_file").default(""),
		coverImage: text("cover_image").default(""),
		thumbnail: text("thumbnail").default(""),
		embedUrl: text("embed_url").default(""), // web game/app or external embed
		durationSeconds: integer("duration_seconds"),

		// ── Access & pricing (one entitlement model — see the design doc) ──
		// Base: null price = free; else a fixed or PWYW price (numeric for decimal.js).
		basePrice: numeric("base_price"),
		pricingMode: text("pricing_mode").notNull().default("fixed"), // fixed | pwyw
		minPrice: numeric("min_price"),
		suggestedPrice: numeric("suggested_price"),
		// Optional entitlement that grants access, possibly at a discount.
		entitlementKind: text("entitlement_kind"), // null | tier | boost
		entitlementTier: text("entitlement_tier"), // when kind=tier; null = any subscription
		entitlementBoostThreshold: numeric("entitlement_boost_threshold"), // when kind=boost
		entitlementDiscountPct: integer("entitlement_discount_pct"), // 0..100 (100 = free for entitled)
		// If false, only entitled users get it (gated); if true, anyone can buy.
		purchasableWithoutEntitlement: boolean("purchasable_without_entitlement")
			.notNull()
			.default(true),

		// ── Presentation ──
		isPinned: boolean("is_pinned").notNull().default(false),
		listing: text("listing").notNull().default("timeline"), // timeline | unlisted | shop

		// ── Metadata ──
		tags: jsonb("tags").$type<string[]>().default([]),
		websiteUrl: text("website_url").default(""),
		sourceUrl: text("source_url").default(""),
		estimatedReadMinutes: integer("estimated_read_minutes"),
		isPublished: boolean("is_published").notNull().default(false),

		// ── Counters (bigint — views/downloads can exceed int4 at scale) ──
		viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
		downloadCount: bigint("download_count", { mode: "number" }).notNull().default(0),

		// ── ATProto ──
		atprotoUri: text("atproto_uri").unique(),

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_posts_creator").on(table.creatorId),
		index("idx_posts_content_type").on(table.contentType),
		index("idx_posts_created").on(table.createdAt),
	],
);

/**
 * Projects — collections (playlist-like wrappers) that group posts and give them
 * a rich custom showcase page. Not a content type; hold no content or pricing.
 */
export const projects = pgTable("projects", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	slug: text("slug").notNull().unique(),
	title: text("title").notNull(),
	description: text("description").default(""),
	shortDescription: text("short_description").default(""),
	coverImage: text("cover_image").default(""),
	// Custom-page layout/showcase config (built out in a later phase).
	pageConfig: jsonb("page_config").$type<Record<string, unknown>>().default({}),
	isPublished: boolean("is_published").notNull().default(false),
	atprotoUri: text("atproto_uri").unique(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Many-to-many: which posts belong to which project (collection), with ordering. */
export const projectPosts = pgTable(
	"project_posts",
	{
		id: serial("id").primaryKey(),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_project_posts").on(table.projectId, table.postId),
		index("idx_project_posts_project").on(table.projectId, table.sortOrder),
		index("idx_project_posts_post").on(table.postId),
	],
);

/** Gallery / screenshot images attached to a post (image posts, game screenshots, …). */
export const galleryImages = pgTable("gallery_images", {
	id: serial("id").primaryKey(),
	postId: integer("post_id")
		.notNull()
		.references(() => posts.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	caption: text("caption").default(""),
	sortOrder: integer("sort_order").default(0),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Downloadable files (builds, tracks, PDFs, installers, …) attached to any post. */
export const assets = pgTable("assets", {
	id: serial("id").primaryKey(),
	postId: integer("post_id")
		.notNull()
		.references(() => posts.id, { onDelete: "cascade" }),
	file: text("file").notNull(), // storage key
	filename: text("filename").notNull(),
	// bigint — a build/installer can exceed int4 (2.1 GB).
	fileSize: bigint("file_size", { mode: "number" }).default(0),
	mimeType: text("mime_type").default(""),
	platform: text("platform").default(""), // windows | mac | linux | web | … (games/software)
	version: text("version").default(""),
	isPrimary: boolean("is_primary").default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const transcodingJobs = pgTable("transcoding_jobs", {
	id: serial("id").primaryKey(),
	postId: integer("post_id")
		.notNull()
		.references(() => posts.id, { onDelete: "cascade" }),
	mediaType: text("media_type").notNull(), // video | audio
	status: text("status").notNull().default("pending"), // pending | processing | completed | failed
	progress: integer("progress").default(0),
	errorMessage: text("error_message").default(""),
	hlsManifestUrl: text("hls_manifest_url").default(""),
	outputFileUrl: text("output_file_url").default(""),
	waveformData: jsonb("waveform_data"),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const inlineImages = pgTable("inline_images", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const comments = pgTable("comments", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	postId: integer("post_id")
		.notNull()
		.references(() => posts.id, { onDelete: "cascade" }),
	body: text("body").notNull(),
	atprotoUri: text("atproto_uri").unique(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const bookmarks = pgTable(
	"bookmarks",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_bookmarks_user").on(table.userId, table.sortOrder)],
);

export const ratings = pgTable(
	"ratings",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		score: integer("score").notNull(), // 1-5, validated at application layer
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_ratings_user_post").on(table.userId, table.postId)],
);
