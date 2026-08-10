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
 *
 * These tables live on a **Work**, not a Post (migration `0010`). A Work referenced from
 * two Posts used to inherit each Post's gates independently, so the same bytes were
 * genuinely free via one and gated via the other. A gate belongs to the thing being gated.
 */
export interface AccessRow {
	/** Whole Seeds required to qualify for this row. 0 = everyone. */
	threshold: number;
	allow: boolean;
	/** Money string; "0" = free at this threshold when allowed. */
	price: string;
}

/** A row in a Work's **Anthers Access** table — `threshold` is Anthers-Seeds held. */
export type AnthersAccessRow = AccessRow;

/** A row in a Work's **Seed Access** table — `threshold` is Seeds given to the creator. */
export type SeedAccessRow = AccessRow;

/** How precise a Work's creator-asserted Created date is. */
export type AuthoredPrecision = "year" | "month" | "day";

/**
 * Works — the creator's **Catalog**, and the unit of published creative work.
 *
 * A Work is a game, a video, a track, an image, an essay, a piece of software, a physical
 * good or a service. It owns everything about itself: its source media and derived
 * variants (`assets`, `transcoding_jobs`), its access gates, its delivery switches, its
 * dates, and the Time Pool minutes it earns. It has its own public URL and stands alone —
 * a Work can be released, gated, discussed and paid for with **no Post ever existing**.
 *
 * This replaced `content_items` in migration `0010`. That table was a *private media
 * staging record*: invisible until referenced from a published Post, with no visibility,
 * no gates, no dates of its own and no URL. The rename tracks a change of entity, not of
 * label — see `40.08 Catalog and Posts` in the vault.
 *
 * Prose is a Work now (`type = "text"`, prose in `bodyHtml`). Under the old model rich
 * text was deliberately post-native and NOT a library item, which produced the model's
 * strangest rule — prose in a post body earned nothing while the same prose as a content
 * element earned. The rule was right; the earning form just had no home of its own.
 */
export const works = pgTable(
	"works",
	{
		id: serial("id").primaryKey(),
		// Nullable + SET NULL, and this one is load-bearing for a promise rather than for
		// tidiness. A **withdrawn** Work has to outlive its creator's account: account
		// deletion withdraws anything somebody bought rather than destroying it, and a
		// cascade here would delete it again three lines later when the user row goes —
		// silently taking away exactly what a buyer paid for.
		//
		// This is the same defect `0016` fixed on `purchases.work_id`, one level up: a
		// cascade that looks like cleanup and is actually the destruction of somebody
		// else's entitlement. Unpurchased Works are still deleted explicitly by
		// `eraseAccount`, so nothing is left orphaned that shouldn't be.
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// Stable, non-sequential public id — the durable part of the canonical URL
		// /works/{slug}-{publicId}; the slug may change on rename without breaking links.
		publicId: bigint("public_id", { mode: "number" }).notNull().unique(),
		slug: text("slug").notNull().unique(),
		// text | video | audio | image | game | software | physical | service
		type: text("type").notNull(),
		title: text("title").default(""),
		description: text("description").default(""),
		thumbnail: text("thumbnail").default(""), // poster/cover key or URL

		// ── Source media (only the fields relevant to `type` are populated) ──
		sourceKey: text("source_key").default(""), // uploaded video/audio/image source key
		embedUrl: text("embed_url").default(""), // game/software web embed
		durationSeconds: integer("duration_seconds"), // video/audio
		// type = "text": the prose itself. `body` is the plain-text shadow used for search;
		// `bodyHtml` is sanitized server-side at the write boundary, as post bodies are.
		body: text("body").default(""),
		bodyHtml: text("body_html").default(""),
		estimatedReadMinutes: integer("estimated_read_minutes"),
		// Browser-encode transport (metadata.clientVariants) + physical/service product
		// details. Full variant/SKU modelling lands when merch/fulfillment is real; for now
		// downloadable variants (game/software builds) live in `assets`.
		metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

		// ── Visibility ──
		// private = staging (uploaded, processing, being written — nobody else's business).
		// released = publicly listed in the Catalog, which is NOT the same as freely
		// accessible: what it costs and who can reach it is the job of the gates below.
		// withdrawn = taken out of public circulation but STILL SERVED to people who
		// bought it (`0017`). It exists because deleting a purchased Work was the only
		// way to remove one, and that stranded its buyers — "if a user purchases
		// something, they own it, regardless of what the creator does down the line."
		// A creator cannot set this directly; it is what deleting a purchased Work does.
		// A fourth value `unlisted` is anticipated and deliberately not built yet.
		visibility: text("visibility").notNull().default("private"), // private | released | withdrawn
		releasedAt: timestamp("released_at", { withTimezone: true }),
		// When it left public circulation. Recorded rather than derived because the
		// retention model gives buyers a *funded rescue window* — notified, with time to
		// download, after which the Work is removed for real. That sweep is NOT built:
		// its duration and the notification mechanism are both open questions in the
		// privacy-policy work. Stamping the timestamp now is what makes the sweep a
		// later addition rather than a later migration.
		withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),

		// ── Dates ──
		// Three dates exist for a Work and the platform may only assert two of them.
		// `createdAt` is the UPLOAD date (ours, creator-visible only); `releasedAt` is when
		// it went public (ours); `authoredAt` is when the work was MADE — off-platform,
		// asserted by the creator, freely editable, and often long before Anthers existed.
		authoredAt: timestamp("authored_at", { withTimezone: true }),
		// Stored precision, so back-filling a 2015 project renders "2015" rather than an
		// invented 1 January. Null alongside a null authoredAt.
		authoredPrecision: text("authored_precision").$type<AuthoredPrecision>(),

		// ── Delivery (orthogonal; ≥1 enforced at the app layer) ──
		streamEnabled: boolean("stream_enabled").notNull().default(true),
		downloadEnabled: boolean("download_enabled").notNull().default(false),

		// ── Access tables (OR-gated — see services/access.ts) ──
		// Default = "free but fully locked": every row allow=false, price "0".
		anthersAccess: jsonb("anthers_access").$type<AnthersAccessRow[]>().default([]),
		seedAccess: jsonb("seed_access").$type<SeedAccessRow[]>().default([]),

		// ── Presentation & metadata ──
		isPinned: boolean("is_pinned").notNull().default(false),
		tags: jsonb("tags").$type<string[]>().default([]),
		websiteUrl: text("website_url").default(""),
		sourceUrl: text("source_url").default(""),

		// ── Counters (bigint — views/downloads can exceed int4 at scale) ──
		viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
		downloadCount: bigint("download_count", { mode: "number" }).notNull().default(0),

		// ── ATProto ──
		// A Work wants its own lexicon rather than riding a post record; deferred with
		// ATProto adoption itself, and unpopulated meanwhile.
		atprotoUri: text("atproto_uri").unique(),

		/** The UPLOAD date — when the Work entered the Catalog. Creator-visible only. */
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_works_creator").on(table.creatorId),
		index("idx_works_type").on(table.type),
		// The Catalog timeline: a creator's released Works in Created-date order.
		index("idx_works_catalog").on(table.creatorId, table.visibility, table.authoredAt),
		index("idx_works_released").on(table.visibility, table.releasedAt),
		uniqueIndex("uq_works_public_id").on(table.publicId),
	],
);

