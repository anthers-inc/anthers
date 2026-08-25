// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content schema — see auth.ts for the role-classification legend (node/org/both).
 * Most of this file is node: a creator's own content records, media, and the
 * join tables that organize them. The exceptions are the polymorphic moderation
 * state columns (org-imposed) and the cross-account tables (library, bookmarks)
 * which are a *viewer's* records, not the creator's.
 */

import { sql } from "drizzle-orm";
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
 * A Work has **one access table**, and every row is a **monthly dollar** threshold pointed
 * at the Work's own creator.
 *
 * `threshold` is **dollars** — never a Seed count, never a list position. 🚨 It has been
 * through both units: dollars originally, whole Seeds from migration `0007` (because the
 * price of a Seed was otherwise baked into every stored gate), and dollars again from
 * `0041`, when **the Seed retired as a financial unit**. A creator sets their own levels
 * to any amount now, so there is no shared price left to leak — and storing Seeds would
 * instead bake in a conversion that no longer means anything. A gate needs no Badge to sit
 * on it: with Badges at $2 and $4, a gate at $3 is legal and a viewer giving $3 clears it.
 *
 * `threshold: 0` is the **baseline** row — everyone. It is what makes a Work free to all
 * (allow, price 0) or buyable by all (allow, price > 0), and it is not a gate at all.
 *
 * 🚨 **There were TWO tables until 2026-08-12**, and the second one is worth knowing about
 * because its disappearance is a model change rather than a refactor. `anthers_access`
 * read the viewer's *Anthers* Badge — "Sprout and above" — and access was the OR across
 * both. **Anthers Gates are retired**: they stratified the commons, producing better
 * public content behind a higher Badge beside worse public content that was actually
 * free, which is a class-of-citizen problem inside the one part of the platform that
 * exists in order not to have one. A Work is now either gated by its creator or it is
 * **Public Access** — ungated and streaming — and a Badge opens nothing. The reasoning is
 * kept in `30.01 Creator Content Gates` § 4.1b; the model is `11.01 Support Model Overview`.
 *
 * Migration `0029` folded that column in rather than dropping it: every *allowed* Anthers
 * row collapsed to threshold 0 at its cheapest price, so no Work was newly locked out.
 *
 * This table lives on a **Work**, not a Post (migration `0010`). A Work referenced from
 * two Posts used to inherit each Post's gates independently, so the same bytes were
 * genuinely free via one and gated via the other. A gate belongs to the thing being gated.
 */
export interface AccessRow {
	/** Monthly dollars required to qualify for this row. 0 = everyone. */
	threshold: number;
	allow: boolean;
	/** Money string; "0" = free at this threshold when allowed. */
	price: string;
}

/** A row in a Work's access table — `threshold` is monthly dollars given to the creator. */
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
// node — a creator's own Work, and the unit of their catalog. Node-canonical per 41.02
// ("Content records live on the creator node; org indexes"). The `takedownStatus`
// column is an org-imposed annotation on the row (a DMCA action), which is why this is
// `node` rather than `both`: the row's owner is the creator, and the org's flag is a
// column on someone else's record.
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
		// type = "audio": the song's words. **A column, not `metadata`** — lyrics are
		// creator-authored, reader-visible content, the same class of thing as `description`
		// and `body`, both of which are columns. `metadata` is for incidental shape
		// (`clientVariants`, a physical item's note), and burying published text in the
		// jsonb grab-bag makes it invisible to future search and to any migration that has
		// to reason about what a creator actually wrote.
		//
		// Deliberately **untimestamped**: no karaoke, no per-line sync, just the words
		// attached to the Work. Plain text rendered `white-space: pre-wrap` rather than
		// rich text — lyrics are line-broken text, and a rich-text surface here would
		// invite formatting nobody wants and a sanitizer nobody needs.
		//
		// 🚨 **Gated with the payload.** `serializeWorkForViewer` blanks this alongside
		// `body`/`bodyHtml`/`sourceKey`, because a gated track's words are as much the
		// deliverable as its audio. The failure is quiet in either direction, so the
		// asymmetry decided it: a creator who wants them public can put them in
		// `description`, which stays visible when locked — a creator who wanted them
		// private has no way to un-publish words already served.
		//
		// Stored for any type rather than only `audio` (which is how `bodyHtml` is
		// restricted to `text`), so that changing a Work's type cannot silently destroy
		// what someone wrote. Only audio Works display them.
		lyrics: text("lyrics").default(""),
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

		// ── Access table (see services/access.ts) ──
		// Default = "free but fully locked": the baseline row alone, allow=false, price "0".
		// The `anthers_access` column that sat beside this was folded in and dropped by
		// migration 0029 — see the AccessRow doc comment.
		seedAccess: jsonb("seed_access").$type<SeedAccessRow[]>().default([]),

		// ── Presentation & metadata ──
		isPinned: boolean("is_pinned").notNull().default(false),
		tags: jsonb("tags").$type<string[]>().default([]),
		websiteUrl: text("website_url").default(""),
		sourceUrl: text("source_url").default(""),

		// ── Counters (bigint — views/downloads can exceed int4 at scale) ──
		viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
		downloadCount: bigint("download_count", { mode: "number" }).notNull().default(0),

		// ── Takedown (DMCA) ──
		// A takedown is what WE did (a DMCA notice was acted on), distinct from
		// `visibility` (what the CREATOR did) and from `moderation_status` (the
		// hide/restore pattern on comments and ratings). A taken-down Work stops
		// delivery to EVERYONE, including buyers — continuing to serve infringing
		// bytes to buyers is continuing to infringe, which is the precise
		// distinction from `withdrawn` (which deliberately keeps serving buyers).
		//
		// `resolveAccessSync` checks this before every other rule, so every
		// delivery route that calls `resolveAccess` gets the denial for free —
		// one predicate, not seven routes remembering.
		takedownStatus: text("takedown_status").notNull().default("active"), // active | taken_down

		// ── Quarantine (child safety) ──
		// Set when reported or detected material is taken out of reach entirely. A third
		// state column beside the two above rather than a value inside either, because it
		// answers a different question and has to be able to be true at the same time as
		// both: a Work can be withdrawn by its creator, taken down on a DMCA notice, and
		// quarantined, and clearing any one of those must not clear the others.
		//
		// 🚨 **This is the one denial that reaches PURCHASERS.** `withdrawn` deliberately
		// keeps serving buyers, because a purchase outlives the Work. A takedown stops
		// serving them because continuing to deliver infringing bytes is continuing to
		// infringe. This stops serving them for the same shape of reason and a much
		// shorter one: the material may not be delivered to anybody, and a receipt is not
		// an exception to that. `resolveAccessSync` checks it before every other rule,
		// including the takedown — see `services/quarantine.ts`, its only writer.
		quarantineStatus: text("quarantine_status").notNull().default("none"), // none | quarantined

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
// node — a creator's own announcement. Same reasoning as `works`: node-canonical
// content, with `moderation_status` as an org-imposed annotation.
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
// node — a join between two node-owned tables (posts and works). Pure content
// relationship; the org indexes it but does not own it.
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
// node — a post's edit history, owned by the post's creator. Cascades with the post.
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
 * Projects — a creator's named groupings of Works and Posts around one subject, each with
 * its own page. Not a content type; hold no media and no pricing of their own.
 * A project collects **both** Works and Posts, in separate ordered lists — a game project
 * holds its builds and soundtrack alongside its devlogs and patch notes.
 */
