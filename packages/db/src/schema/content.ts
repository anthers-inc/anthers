// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";

export const projects = sqliteTable(
	"projects",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		slug: text("slug").notNull().unique(),
		description: text("description").default(""),
		shortDescription: text("short_description").default(""),
		mediaType: text("media_type").notNull().default("game"), // game | video | audio | text
		tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
		isPublished: integer("is_published", { mode: "boolean" }).default(false),

		// Pricing — stored as text for decimal.js precision.
		pricingType: text("pricing_type").notNull().default("free"), // free | pwyw | paid
		price: text("price"),
		minPrice: text("min_price"),
		suggestedPrice: text("suggested_price"),

		// Display
		coverImage: text("cover_image").default(""),
		embedUrl: text("embed_url").default(""),

		// Metadata
		websiteUrl: text("website_url").default(""),
		sourceUrl: text("source_url").default(""),

		// Counters
		viewCount: integer("view_count").default(0),
		downloadCount: integer("download_count").default(0),

		// ATProto
		atprotoUri: text("atproto_uri").unique(),

		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [
		index("idx_project_views").on(table.viewCount),
		index("idx_project_downloads").on(table.downloadCount),
	],
);

export const screenshots = sqliteTable("screenshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	caption: text("caption").default(""),
	sortOrder: integer("sort_order").default(0),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const assets = sqliteTable("assets", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	file: text("file").notNull(),
	filename: text("filename").notNull(),
	fileSize: integer("file_size").default(0),
	mimeType: text("mime_type").default(""),
	platform: text("platform").default(""), // windows | mac | linux
	version: text("version").default(""),
	isPrimary: integer("is_primary", { mode: "boolean" }).default(false),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const posts = sqliteTable("posts", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
	title: text("title").default(""),
	body: text("body").default(""),
	bodyHtml: text("body_html").default(""),
	contentType: text("content_type").notNull().default("text"), // text | video | audio

	// Media fields
	videoFile: text("video_file").default(""),
	audioFile: text("audio_file").default(""),
	thumbnail: text("thumbnail").default(""),
	durationSeconds: integer("duration_seconds"),

	// Access control
	isPremium: integer("is_premium", { mode: "boolean" }).default(false),
	visibility: text("visibility").notNull().default("public"), // public | subscribers_only | gated
	isPublished: integer("is_published", { mode: "boolean" }).default(false),

	// Text post metadata
	estimatedReadMinutes: integer("estimated_read_minutes"),

	// ATProto
	atprotoUri: text("atproto_uri").unique(),

	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const transcodingJobs = sqliteTable("transcoding_jobs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	postId: integer("post_id")
		.notNull()
		.references(() => posts.id, { onDelete: "cascade" }),
	mediaType: text("media_type").notNull(), // video | audio
	status: text("status").notNull().default("pending"), // pending | processing | completed | failed
	progress: integer("progress").default(0),
	errorMessage: text("error_message").default(""),
	hlsManifestUrl: text("hls_manifest_url").default(""),
	outputFileUrl: text("output_file_url").default(""),
	waveformData: text("waveform_data", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const inlineImages = sqliteTable("inline_images", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const comments = sqliteTable("comments", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
	postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
	body: text("body").notNull(),
	atprotoUri: text("atproto_uri").unique(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const bookmarks = sqliteTable(
	"bookmarks",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [index("idx_bookmarks_user").on(table.userId, table.sortOrder)],
);

export const ratings = sqliteTable(
	"ratings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		score: integer("score").notNull(), // 1-5, validated at application layer
		atprotoUri: text("atproto_uri").unique(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [uniqueIndex("uq_ratings_user_project").on(table.userId, table.projectId)],
);