/**
 * Posts — announcements, and nothing more.
 *
 * A Post carries rich text, links and body-embedded images, and exists to talk to the
 * people who follow and support a creator. It carries **no media of its own beyond its
 * body** — no attachments, no content elements. Anything that is a *work* belongs in the
 * Catalog.
 *
 * A Post may **reference** Works (`post_work_refs`), which renders as a card and gives the
 * Work its posting history in return. That reference is **inert: it confers no access
 * whatsoever.** A Work linked from a Post is reachable exactly to the extent its own gates
 * allow, and a Post may freely link something the reader cannot open. This is what stops
 * the two concepts re-coupling through the back door.
 *
 * Because a Post is not a container, a Post earns no Time Pool minutes — unchanged policy,
 * but now for a structural reason rather than a rule.
 */
export const posts = pgTable(
	"posts",
	{
		id: serial("id").primaryKey(),
		// Nullable + SET NULL, same reasoning as `comments.userId`: a deleted account's
		// posts are TOMBSTONED rather than destroyed, because `DELETE /posts/:slug`
		// explicitly removes the comment thread with them — so hard-deleting a departing
		// user's posts would destroy THIRD PARTIES' contributions. A null creator drops
		// the post out of every creator-scoped listing (all of which filter on this
		// column) while leaving it readable at its own URL, which is exactly the
		// intended shape.
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "set null" }),
		// Stable, non-sequential public id — the durable part of the canonical URL
		// /posts/{slug}-{publicId}; the slug may change on rename without breaking links.
		publicId: bigint("public_id", { mode: "number" }).notNull().unique(),
		slug: text("slug").notNull().unique(),
		title: text("title").default(""),
		body: text("body").default(""),
		bodyHtml: text("body_html").default(""),

		// ── Presentation ──
		showOnTimeline: boolean("show_on_timeline").notNull().default(true),
		isPinned: boolean("is_pinned").notNull().default(false),

		// ── Metadata ──
		tags: jsonb("tags").$type<string[]>().default([]),
		isPublished: boolean("is_published").notNull().default(false),
		/**
		 * When the post actually went live — the feed's sort key.
		 *
		 * Added in `0010` to fix a latent bug: everything sorted by `createdAt`, which is
		 * when the DRAFT ROW was written, so a post drafted in January and published in
		 * March sorted as January — and `publish-scheduled` published without recording
		 * when. Null while unpublished; set once, on the transition to published.
		 */
		publishedAt: timestamp("published_at", { withTimezone: true }),
		// When set, a still-unpublished (draft) post auto-publishes at this time via the
		// publish-scheduled cron sweep. Cleared once the post publishes. Null = not scheduled.
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }),

		// ── Counters ──
		viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),

		// ── ATProto ──
		atprotoUri: text("atproto_uri").unique(),

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_posts_creator").on(table.creatorId),
		index("idx_posts_created").on(table.createdAt),
		// The post feed sorts on publication, not on when the draft row appeared.
		index("idx_posts_published").on(table.isPublished, table.publishedAt),
		uniqueIndex("uq_posts_public_id").on(table.publicId),
	],
);

