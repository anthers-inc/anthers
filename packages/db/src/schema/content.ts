// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * The two access tables are **one row shape**, and that is the point.
 *
 * A gate is a single primitive — *a whole-Seed threshold pointed at an entity*. Point it
 * at Anthers and it reads the viewer's Anthers-Seed count; point it at the creator and it
 * reads the Seeds that viewer has given *them* this cycle. Nothing else differs, so
 * nothing else should differ in the row.
 *
 * `threshold` is **whole Seeds in both tables** — never dollars, never a list position.
 * Migration `0007` converted both: the Anthers table from a tier *name* (free/root/…),
 * and the Seed table from *dollars* (÷ 3, Seeds being indivisible $3 units since #123).
 * Dollars leaked the price of a Seed into every stored gate; a name conflated a Badge
 * with the level it sits at. A threshold does neither, and a gate needs no Badge to sit
 * on it — with Badges at 2 and 4, a gate at 3 is legal and a 3-Seed viewer clears it.
 */
export interface AccessRow {
	/** Whole Seeds required to qualify for this row. 0 = everyone. */
	threshold: number;
	allow: boolean;
	/** Money string; "0" = free at this threshold when allowed. */
	price: string;
}

/** A row in a post's **Anthers Access** table — `threshold` is Anthers-Seeds held. */
export type AnthersAccessRow = AccessRow;

/** A row in a post's **Seed Access** table — `threshold` is Seeds given to the creator. */
export type SeedAccessRow = AccessRow;

/**
 * Posts — the universal, content-type-agnostic unit of published content.
 *
 * Everything a creator publishes is a Post. A post BODY (rich text) is shown to
 * anyone with visibility; the deliverable itself is an ordered array of typed
 * **content elements** (`post_contents`). Delivery (stream and/or download) and
 * access (the two OR-gated access tables) are orthogonal per-post switches.
 * Projects group posts; they are not a content type.
 */
export const posts = pgTable(
	"posts",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Stable, non-sequential public id — the durable part of the canonical URL
		// /posts/{slug}-{publicId}; the slug may change on rename without breaking links.
		publicId: bigint("public_id", { mode: "number" }).notNull().unique(),
		slug: text("slug").notNull().unique(),
		title: text("title").default(""),
		// The post BODY (rich text visible to anyone with visibility) — NOT the deliverable.
		body: text("body").default(""),
		bodyHtml: text("body_html").default(""),
		// Denormalized "primary" type for cards/badges/filtering, derived from the first
		// content element: text|image|audio|video|game|software|physical|service|mixed
		contentType: text("content_type").notNull().default("text"),
		// Denormalized card image (first element's thumbnail/image), set on save.
		thumbnail: text("thumbnail").default(""),

		// ── Access type (orthogonal delivery; ≥1 enforced at the app layer) ──
		streamEnabled: boolean("stream_enabled").notNull().default(true),
		downloadEnabled: boolean("download_enabled").notNull().default(false),

		// ── Access tables (OR-gated — see services/access.ts) ──
		// Default = "free but fully locked": every row allow=false, price "0".
		anthersAccess: jsonb("anthers_access").$type<AnthersAccessRow[]>().default([]),
		seedAccess: jsonb("seed_access").$type<SeedAccessRow[]>().default([]),

		// ── Presentation ──
		showOnTimeline: boolean("show_on_timeline").notNull().default(true),
		isPinned: boolean("is_pinned").notNull().default(false),

		// ── Metadata ──
		tags: jsonb("tags").$type<string[]>().default([]),
		websiteUrl: text("website_url").default(""),
		sourceUrl: text("source_url").default(""),
		estimatedReadMinutes: integer("estimated_read_minutes"),
		isPublished: boolean("is_published").notNull().default(false),
		// When set, a still-unpublished (draft) post auto-publishes at this time via the
		// publish-scheduled cron sweep. Cleared once the post publishes. Null = not scheduled.
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }),

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
		uniqueIndex("uq_posts_public_id").on(table.publicId),
	],
);

/**
 * Append-only log of post edits — one row per PATCH that changed a post's content, so an
 * edited post can show a transparent "Edited {date}" history. Stores a short summary of
 * which fields changed (not full diffs). Cascades with the post.
 */