// node — a creator's own project grouping. Node-canonical content record.
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
// node — join table, two node-owned parents (project + work).
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

/** Many-to-many: which posts belong to which Project, with ordering. */
// node — join table, two node-owned parents (project + post).
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

// node — a Work's downloadable files, owned by the Work's creator. Cascades with the
// Work.
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
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_assets_work").on(table.workId)],
);

/**
 * The pages of an **ebook** Work — a comic, a graphic novel, a prose book — one row per
 * rendered page, in order.
 *
 * 🚨 **Why pages exist as rows at all, when the creator uploaded one PDF.** The delivery
 * rule is that every derived media object is stored private and every URL to one is minted
 * per request at an endpoint that re-resolves access. A PDF is *one* object, so a reader
 * pointed at a signed URL for it has the whole book the moment it opens page one — which
 * makes `download_enabled: false` a lie for this medium specifically, and would surprise
 * a creator who had deliberately turned downloads off. Rendering to pages on upload is the
 * same shape as the HLS ladder: one source in, many private per-unit deliverables out,
 * each served through a check.
 *
 * It also makes the client *simpler* rather than heavier — the reader shows images, so no
 * PDF parser ships to the browser at all.
 *
 * **Ordering and identity are deliberate**, not incidental: panel-to-panel navigation is
 * deferred rather than dropped, and when it returns, panel regions hang off a page. A page
 * therefore needs a stable id and a stable number now, so that later work is an addition
 * rather than a migration.
 */
// node — an ebook Work's rendered pages. Node media, cascades with the Work.
export const workPages = pgTable(
	"work_pages",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		/** 1-based, matching how a reader counts and how `pdftoppm` numbers its output. */
		pageNumber: integer("page_number").notNull(),
		/** Private storage key. Never served directly — see `/works/:id/pages/:n`. */
		file: text("file").notNull(),
		width: integer("width"),
		height: integer("height"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_work_pages").on(table.workId, table.pageNumber),
		index("idx_work_pages_work").on(table.workId, table.pageNumber),
	],
);