/**
 * A Post's references to Works — the ONLY link between the two, and deliberately inert.
 *
 * Confers no access, no ownership and no media: it exists so a Post can show a card for
 * something in the Catalog, and so a Work can show where it has been posted (the "clean
 * record of when the content has been posted"). Replaced `post_contents` in `0010`, which
 * carried the opposite semantics — a post OWNED its content elements and gated them.
 */
export const postWorkRefs = pgTable(
	"post_work_refs",
	{
		id: serial("id").primaryKey(),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		position: integer("position").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_post_work_refs").on(table.postId, table.workId),
		index("idx_post_work_refs_post").on(table.postId, table.position),
		// The Work's posting history, newest first.
		index("idx_post_work_refs_work").on(table.workId, table.createdAt),
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
 * Projects — collections (playlist-like wrappers) that group a creator's things and give
 * them a rich custom showcase page. Not a content type; hold no content or pricing.
 * A project collects **both** Works and Posts, in separate ordered lists — a game project
 * holds its builds and soundtrack alongside its devlogs and patch notes.
 */
export const projects = pgTable(
	"projects",
	{
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
	},
	(table) => [index("idx_projects_creator").on(table.creatorId)],
);

/**
 * Many-to-many: which **Works** belong to which project, with ordering.
 *
 * The counterpart to `project_posts`, and the half that was always missing. A project
 * could only ever hold announcements, which meant an album could not hold its tracks —
 * 40.02's own worked example ("a track in both an album and a best-of") was not
 * expressible in the schema that document described.
 */
export const projectItems = pgTable(
	"project_items",
	{
		id: serial("id").primaryKey(),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_project_items").on(table.projectId, table.workId),
		index("idx_project_items_project").on(table.projectId, table.sortOrder),
		index("idx_project_items_work").on(table.workId),
	],
);

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

/** Downloadable files/variants (builds, tracks, PDFs, installers, …) of a Work. */
export const assets = pgTable(
	"assets",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		file: text("file").notNull(), // storage key
		filename: text("filename").notNull(),
		// bigint — a build/installer can exceed int4 (2.1 GB).
		fileSize: bigint("file_size", { mode: "number" }).default(0),
		mimeType: text("mime_type").default(""),
		platform: text("platform").default(""), // windows | mac | linux | web | … (games/software)
		version: text("version").default(""),
		isPrimary: boolean("is_primary").default(false),
		/**
		 * The P2P manifest's CONTENT half, per 45.04 — `{ assetSize, assetSha256, chunkSize,
		 * chunks }`. Null until built.
		 *
		 * Only the content half is stored, and the split is the spec's own: 45.04 makes a
		 * manifest immutable in `assetSha256` and `chunks`, while the identity fields it also
		 * carries (`workPublicId`, `assetFilename`, `assetMimeType`) can change without the
		 * bytes changing — a rename does exactly that. Freezing those into the row would
		 * serve a stale manifest after a rename, which contradicts the spec's "the hub always
		 * serves the current manifest". So they are composed at request time and only the
		 * part that is genuinely immutable is persisted.
		 *
		 * `assetSize` lives here as well as in `file_size` on purpose: this one is the size
		 * the hashes were computed over, so a later correction to `file_size` cannot
		 * silently invalidate the chunk boundaries.
		 */
		p2pManifest: jsonb("p2p_manifest").$type<{
			assetSize: number;
			assetSha256: string;
			chunkSize: number;
			chunks: string[];
		} | null>(),
		/** When the manifest above was built. Null whenever `p2p_manifest` is null. */
		p2pManifestBuiltAt: timestamp("p2p_manifest_built_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_assets_work").on(table.workId)],
);

/** Media processing for a Work (video HLS transcode, audio normalize) — runs once on
 *  upload to the Catalog, before the Work is released or referenced anywhere. */
export const transcodingJobs = pgTable(
	"transcoding_jobs",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
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
	(table) => [index("idx_transcoding_work").on(table.workId)],
);

/** Images embedded directly in a post body (or a text Work's prose) by the rich-text editor. */
export const inlineImages = pgTable(
	"inline_images",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		image: text("image").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_inline_images_creator").on(table.creatorId)],
);

/**
 * Comments, polymorphic over what they're attached to.
 *
 * A comment hangs off a **Post** (discussion of an announcement) or a **Work** (discussion
 * of the thing itself). Those are genuinely different conversations, and a Work needs its
 * own because it can be released, consumed and paid for with no post in sight — under the
 * old model a Work had nowhere for anyone to say anything.
 *
 * The `(subject_type, subject_id)` shape is copied from `moderation_reports` /
 * `moderation_actions`, deliberately: a third commentable kind should be a new *value*,
 * not a new column plus a branch in every query. The cost is the same one moderation
 * pays — no foreign key on the subject, so nothing cascades, and the read sites have to
 * resolve the subject themselves.
 */
export const comments = pgTable(
	"comments",
	{
		id: serial("id").primaryKey(),
		// Nullable + SET NULL: when an account is deleted its comments are TOMBSTONED,
		// not removed. 51.05 — "conversations other people took part in stay readable"; a
		// thread full of holes is worse for everyone still in it, and replies to a
		// vanished comment stop making sense. A null author renders "deleted by user",
		// which is deliberately distinguishable from a moderation removal (that is
		// `moderation_status`, and the two must never be confused — we do not say a user
		// deleted something they didn't).
		userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
		subjectType: text("subject_type").notNull().default("post"), // post | work
		subjectId: integer("subject_id").notNull(),
		body: text("body").notNull(),
		// Removal is a STATE, never a DELETE — see packages/db/src/schema/moderation.ts.
		// The row, its author and its text all survive being hidden; the who/why/when
		// lives in moderation_actions. Every public read filters on this.
		moderationStatus: text("moderation_status").notNull().default("visible"), // visible | hidden
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_comments_subject_visible").on(
			table.subjectType,
			table.subjectId,
			table.moderationStatus,
		),
		// Deleting an account has to find its comments; nothing indexed the author.
		index("idx_comments_user").on(table.userId),
	],
);