export const postEdits = pgTable(
	"post_edits",
	{
		id: serial("id").primaryKey(),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		// Short human-readable summary of what changed, e.g. "body, title, access".
		summary: text("summary").notNull().default(""),
		// The changed field keys, for potential richer display later.
		changedFields: jsonb("changed_fields").$type<string[]>().default([]),
		editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_post_edits_post").on(table.postId, table.editedAt)],
);

/**
 * Content library — the creator's first-class, reusable content items. A creator
 * uploads content here once (processing runs async, no babysitting), then references
 * it from any number of posts via `post_contents`. The item OWNS its source media,
 * downloadable variants (`assets`), and transcodes (`transcoding_jobs`) — a post only
 * references it, so deleting a post never destroys content. Private to the creator
 * until a post/project makes it accessible. Rich text/prose is NOT a library item;
 * it stays post-native (the post body + inline text blocks in `post_contents`).
 */
export const contentItems = pgTable(
	"content_items",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// video | audio | image | game | software | physical | service
		type: text("type").notNull(),
		title: text("title").default(""),
		description: text("description").default(""),
		thumbnail: text("thumbnail").default(""), // poster/cover key or URL

		// ── Source media (only the field relevant to `type` is populated) ──
		sourceKey: text("source_key").default(""), // uploaded video/audio/image source key
		embedUrl: text("embed_url").default(""), // game/software web embed
		durationSeconds: integer("duration_seconds"), // video/audio
		// Browser-encode transport (metadata.clientVariants) + physical/service product
		// details. Full variant/SKU modelling lands when merch/fulfillment is real; for now
		// downloadable variants (game/software builds) live in `assets`.
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_content_items_creator").on(table.creatorId),
		index("idx_content_items_type").on(table.type),
	],
);

/**
 * A post's ordered content list. Each entry is either an inline TEXT block (post-native
 * prose) or a REFERENCE to a library content item. The post is the access point: a
 * referenced item inherits the post's access rules. Media/downloads/transcodes live on
 * the content item, never here — so a post can be deleted without destroying content.
 */
export const postContents = pgTable(
	"post_contents",
	{
		id: serial("id").primaryKey(),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		position: integer("position").notNull().default(0),
		// "text" (inline prose block) | "content" (reference to a library item)
		kind: text("kind").notNull().default("content"),
		bodyHtml: text("body_html").default(""), // kind = text
		contentItemId: integer("content_item_id").references(() => contentItems.id, {
			onDelete: "cascade",
		}), // kind = content
		caption: text("caption").default(""), // optional per-post caption for a content ref

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_post_contents_post").on(table.postId, table.position),
		index("idx_post_contents_item").on(table.contentItemId),
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

/** Downloadable files/variants (builds, tracks, PDFs, installers, …) of a content item. */
export const assets = pgTable(
	"assets",
	{
		id: serial("id").primaryKey(),
		contentItemId: integer("content_item_id")
			.notNull()
			.references(() => contentItems.id, { onDelete: "cascade" }),
		file: text("file").notNull(), // storage key
		filename: text("filename").notNull(),
		// bigint — a build/installer can exceed int4 (2.1 GB).
		fileSize: bigint("file_size", { mode: "number" }).default(0),
		mimeType: text("mime_type").default(""),
		platform: text("platform").default(""), // windows | mac | linux | web | … (games/software)
		version: text("version").default(""),
		isPrimary: boolean("is_primary").default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_assets_content_item").on(table.contentItemId)],
);

/** Media processing for a content item (video HLS transcode, audio normalize) — runs once
 *  on upload to the library, then every post that references the item reuses the output. */
export const transcodingJobs = pgTable(
	"transcoding_jobs",
	{
		id: serial("id").primaryKey(),
		contentItemId: integer("content_item_id")
			.notNull()
			.references(() => contentItems.id, { onDelete: "cascade" }),
		mediaType: text("media_type").notNull(), // video | audio
		status: text("status").notNull().default("pending"), // pending | processing | completed | failed
		progress: integer("progress").default(0),
		etaSeconds: integer("eta_seconds"), // estimated seconds remaining (video transcode; null when unknown/done)
		errorMessage: text("error_message").default(""),
		hlsManifestUrl: text("hls_manifest_url").default(""),
		outputFileUrl: text("output_file_url").default(""),
		waveformData: jsonb("waveform_data"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_transcoding_content_item").on(table.contentItemId)],
);

export const inlineImages = pgTable("inline_images", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	image: text("image").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const comments = pgTable(
	"comments",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		body: text("body").notNull(),
		// Removal is a STATE, never a DELETE — see packages/db/src/schema/moderation.ts.
		// The row, its author and its text all survive being hidden; the who/why/when
		// lives in moderation_actions. Every public read filters on this.
		moderationStatus: text("moderation_status").notNull().default("visible"), // visible | hidden
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_comments_post_visible").on(table.postId, table.moderationStatus)],
);

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
		// A score cannot be left without words — the API requires `body` on write.
		// It is nullable here only because rows predating that rule exist and must
		// keep rendering; treat "" / null as a legacy score-only review, never as a
		// shape new writes may produce. Plain text, not HTML: like comments, it is
		// rendered as a React text node and never passed through a sanitizer,
		// because nothing here is ever interpreted as markup.
		body: text("body"),
		// Same rule as comments: hidden, not deleted. A hidden review is excluded
		// from every average and count. Note the upsert only ever sets `score` and
		// `body`, so re-reviewing changes them on a hidden row without resurrecting
		// it — a user can't un-hide their own review by submitting again.
		moderationStatus: text("moderation_status").notNull().default("visible"), // visible | hidden
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_ratings_user_post").on(table.userId, table.postId),
		index("idx_ratings_post_visible").on(table.postId, table.moderationStatus),
	],
);