// both — a transcoding job is node media processing (the creator's source → derived
// renditions), but it runs on org infrastructure (ffmpeg, the worker) and the org's
// delivery layer reads it. The row is node-owned (it is about one creator's Work); the
// org runs it. This is one of 41.02's "Media originals + renditions; transcoding →
// Creator node" entries, classified `both` because the *compute* is org while the
// *record* is node — the node owns the result, the org owns the execution.
export const transcodingJobs = pgTable(
	"transcoding_jobs",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		mediaType: text("media_type").notNull(), // video | audio | ebook
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

// node — images a creator embedded in their own post/work bodies. Cascades with the
// creator. The org serves them but does not own them.
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
// both — comments are polymorphic over (post|work) subjects. A creator's comments on
// their own content are node; a viewer's comments on someone else's content are the
// viewer's node. The `moderation_status` column is org-imposed. The row's author owns
// it, the subject's creator hosts it, and the org moderates it — three roles on one
// row, which is the `both` case the polymorphic shape exists to handle.
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

/**
 * The **Library** — the Works and Projects a user has kept.
 *
 * 🚨 **Curation, never entitlement.** `resolveAccess` must not read this table, and a row
 * here grants nothing: saving a free Work is a bookmark for something you could already
 * reach, not a purchase. If saving ever unlocked anything, "Save to Library" would be a
 * free unlock button, which is the worst defect this platform could ship. Entitlement
 * lives in `purchases` and only there.
 *
 * The consequence, which is correct and needs a real behaviour rather than a fix: **a free
 * Work you saved can later be gated by its creator.** It stays on your shelf and becomes
 * unplayable, exactly as a gated track sits in a queue — see `lib/music-queue.ts`, which
 * arrived at the same rule from the other direction.
 *
 * ## Why this table exists at all
 *
 * The Library used to be `/api/payments/purchases` with Seed buys filtered out — a receipt
 * list wearing a shelf's name. That worked while "yours" meant "paid for", and stopped
 * working the moment the commons did: **most of what a user loves on Anthers is free**, so
 * it was never purchasable and therefore had nowhere to live. Bookmarks half-covered it and
 * half-covered four other things. Parker's call (2026-08-13): one place, and that place is
 * the Library.
 *
 * ## Two rules that look like details and are not
 *
 * **A purchased Work is permanent.** It cannot be removed, only `hidden` — because a user
 * who tidies a purchase off their shelf and cannot work out how to get it back has
 * effectively lost the thing they paid for. Hiding is reversible from a toggle in the same
 * view; unsaving would be a black hole with a friendly label.
 *
 * **Permanence is DERIVED, never stored.** There is no `source` column saying "this one was
 * bought": that would be a second copy of a fact `purchases` already holds, and the two
 * would disagree the first time somebody refunded. A row is permanent exactly while a
 * completed purchase for that (user, Work) exists — so a refund, which removes the
 * entitlement, also releases the shelf entry in the same instant and with no sweep.
 *
 * Polymorphic over Work | Project in the same shape `bookmarks` uses, because **people keep
 * albums, not four loose tracks**: a Project is how an album exists here, so saving one has
 * to save the record rather than scatter it.
 */
// org — the Library is a *viewer's* shelf, not the creator's content. A viewer's
// account is org-side in the current topology (there is no viewer node; viewers are
// org accounts), so their saved items are org records. This is a disagreement with
// 41.02's boundary table, which lists "Content records" under the creator node — a
// library item is not a content record, it is a viewer's pointer to one, and the
// viewer has no node. See the findings written back to 41.02.
export const libraryItems = pgTable(
	"library_items",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Exactly one of these is set; enforced at the app layer, as `bookmarks` does.
		// Cascade is right here in a way it is NOT on `purchases.work_id`: a shelf entry
		// is a preference, not an entitlement, so it may go when its subject does.
		workId: integer("work_id").references(() => works.id, { onDelete: "cascade" }),
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		// Tidied off the shelf without being given up. Only ever set by the user, and the
		// only thing a purchased item's "remove" control is allowed to do.
		hidden: boolean("hidden").notNull().default(false),
		sortOrder: integer("sort_order").notNull().default(0),
		savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_library_user").on(table.userId, table.sortOrder),
		// Partial uniques, because the columns are nullable: a user saves a given Work or
		// Project once. Without the partial predicate a second null would collide.
		uniqueIndex("uq_library_work")
			.on(table.userId, table.workId)
			.where(sql`${table.workId} IS NOT NULL`),
		uniqueIndex("uq_library_project")
			.on(table.userId, table.projectId)
			.where(sql`${table.projectId} IS NOT NULL`),
		index("idx_library_work").on(table.workId),
		index("idx_library_project").on(table.projectId),
	],
);

/**
 * Bookmarks — **posts only**, in practice, since 2026-08-13.
 *
 * The four target columns remain because the rows do, but the product line is now one verb
 * per object: a Work or a Project is **saved** (to the Library), a creator is **followed**,
 * and a post is **bookmarked**. Two controls that sound like the same thing on one object
 * is what made both feel like half a feature.
 *
 * Migration `0035` moved every Work and Project bookmark into `library_items` and removed
 * the originals — a move, not a deletion, and the reason the columns are not dropped is
 * that dropping them is a separate migration with nothing to gain from being rushed.
 */
// org — bookmarks are a viewer's records (same reasoning as `libraryItems`: the
// viewer has no node in the current topology). The four target columns span content
// the viewer does not own, which is what makes this an org-side table about node
// content rather than a node table.
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
// both — a review is a viewer's verdict on a Work. The viewer is org-side (no viewer
// node); the Work is node-owned. The `moderation_status` is org-imposed. Same
// three-roles-on-one-row shape as `comments`: the author owns it, the subject's
// creator hosts it, the org moderates it.
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