export const bookmarks = pgTable(
	"bookmarks",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
		workId: integer("work_id").references(() => works.id, { onDelete: "cascade" }),
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id").references(() => users.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	// Four nullable targets, every one a cascade parent: deleting a post, Work, project or
	// creator has to sweep the bookmarks pointing at it, and only `userId` was indexed.
	(table) => [
		index("idx_bookmarks_user").on(table.userId, table.sortOrder),
		index("idx_bookmarks_post").on(table.postId),
		index("idx_bookmarks_work").on(table.workId),
		index("idx_bookmarks_project").on(table.projectId),
		index("idx_bookmarks_creator").on(table.creatorId),
	],
);

/**
 * Reviews — a reader's verdict on a **Work**, and deliberately not on a Post.
 *
 * Unlike comments this is NOT polymorphic, because reviewing an announcement is a category
 * error: 63.01 defines a review as "a reader's verdict on a work", and 40.06 makes reviews
 * floor-level moderation precisely because "a creator moderating reviews of their own work
 * is the conflict reviews exist to avoid". Both sentences are about works. Giving reviews a
 * subject type would invite a shape the model has no meaning for.
 *
 * `workId` is nullable only to carry migration `0012`'s orphans: reviews that were left on
 * body-only posts, which had no Work to move to. Nothing reads them and no new write can
 * produce one — they are kept rather than deleted because destroying a user's words to fit
 * a schema change is the thing this codebase refuses to do elsewhere.
 */
export const ratings = pgTable(
	"ratings",
	{
		id: serial("id").primaryKey(),
		// Nullable + SET NULL: a deleted account's reviews are ANONYMISED, not removed.
		// A bare 1–5 score is the least personal thing in the system, and deleting it
		// would move a creator's average through no fault of theirs. The score stays and
		// counts; the link to a person goes.
		userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
		workId: integer("work_id").references(() => works.id, { onDelete: "cascade" }),
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
		// One review per person per Work. NULL workIds are the migration orphans above;
		// Postgres treats NULLs as distinct, so they don't collide with each other.
		uniqueIndex("uq_ratings_user_work").on(table.userId, table.workId),
		index("idx_ratings_work_visible").on(table.workId, table.moderationStatus),
	],
);
