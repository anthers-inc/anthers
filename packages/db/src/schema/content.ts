// SPDX-License-Identifier: AGPL-3.0-or-later
import {
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

export const projects = pgTable(
	"projects",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		slug: text("slug").notNull().unique(),
		description: text("description").default(""),
		shortDescription: text("short_description").default(""),
		mediaType: text("media_type").notNull().default("game"), // game | video | audio | text
		tags: jsonb("tags").$type<string[]>().default([]),
		isPublished: boolean("is_published").default(false),

		// Pricing — stored as numeric for decimal.js precision (app owns rounding).
		pricingType: text("pricing_type").notNull().default("free"), // free | pwyw | paid
		price: numeric("price"),
		minPrice: numeric("min_price"),
		suggestedPrice: numeric("suggested_price"),

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

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_project_views").on(table.viewCount),
		index("idx_project_downloads").on(table.downloadCount),
	],
);

export const screenshots = pgTable("screenshots", {
	id: serial("id").primaryKey(),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	caption: text("caption").default(""),
	sortOrder: integer("sort_order").default(0),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const assets = pgTable("assets", {
	id: serial("id").primaryKey(),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	file: text("file").notNull(),
	filename: text("filename").notNull(),
	fileSize: integer("file_size").default(0),
	mimeType: text("mime_type").default(""),
	platform: text("platform").default(""), // windows | mac | linux
	version: text("version").default(""),
	isPrimary: boolean("is_primary").default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const posts = pgTable("posts", {
	id: serial("id").primaryKey(),
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
	isPremium: boolean("is_premium").default(false),
	visibility: text("visibility").notNull().default("public"), // public | subscribers_only | gated
	isPublished: boolean("is_published").default(false),

	// Text post metadata
	estimatedReadMinutes: integer("estimated_read_minutes"),

	// ATProto
	atprotoUri: text("atproto_uri").unique(),

	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
	projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
	postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
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
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
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
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		score: integer("score").notNull(), // 1-5, validated at application layer
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_ratings_user_project").on(table.userId, table.projectId)],
);
