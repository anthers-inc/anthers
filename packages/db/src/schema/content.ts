import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	serial,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const projects = pgTable(
	"projects",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: varchar("title", { length: 255 }).notNull(),
		slug: varchar("slug", { length: 255 }).notNull().unique(),
		description: text("description").default(""),
		shortDescription: varchar("short_description", { length: 300 }).default(""),
		mediaType: varchar("media_type", { length: 10 }).notNull().default("game"), // game | video | audio | text
		tags: jsonb("tags").default([]),
		isPublished: boolean("is_published").default(false),

		// Pricing
		pricingType: varchar("pricing_type", { length: 10 }).notNull().default("free"), // free | pwyw | paid
		price: numeric("price", { precision: 8, scale: 2 }),
		minPrice: numeric("min_price", { precision: 8, scale: 2 }),
		suggestedPrice: numeric("suggested_price", { precision: 8, scale: 2 }),

		// Display
		coverImage: varchar("cover_image", { length: 500 }).default(""),
		embedUrl: varchar("embed_url", { length: 500 }).default(""),

		// Metadata
		websiteUrl: varchar("website_url", { length: 500 }).default(""),
		sourceUrl: varchar("source_url", { length: 500 }).default(""),

		// Counters
		viewCount: integer("view_count").default(0),
		downloadCount: integer("download_count").default(0),

		// ATProto
		atprotoUri: varchar("atproto_uri", { length: 512 }).unique(),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
	image: varchar("image", { length: 500 }).notNull(),
	caption: varchar("caption", { length: 255 }).default(""),
	sortOrder: integer("sort_order").default(0),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const assets = pgTable("assets", {
	id: serial("id").primaryKey(),
	projectId: integer("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	file: varchar("file", { length: 500 }).notNull(),
	filename: varchar("filename", { length: 255 }).notNull(),
	fileSize: bigint("file_size", { mode: "number" }).default(0),
	mimeType: varchar("mime_type", { length: 100 }).default(""),
	platform: varchar("platform", { length: 50 }).default(""), // windows | mac | linux
	version: varchar("version", { length: 50 }).default(""),
	isPrimary: boolean("is_primary").default(false),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const posts = pgTable("posts", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
	title: varchar("title", { length: 255 }).default(""),
	body: text("body").default(""),
	bodyHtml: text("body_html").default(""),
	contentType: varchar("content_type", { length: 10 }).notNull().default("text"), // text | video | audio

	// Media fields
	videoFile: varchar("video_file", { length: 500 }).default(""),
	audioFile: varchar("audio_file", { length: 500 }).default(""),
	thumbnail: varchar("thumbnail", { length: 500 }).default(""),
	durationSeconds: integer("duration_seconds"),

	// Access control
	isPremium: boolean("is_premium").default(false),
	visibility: varchar("visibility", { length: 20 }).notNull().default("public"), // public | subscribers_only | gated
	isPublished: boolean("is_published").default(false),

	// Text post metadata
	estimatedReadMinutes: integer("estimated_read_minutes"),

	// ATProto
	atprotoUri: varchar("atproto_uri", { length: 512 }).unique(),

	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const transcodingJobs = pgTable("transcoding_jobs", {
	id: serial("id").primaryKey(),
	postId: integer("post_id")
		.notNull()
		.references(() => posts.id, { onDelete: "cascade" }),
	mediaType: varchar("media_type", { length: 10 }).notNull(), // video | audio
	status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | processing | completed | failed
	progress: integer("progress").default(0),
	errorMessage: text("error_message").default(""),
	hlsManifestUrl: varchar("hls_manifest_url", { length: 500 }).default(""),
	outputFileUrl: varchar("output_file_url", { length: 500 }).default(""),
	waveformData: jsonb("waveform_data"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const inlineImages = pgTable("inline_images", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	image: varchar("image", { length: 500 }).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const comments = pgTable("comments", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
	postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
	body: text("body").notNull(),
	atprotoUri: varchar("atproto_uri", { length: 512 }).unique(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
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
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("idx_bookmarks_user").on(table.userId, table.sortOrder),
	],
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
		score: smallint("score").notNull(), // 1-5, validated at application layer
		atprotoUri: varchar("atproto_uri", { length: 512 }).unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_ratings_user_project").on(table.userId, table.projectId)],
);
