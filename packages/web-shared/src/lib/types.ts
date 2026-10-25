// SPDX-License-Identifier: Apache-2.0
/**
 * Frontend type definitions matching the Hono API response shapes.
 *
 * All property names are camelCase, matching the Drizzle schema and Hono route
 * responses. This models the unified Post: everything a creator publishes is a
 * Post whose deliverable is an ordered array of typed content elements; access
 * type (stream/download) and the two access tables are orthogonal switches.
 * Projects group a creator's Works and Posts.
 */

import type { WorkType } from "@anthers/shared/content";
import type { ContentNote, MaturityRating, MaturityRows } from "@anthers/shared/content-rating";
import type { ShelfSortDirection, ShelfSortMode } from "@anthers/shared/project-shelf-sort";

// ─── User Types ───

export interface User {
	id: number;
	handle: string;
	email?: string; // Only in /me (private)
	displayName: string | null;
	bio: string | null;
	creatorMode: boolean | null;
	/**
	 * Whether this account is a creator — completed creator setup, answered on the server by
	 * `services/creator-standing`. Carried by the signed-in payloads and by listings, which
	 * compute it in the query.
	 *
	 * ⚠️ **Not the same claim as `creatorMode`.** Mode says the person turned the Studio on;
	 * this says they finished setting it up. A client that shows creator standing reads this
	 * one, and a client deciding whether to offer the Studio reads `creatorMode`.
	 */
	isCreator?: boolean;
	/** Whether this deployment can offer the Discord link at all. Private payloads only. */
	isDiscordAvailable?: boolean;
	/** Whether this account has linked its Discord identity. Private payloads only. */
	isDiscordLinked?: boolean;
	avatar: string | null;
	headerImage: string | null;
	websiteUrl: string | null;
	location: string | null;
	emailVerified?: boolean | null; // Only in /me (private)
	atprotoDid: string | null;
	createdAt: string;
}

export interface PublicUser extends User {
	followerCount: number;
	/** Size of the creator's public catalog (published posts). */
	projectCount: number;
	isFollowing: boolean;
	/**
	 * Work types this creator has released (`video`, `audio`, `text`, `game`, …).
	 * Derived from the Catalog, so it says what they make rather than what they claim.
	 * Only the creator listing populates it.
	 */
	mediums?: string[];
	/**
	 * The Badge ladder this creator set, ascending by threshold as the creator ordered it —
	 * only the creator listing populates it, and a creator who has configured no ladder
	 * ships an empty one (the signup finder draws no chips for them). The subset the
	 * signup card renders: every rung field a chip and its hover need, and never the
	 * private art path (see {@link CreatorBadge} for the full row those rules live on).
	 */
	badges?: SignupBadgeOption[];
}

/**
 * One rung of a creator's Badge ladder, as `GET /api/accounts/creators` ships it for the
 * signup finder's chips — see {@link CreatorBadge} for the full public-ladder row.
 */
export interface SignupBadgeOption {
	id: number;
	label: string;
	/** Monthly dollars; the numeric column reads back as text. */
	threshold: string;
	/** Whether the rung wears the creator's own art; false draws the fallback emblem. */
	hasArt: boolean;
	/** Ids into `@anthers/shared/badge-art`; null means the default. */
	artShape: string | null;
	artColor: string | null;
	/** The rung's perks, as the labels the creator wrote them as — what a chip's hover states. */
	perks: string[];
	/** The rung's own words, when the ladder carries them. */
	description: string | null;
}

export interface Creator {
	handle: string;
	displayName: string | null;
	avatar?: string | null;
	/** Whether this creator can receive direct-purchase payouts (connected + payouts enabled). */
	hasStripe?: boolean;
}

// ─── Access & pricing ───

/**
 * One row of a Work's access table — the SAME shape the API and the database hold. The
 * threshold is **monthly dollars**: what the user directs at this Work's creator, compared
 * to the cent. 0 = everyone, and it is the only row with no Badge.
 *
 * ⚠️ The column is `numeric` and the resolver compares dollars **to the cent**. A comment
 * here once claimed whole units, and the dev seeder built every gate at a third of its
 * value on the same misreading.
 */
export interface AccessRow {
	threshold: number;
	/** The creator's Badge rung this row gates at; absent on the Everyone baseline. */
	badgeId?: number | null;
	allow: boolean;
	price: string; // money string; "0" = free when allowed
}

/** One row of a Work's access table — the only name; see the column's own note. */

/** What a credit asserts about its role: a person or copyright-capable entity made it (`created`), or a machine did (`generated`). */
export type WorkCreditType = "created" | "generated";

/**
 * One row of a Work's credits — the creator saying who or what made which part. Public
 * liner notes. A `created` credit always names its contributor — whoever made the part,
 * however the publisher got it — while a pure `generated` row may stay anonymous. Mirrors `WorkCredit` in `packages/db/src/schema/content.ts` — the two are one
 * shape and change together, except for the two flag fields below, which the API's credit
 * overlay emits and no database stores.
 *
 * **Serialization rules for an identity credit** (a contributor that is a `did:` string in
 * storage): on the user-facing path, one that has been accepted by the person it names
 * ships with `contributor` resolved to their display name or handle — never a bare `did:`
 * string — and one that has not is withheld from every user except the two it belongs to.
 * The owner-facing path (the Studio load and create/PATCH responses) is the deliberate
 * exception: the edit form sends `contributor` back verbatim on save, so it always keeps
 * the stored identity — resolving it to a name there would overwrite the DID on the next
 * save and break the acceptance linkage.
 */
export interface WorkCredit {
	role: string;
	contributor: string;
	types: WorkCreditType[];
	/**
	 * The contributor presented as a person, when the stored contributor is a DID that
	 * resolves to one. Name, profile page and avatar ride here; `contributor` stays the
	 * stored (or, on the user shape, the resolved plain-text) value so the acceptance
	 * linkage round-trips. The DID itself is presented on hover or as subtext — it is
	 * still the credit's identity, never the headline.
	 */
	contributorProfile?: {
		/** The Anthers handle an account page answers; null when no account row resolves. */
		handle: string | null;
		displayName: string | null;
		/** A served avatar URL; null or "" when the account has none. */
		avatar: string | null;
	} | null;
	/**
	 * Present only when this credit names the user's own identity and awaits their
	 * confirmation. The user-facing serialization emits it so the front-end can render
	 * Accept/Decline controls; the credit ships with role and types intact because those
	 * are what the named person needs to act. Never stored.
	 */
	awaitingYourConfirmation?: true;
	/**
	 * Present only in an owner-facing serialization (the Studio load and create/PATCH
	 * responses), on a credit that names an on-network identity nobody has accepted yet.
	 * Tells the creator which of their credits are still pending the contributor's word.
	 * Never stored.
	 */
	awaitingContributorConfirmation?: true;
}

/**
 * One way a denied user could open a post. `moreNeeded` is the marginal ask — what
 * they still have to add — and it is computed server-side on purpose: the UI naming its
 * own Badge from a threshold is what produced a button offering a Badge that could not
 * clear the gate it sat above. `badge` is the Badge sitting EXACTLY at `threshold`, and it
 * is null whenever the caller passes no Badge set — which is every caller today.
 */
export interface UnlockRoute {
	threshold: number;
	moreNeeded: number;
	price: string;
	badge: string | null;
}

/**
 * How a gated post could be opened. Null = there is no way in short of a purchase.
 *
 * 🚨 **One route, matching the server's `UnlockOffer` exactly, and it did not until
 * 2026-08-29.** This declared a second, platform-side `anthers` route alongside —
 * which the server stopped emitting when those were retired on 2026-08-12. The field kept a
 * whole branch of `InlineUnlock` compiling, complete with an inline subscribe flow that could
 * never run, because a client type is not checked against the server's. **A hand-written
 * mirror that has grown a field the original lacks is dead code with a compiler's blessing.**
 *
 * It stays an object rather than collapsing to `UnlockRoute | null`, for the same reason the
 * server's does: a creator gating on **another creator's** support level is a shape the
 * access model leaves room for — nothing resolves it today, since every row is measured
 * against the Work's own creator — and that is where a second route would reappear.
 */
export interface UnlockOffer {
	creator: UnlockRoute | null;
}

/**
 * Resolved access for a post + user (see api services/access.ts).
 *
 * ⚠️ **`reason` is a hand-written mirror of the server's `AccessReason`, and it was three
 * values behind it** until 2026-08-28: `takedown`, `quarantined` and `adult_gated` all
 * reach a user in production and none of them existed here. Nothing broke, because every
 * consumer treats an unrecognized reason as "locked" and falling closed is the safe
 * direction — but a union that omits arrivable values makes every exhaustiveness check on
 * it a lie, which is a bad thing to be one refactor away from relying on. Adding a reason
 * on the server means adding it here.
 */
export interface AccessResult {
	canAccess: boolean;
	reason:
		| "owner"
		| "free"
		| "purchased"
		| "entitled"
		| "payment_required"
		| "gated"
		| "login_required"
		| "takedown"
		| "quarantined"
		| "adult_gated";
	isFree: boolean;
	requiresPurchase: boolean;
	price: string | null;
	isEntitled: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	/** Present only when `reason` is "gated" — see UnlockOffer. */
	unlock?: UnlockOffer;
}

/**
 * Which serialization a `Work["access"]` holds: the user's verdict, or the creator's
 * editable rows.
 *
 * `Work` is the ONE type for both serializations the server sends, so its `access` is a
 * union and this is the honest way to tell the halves apart — an array is the creator's
 * table (the owner shape, which the Studio edits) and an object is the resolver's verdict
 * (the user shape, which every reading surface consumes). Inline `Array.isArray` checks
 * blur the two again; reading through these keeps each call site saying which page it is.
 */
export function isAccessResult(
	access: AccessResult | AccessRow[] | null | undefined,
): access is AccessResult {
	return !!access && !Array.isArray(access);
}

/** The creator's editable access rows, or null when this serialization is a user's. */
export function accessRowsOf(
	access: AccessResult | AccessRow[] | null | undefined,
): AccessRow[] | null {
	return Array.isArray(access) ? access : null;
}

// ─── Content Types ───

/** Downloadable file (build, track, PDF, installer, …) attached to a content element. */
export interface Asset {
	id: number;
	workId: number;
	file: string;
	filename: string;
	fileSize: number | null;
	mimeType: string | null;
	platform: string | null;
	version: string | null;
	isPrimary: boolean | null;
	createdAt: string;
}

export interface WebBuildFile {
	id: number;
	buildId: number;
	/** The file's path within the build, exactly as the build resolves it. */
	path: string;
	/** Storage key — never a URL, and never handed to a viewer by this shape. */
	storageKey: string;
	fileSize: number | null;
	mimeType: string | null;
	createdAt: string;
}

export interface WebBuild {
	id: number;
	workId: number;
	/** The creator's own label telling two uploads apart. */
	label: string;
	/** The file the build loads first, relative to the build root — `index.html` for a Godot export. */
	entryPath: string;
	/** Whether the Work page frames this build; exactly one per Work. */
	isPrimary: boolean;
	/**
	 * Whether this build needs cross-origin isolation (a threaded export). Decides
	 * where it plays from: the server-rendered play page rather than the inline frame.
	 */
	requiresIsolation: boolean;
	files: WebBuildFile[];
	createdAt: string;
	updatedAt: string;
}

export interface TranscodingJob {
	id: number;
	workId: number;
	mediaType: string;
	status: string;
	progress: number | null;
	etaSeconds: number | null;
	/**
	 * The row's spot in its own type's media lane — 1 means next to run there — when
	 * it is waiting, null otherwise (running, settled, canceled, or a book outside the
	 * lanes). The queue figure's "N ahead of you" reads this, not a recomputed order.
	 */
	queuePosition: number | null;
	/**
	 * A waiting row's seconds until it reaches the front of the lane, kept by the same
	 * recompute that writes the position; null while nothing can be said. The total
	 * until done is `etaSeconds` on a pending row (front wait plus the row's own cost)
	 * and the running job's own remaining otherwise.
	 */
	queueEtaSeconds: number | null;
	errorMessage: string | null;
	/**
	 * The moment this tree first played — the smallest rung's upload (publish-early):
	 * the release gate opens while the tall rungs still encode, and this is what the
	 * display reads to say "Playable" where a progress figure would claim the wrong
	 * state. Null on every row that has not produced a playable tree yet.
	 */
	playableAt: string | null;
	hlsManifestUrl: string | null;
	/**
	 * The audio-only rendition of a video (`audio.m3u8`), serialized on the user
	 * shape only, and only when the rendition exists — the Podcast-This affordance
	 * keys on its presence.
	 */
	audioManifestUrl?: string | null;
	outputFileUrl: string | null;
	waveformData: number[] | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * One caption track on a video Work, as the player's `<track>` elements need it: the
 * route it plays from is always the access-checked captions endpoint, and the menu shows
 * `label` (which the serializer already falls back to the language). Absent on Work
 * shapes built from listings — only the detail payload carries tracks.
 */
export interface WorkCaptionTrack {
	id: number;
	language: string;
	label: string;
	kind: string;
	url: string;
	/**
	 * The row's size and cue count — the Studio editor's facts about what was uploaded.
	 * Owner-shape only; the reader's player payload omits them.
	 */
	byteSize?: number;
	cueCount?: number;
}

/**
 * One item in a Work's preview set — a screenshot or a trailer shown on the locked page
 * before a viewer unlocks it. `url` is the reachability-checked preview route, never a
 * storage key. A trailer carries its caption tracks; a screenshot carries its alt text.
 */
export interface PreviewMediaItem {
	id: number;
	kind: "image" | "video";
	alt: string;
	url: string;
	captions?: WorkCaptionTrack[];
}

/** A Work's type. `WORK_TYPES` in `@anthers/shared/content` is the authority on the list. */
export type ContentType = WorkType;

/**
 * Work types whose media is UPLOADED. A text Work is authored in place — its prose is the
 * deliverable — so it has no source file and never enters the upload/transcode path.
 */
export type UploadableWorkType = Exclude<ContentType, "text">;

/**
 * Where a Work sits relative to the public Catalog.
 *
 * `withdrawn` is not a state a creator sets — it is what deleting a *purchased* Work does
 * (migrations `0016`/`0017`), because a purchase outlives the Work it bought. It is
 * excluded from every public listing and still served to the people who own it.
 */
export type WorkVisibility = "private" | "released" | "withdrawn";

/**
 * A **release** in a saved catalog: the Project a Work belongs to, as the Library shelf
 * can describe it without fetching the Project's detail. The music lens groups saved
 * tracks under these, and a saved Project uses the same shape.
 */
export interface WorkRelease {
	id: number;
	slug: string;
	title: string;
	coverImage: string | null;
	creatorId: number | null;
	creatorHandle: string | null;
	creatorDisplayName: string | null;
	/** How many music Works the Project holds, among those this viewer may see. */
	musicCount: number;
	/** How many spoken-word Works it holds. The include-spoken dial adds these to a release. */
	audioCount: number;
}

/**
 * A **Work** — one entry in a creator's Catalog, and the unit of published creative work.
 *
 * It owns its media, downloadable variants (assets) and transcodes, AND its visibility,
 * dates, delivery switches and access gates. A Work stands alone: it can be released,
 * gated, purchased and consumed with no Post ever existing. Posts merely reference it.
 *
 * Two shapes come back from the API. The creator's own Catalog returns everything,
 * including the access tables they edit. A user-facing response returns the same
 * identity and metadata but blanks the media payload unless `access.canAccess` — a denied
 * user gets no pointer at the deliverable at all.
 */
export interface Work {
	id: number;
	publicId?: number;
	slug?: string;
	creatorId?: number;
	/**
	 * The creator's display surface, carried only by listings that organize **by** their
	 * creators — the Library shelf response attaches them at the route (the project arm
	 * has always carried the handle/name pair); `serializeWorkForUser` withholds them
	 * everywhere else. Present so a lens that groups the shelf by creator can label
	 * channels wholesale instead of fetching profiles per creator.
	 */
	creatorHandle?: string | null;
	creatorDisplayName?: string | null;
	creatorAvatar?: string | null;
	/**
	 * The published Projects this Work belongs to, carried only by the Library shelf
	 * response. A lens that groups saved tracks into releases reads this to find the
	 * Project a track came from without a request per Work; empty when the Work stands
	 * on its own.
	 */
	releases?: WorkRelease[];
	type: ContentType;
	title: string | null;
	description?: string | null;
	thumbnail: string | null;

	// Media payload — blanked (empty) by the API when the user lacks access.
	sourceKey: string | null;
	/**
	 * A video Work's original file, at its access-checked delivery route
	 * (`/works/:id/original`) — the day-one deliverable a play page falls back to
	 * before a ladder exists. Null for every other kind and for a user the
	 * Work's gate refuses; the meter bites at the route, not here.
	 */
	originalUrl?: string | null;
	embedUrl: string | null;
	durationSeconds: number | null;
	/** Prose, for `type: "text"`. Gated like any other payload. */
	body?: string | null;
	bodyHtml?: string | null;
	/**
	 * The song's words, for `type: "music"` — plain text, untimestamped, newline-separated.
	 *
	 * Gated exactly like `body`: a denied user gets `""`, because a gated track's words
	 * are part of what the support or purchase buys. The public blurb that survives a gate is
	 * `description`.
	 */
	lyrics?: string | null;
	/**
	 * The alt text of the image an image Work **is** — what a screen reader announces for
	 * the picture itself, falling back to the title when the creator wrote nothing.
	 *
	 * Gated with the payload like `body` (it describes pixels the gate withholds); a denied
	 * user gets `""`, but a denied user gets no image either, so nothing renders against it.
	 */
	imageAlt?: string | null;
	/**
	 * The images an image Work displays, in position order — the Work's source-set read
	 * back (`WorkSourceFile.file` values, which for the image kind are the display URLs
	 * the kind has always stored in `sourceKey`). A one-image Work carries the same
	 * single-picture list, so the Work page reads one field for both shapes; a denied
	 * user gets `[]`, gated exactly beside `imageAlt`. Absent on other kinds.
	 */
	gallery?: string[];
	/**
	 * The Work's storefront preview set, in carousel order — screenshots and trailers shown
	 * on the locked page (Parker, 2026-10-19). Absent on listing shapes, and empty on a kind
	 * whose page has no preview support. Preview media is storefront chrome: it travels to
	 * a locked viewer the Work itself is reachable by, and is never part of the Work's
	 * published listing.
	 */
	previewMedia?: PreviewMediaItem[];
	estimatedReadMinutes?: number | null;
	/**
	 * How many pages an ebook has, or 0.
	 *
	 * ⚠️ Present even when the Work is locked — a locked book can say "48 pages", the same
	 * way a locked video reports its duration. What a denied user never gets is a
	 * pointer at any page; those are served one at a time from `/works/:id/pages/:n`.
	 */
	pageCount?: number;
	/**
	 * How many **reflow** sections an ebook's EPUB ingest extracted, or 0 — the fixed
	 * page reader's counterpart to `pageCount`. Sections exist → the reflow reader
	 * (vendored foliate-js on the section/asset ladder); none → the page reader, exactly
	 * as a PDF-shaped ebook or a comic reads.
	 *
	 * ⚠️ Present even when the Work is locked, for the same reason `pageCount` is.
	 */
	sectionCount?: number;
	metadata: Record<string, unknown> | null;

	// Visibility & dates. `createdAt` is the UPLOAD date and is creator-facing only;
	// the public sees `originallyReleased` (when the work first came out, anywhere) and
	// `releasedAt` (when it came out here).
	visibility?: WorkVisibility;
	/** When a private Work is due to be released, if its creator scheduled one. Owner-facing. */
	scheduledReleaseAt?: string | null;
	releasedAt?: string | null;
	/** When it left public circulation. Only ever set alongside `visibility: "withdrawn"`. */
	withdrawnAt?: string | null;

	/**
	 * The content rating, and the notes describing what is in it.
	 *
	 * Both travel with the public blurb rather than with the payload — a warning that only
	 * appears once you already have the thing is not a warning — so they are present on
	 * every serialization, gated or not.
	 */
	maturity?: MaturityRating;
	maturityNotes?: ContentNote[];
	/**
	 * The rating matrix as its creator marked it; absent rows are unanswered. On the user's
	 * shape as well as the owner's, because a user's own filter covers by kind of content.
	 */
	maturityRows?: MaturityRows;
	/**
	 * Whether an operator set the rating. **Creator-facing only** — the user serialization
	 * withholds it, because a user able to read it could tell a corrected Work from a
	 * self-declared one. What it tells the creator is that lowering it takes an appeal.
	 */
	maturityLocked?: boolean;
	/** When the work first came out ANYWHERE, creator-asserted; null means "here first". */
	originallyReleased?: string | null;
	/**
	 * The credits — who or what made which part of it, as public liner notes. Ungated for
	 * every user; null/absent means none were asserted, which renders as nothing. A
	 * credit naming an on-network identity follows the serialization rules on `WorkCredit`:
	 * accepted ones resolve to a name, unaccepted ones reach only the person named and the
	 * Work's creator.
	 */
	credits?: WorkCredit[] | null;

	// Delivery & access. ONE field name, two shapes, matching what the server sends on
	// each serialization: the OWNER's shape carries the editable access table, and the
	// USER's carries the resolver's verdict. `accessOf` (below) tells them apart — never
	// test the value's shape inline, or the two serializations blur together again.
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	access?: AccessRow[] | null | AccessResult;
	/**
	 * Ungated, streaming, free to everyone — the commons. Derived server-side from the
	 * access table, never stored and never a creator-set flag: a Work with nothing on it
	 * IS Public Access. Says nothing about whether *this user* has monthly allowance
	 * left, which is an account-level meter and a separate call.
	 */
	publicAccess?: boolean;

	isPinned?: boolean;
	tags?: string[] | null;
	websiteUrl?: string | null;
	sourceUrl?: string | null;
	viewCount?: number;
	downloadCount?: number;
	/**
	 * The counts behind the Studio's Reviews column, on the owner's own Works listing.
	 *
	 * ⚠️ **Present only where the listing computes them** — a single Work read and every
	 * user-facing serialization omit the key, so the column is a listing surface and not a
	 * claim about the Work's payload. Both counts exclude hidden reviews, suspended
	 * reviewers and the automated-test account, the same set the Work page's aggregate
	 * counts.
	 */
	reviewCounts?: { recommended: number; notRecommended: number };

	/** Whether an access-resolved viewer may press play on the Work's hosted browser build. Absent on the owner shape (which has the builds themselves). */
	webPlayable?: boolean;
	/**
	 * Where play leads, when `webPlayable`: `"inline"` frames the minted address in
	 * place; `"page"` opens the server-rendered play page, which an isolation
	 * (threaded) build requires because a frame is isolated only when every ancestor
	 * is — and this SPA carries no response headers. Null when not playable.
	 */
	webPlayPath?: "inline" | "page" | null;
	assets: Asset[];
	/**
	 * The Work's browser builds — the owner-facing shape only. A build is one multi-file
	 * unit the Work page will frame; delivery itself is the hosting task's remaining half,
	 * so nothing here reaches a viewer yet.
	 */
	webBuilds?: WebBuild[];
	transcoding: TranscodingJob | null;
	/**
	 * The Work's caption tracks, when the payload carries them: gated with the video
	 * itself, so a locked Work reports none and a reachable Work reports its menu.
	 */
	captions?: WorkCaptionTrack[];
	/**
	 * When the CURRENT media version was added. The page shows it so a reader can tell a
	 * 2019 film uploaded yesterday from one updated last week; the creator's Versions tab
	 * puts the same date above the archive. Absent for a Work with no media.
	 */
	versionAddedAt?: string;
	createdAt?: string;
	updatedAt?: string;
	/**
	 * The Work's listing on the network while it has one. Present only in the owner's
	 * shape; absent or null means no listing, which is ordinary rather than a fault.
	 */
	atprotoUri?: string | null;
	/**
	 * The Work's public record link, as the record's own address on Taproot
	 * (`https://atproto.at/uri/{at-uri}`) — the one form a reader can follow. Carried by
	 * both shapes since the widening (2026-10-10): the record is public no matter who
	 * reads, so every reader who can see the Work sees this too. Null means no listing.
	 */
	recordUrl?: string | null;
}

/** One archived media version, as the creator's Versions list serializes it. */
export interface WorkMediaVersionSummary {
	id: number;
	/** When this media was added while it was current. */
	uploadedAt: string;
	/** When the next version replaced it. */
	archivedAt: string;
	kind: "source" | "set" | "builds";
	fileCount: number;
	totalBytes: number;
	/** Filenames and sizes only — storage keys never reach the client. */
	files: { filename: string; fileSize: number | null }[];
}

/**
 * A post's reference to a Work, as returned by post detail.
 *
 * Deliberately thin: the reference carries no access and no state of its own, so there is
 * nothing here but a position and the Work, each resolved on its own gates. A post the
 * user can read may well link a Work they cannot open.
 */
export interface PostWorkRef {
	position: number;
	work: Work;
}

/** Work create/patch input. */
export interface WorkInput {
	type?: ContentType;
	title?: string;
	slug?: string;
	description?: string;
	thumbnail?: string;
	sourceKey?: string;
	embedUrl?: string;
	durationSeconds?: number;
	body?: string;
	bodyHtml?: string;
	/** Untimestamped song lyrics (audio Works). Plain text — never HTML. */
	lyrics?: string;
	/** The alt text of the image an image Work is. Plain text — never HTML. */
	imageAlt?: string;
	metadata?: Record<string, unknown>;
	/**
	 * What a creator may SET. Deliberately narrower than `Work["visibility"]`:
	 * `withdrawn` is what deleting a purchased Work does, never something a creator
	 * chooses, so it has no place in an input type.
	 */
	visibility?: Exclude<WorkVisibility, "withdrawn">;
	/** A release time for a private Work; null clears it. */
	scheduledReleaseAt?: string | null;
	/**
	 * The rating matrix; a complete one decides the rating and the notes. It is the only way a
	 * creator rates a Work, and the API refuses a request naming `maturity` or `maturityNotes`
	 * with `rate_through_matrix`, so neither is on this type.
	 */
	maturityRows?: MaturityRows;
	originallyReleased?: string | null;
	/** The credits table; a full replace on save, like the access table beside it. */
	credits?: WorkCredit[];
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	access?: AccessRow[];
	isPinned?: boolean;
	tags?: string[];
	websiteUrl?: string;
	sourceUrl?: string;
}

/** One entry in the tag directory: a tag and how many released Works carry it. */
export interface TagCount {
	tag: string;
	works: number;
}

/** The universal content unit — full detail shape (GET /posts/:slug). */
export interface Post {
	id: number;
	publicId: number;
	creatorId: number;
	slug: string;
	title: string | null;
	/** The post's content, as markdown — the stored, canonical form (see `posts.body`). */
	body: string | null;

	// Presentation
	/** One pinned post per creator: pinning one clears the creator's others. */
	isPinned: boolean;

	// Metadata
	tags: string[] | null;
	isPublished: boolean | null;
	/** When the post actually went live — the feed's sort key. Null while unpublished. */
	publishedAt: string | null;
	/** ISO datetime a draft is scheduled to auto-publish at; null when not scheduled. */
	scheduledFor: string | null;
	viewCount: number;
	atprotoUri: string | null;
	/**
	 * The post's public record link — the record's own address on Taproot
	 * (`https://atproto.at/uri/{at-uri}`), the form a reader can follow (the widening
	 * task, 2026-10-10). Null while the post has no record, which is ordinary.
	 */
	recordUrl?: string | null;
	createdAt: string;
	updatedAt: string;

	// Joined on detail
	creator?: Creator;
	ratingAverage?: number | null;
	ratingCount?: number;
	/**
	 * The Works this post links. There is no post-level `access` — a post is an
	 * announcement and carries no gate; each Work resolves on its own.
	 */
	linkedWorks?: PostWorkRef[];
	/**
	 * The title with each `@`-mentioned Work's current name — what a reader sees.
	 * `title` is the stored form, whose mention text is only the fallback for a Work
	 * that no longer resolves.
	 */
	displayTitle?: string | null;
	/** The Works the title mentions, resolved for this reader, in first-appearance order. */
	mentionedWorks?: PostMentionedWork[];
	/** Transparent edit history (newest first), present on the detail endpoint. */
	edits?: PostEdit[];
}

/** A Work a post's title names, as the heading links it. */
export interface PostMentionedWork {
	publicId: number;
	slug: string;
	title: string;
}

/** One timestamped entry in a post's edit history. */
export interface PostEdit {
	editedAt: string;
	summary: string;
	changedFields: string[] | null;
}

/** Lighter serialization returned by the timeline endpoint (GET /posts). */
export interface PostListItem {
	id: number;
	publicId: number;
	slug: string;
	/**
	 * Null on a **tombstoned** post — the creator deleted their account and the post
	 * stayed so the discussion under it still reads. Tombstoned posts appear at their
	 * own URL only; every creator-scoped listing filters on this column and so excludes
	 * them by construction.
	 */
	creatorId: number | null;
	title: string | null;
	/** The title with each mentioned Work's current name — what a card shows. */
	displayTitle?: string | null;
	isPinned: boolean;
	tags: string[] | null;
	isPublished: boolean | null;
	publishedAt: string | null;
	scheduledFor?: string | null;
	viewCount: number;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	/** First linked Work's thumbnail, if any — thumbnails are public by design. */
	thumbnail: string | null;
	linkedWorkCount: number;
	/**
	 * The body as plain text, where a tile's band renders the content and the card
	 * renders nothing more — the field the feed entries and the posts listing carry
	 * (a post's body is public, a post carries no gate of its own).
	 */
	excerpt?: string | null;
}

/** A post as it appears inside a Project (GET /projects/:slug). */
export interface ProjectPost {
	id: number;
	publicId: number;
	slug: string;
	title: string | null;
	/** The title with each mentioned Work's current name — what the row shows. */
	displayTitle?: string | null;
	isPublished: boolean | null;
	publishedAt: string | null;
	sortOrder: number;
	creator?: Creator;
	access?: AccessResult;
	/**
	 * Ungated, streaming, free to everyone — the commons. Derived server-side from the
	 * access table, never stored and never a creator-set flag: a Work with nothing on it
	 * IS Public Access. Says nothing about whether *this user* has monthly allowance
	 * left, which is an account-level meter and a separate call.
	 */
	publicAccess?: boolean;
}

/** Project — a creator's named grouping of Works and Posts, with its own page. */
export interface Project {
	id: number;
	creatorId: number;
	slug: string;
	title: string;
	description: string | null;
	/** The cover this Project shows — an uploaded image, or the chosen Work's cover. */
	coverImage: string | null;
	/**
	 * The Work whose cover this Project wears, by reference; null when the cover is an
	 * uploaded image or there is none. The response's `coverImage` already resolves it,
	 * so a reader renders the cover and the editor only needs this to name the choice.
	 */
	coverWorkId?: number | null;
	pageConfig: Record<string, unknown> | null;
	/**
	 * How the Project's shelves read, saved from the sort dropdown on its page
	 * (2026-10-19). `manual` is the stored drag order and the default; the detail
	 * response arrives already sorted by these, so a reader renders `works` and
	 * `posts` in the order given.
	 */
	worksSortMode: ShelfSortMode;
	worksSortDirection: ShelfSortDirection;
	postsSortMode: ShelfSortMode;
	postsSortDirection: ShelfSortDirection;
	isPublished: boolean | null;
	atprotoUri: string | null;
	/**
	 * The project's public record link — the record's own address on Taproot, the form a
	 * reader can follow (the widening task, 2026-10-10). Null while there is no record,
	 * which is ordinary.
	 */
	recordUrl?: string | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	/** Member count (list endpoint). */
	postCount?: number;
	/** Ordered member posts (detail endpoint). */
	posts?: ProjectPost[];
	/**
	 * Ordered member Works (detail endpoint) — a full `Work` each, with `access` resolved
	 * for this user, plus the membership's own `sortOrder`.
	 *
	 * 🚨 **The API has always sent these and nothing could read them**, because this field
	 * did not exist: `GET /projects/:slug` serializes `project.works[]` in full, and
	 * `ProjectPage` rendered posts alone. The array was undeclared rather than discarded,
	 * which is why nothing ever failed and no error pointed at it — the JSON simply
	 * arrived and TypeScript had no name for it.
	 */
	works?: ProjectWork[];
	/** The works grid's summaries — the Studio's owner listing only; the public shape carries none. */
	worksSummary?: ProjectWorkSummary[];
}

/**
 * A Work as it appears in the Studio's Projects listing, beside the project block as a
 * thumbnail grid. A summary rather than the `Work` entire — the owner's Projects listing
 * carries it in one batched fetch, and the grid needs identity and state, not media
 * payload and access tables — and named separately from `works` on purpose: one field
 * name carrying two shapes is the serialization blur that bit post access before.
 */
export interface ProjectWorkSummary {
	id: number;
	publicId?: number;
	slug?: string;
	title: string | null;
	type: ContentType;
	thumbnail: string | null;
	visibility?: WorkVisibility;
	sortOrder: number;
}

/**
 * A Work as it appears inside a Project. The Work entire, plus its position on the shelf.
 *
 * Membership carries nothing else, and that is the model rather than an omission: a
 * Project is a shelf, so a reference that carried gates or a price would be the Project
 * owning the Work. Access here is the Work's own, resolved for this user.
 */
export interface ProjectWork extends Work {
	sortOrder: number;
}

/**
 * One comment in a thread, which is a reply when its subject is another comment.
 *
 * ⭐ **A reply is not a different kind of thing**, and there is no parent field: `subjectType`
 * is `comment` and `subjectId` is the comment it answers, which is the same fact the record on
 * the network carries. A thread arrives flat, in reading order, and is grouped by that alone.
 */
export interface Comment {
	id: number;
	/** Null exactly when `handle` is — the author deleted their account. */
	userId: number | null;
	/** `post` for a comment on a post, `comment` for a reply, and `work` only on older rows. */
	subjectType: string;
	subjectId: number;
	removed: false;
	body: string;
	atprotoUri: string | null;
	/**
	 * The comment's public record link — the record's own address on Taproot, the form a
	 * reader can follow (the widening task, 2026-10-10). Null while the comment has no
	 * record, which is ordinary. A removed entry carries neither field.
	 */
	recordUrl?: string | null;
	createdAt: string;
	/**
	 * 🚨 **Null when the author deleted their account**, and the server has always sent it
	 * that way — a tombstoned comment keeps its text so the conversation around it still
	 * reads, and the join that fetches the author finds nobody. Typing this as `string` was
	 * a promise the server never made, and it turned every renderer into a crash waiting for
	 * the first deleted account.
	 */
	handle: string | null;
	avatar: string | null;
	/** True exactly when `handle` is null. Says WHO left, never why. */
	deletedByAuthor?: boolean;
	/**
	 * The published score: upvotes minus downvotes, floored at zero.
	 *
	 * 🚨 **The raw counts are not sent and must not be reconstructed here.** One number is
	 * the whole contract — a dislike does visible work by pulling this down, and a pile-on
	 * gets no counter to run up. It is also the ranking key, so what a user sees is what
	 * ordered the thread.
	 */
	score: number;
	/**
	 * What the score is made of — present ONLY on a comment this user wrote.
	 *
	 * ⭐ An author gets the exact figures on their own words; everybody else gets the net.
	 * ⚠️ **Absent rather than null for everyone else**, which is why these are optional: the
	 * server does not send the keys at all, so a renderer that forgets to check gets
	 * `undefined` and draws nothing, rather than a confident `0 up, 0 down`.
	 */
	up?: number;
	down?: number;
	/**
	 * Pushed below the collapse threshold by users.
	 *
	 * ⚠️ **A third state, and never to be drawn like the other two.** A moderation removal
	 * arrives as a `RemovedComment` with nothing in it, and a tombstone is an author who
	 * deleted their account. This comment is here, readable, and folded — the crowd did it, not a
	 * moderator, and the UI has to say so.
	 */
	collapsed: boolean;
	/** What this user did: `up`, `down`, or nothing yet. */
	userVote: "up" | "down" | null;
}

/**
 * The place a comment removed by moderation was, sent only because replies beneath it are shown.
 *
 * 🚨 **No text, no author and no record address, by construction.** The server never sends them,
 * and a renderer should not reach for them: this says where the gap is and that it is a removal,
 * which is a different thing from an author who deleted their account.
 */
export interface RemovedComment {
	id: number;
	subjectType: string;
	subjectId: number;
	createdAt: string;
	removed: true;
}

/** What a thread is made of: comments, and the gaps removed ones left above their replies. */
export type ThreadComment = Comment | RemovedComment;

/** One written review: a verdict and the words that explain it. */
export interface Review {
	id: number;
	userId: number;
	/** `recommended` or `not-recommended`. An open set — render an unknown value as-is. */
	verdict: string;
	/**
	 * The reviewer's words. Always present here: only reviews with text are listed, and a
	 * verdict left on its own counts in the aggregate without appearing in this array.
	 */
	body: string;
	/**
	 * The review's public record link — the record's own address on Taproot, the form a
	 * reader can follow (the widening task, 2026-10-10). Null while there is no record,
	 * which is ordinary.
	 */
	recordUrl?: string | null;
	createdAt: string;
	handle: string;
	avatar: string | null;
	/**
	 * Users' judgment of this review, as a net floored at zero.
	 *
	 * ⭐ **Helpfulness sorts and never weights.** This moves a review up the list; it has
	 * no effect on the recommended share, where every visible review still counts once.
	 * The same number a post or a comment publishes — a reviewer sees their own raw
	 * counts the way a commenter does, through the vote read.
	 */
	score: number;
	/** What this user did to this review: `up`, `down`, or nothing yet. */
	userVote: "up" | "down" | null;
}

export interface ReviewAggregate {
	/**
	 * The share who recommended it, 0–100, or null when nobody has reviewed.
	 *
	 * ⚠️ A proportion rather than an average, because reviews carry a verdict rather
	 * than a score. Every visible review counts once.
	 */
	recommendedPercent: number | null;
	/** How many of `count` recommended it — the numerator, for "18 of 20". */
	recommended: number;
	count: number;
	/**
	 * The same share over the reviews from a recent window — the user's choice of week,
	 * month or year (default month). `recommendedPercent` is null when the window holds
	 * too few reviews to mean anything, distinguishable from All-Time's null.
	 */
	recent: {
		window: "week" | "month" | "year";
		recommendedPercent: number | null;
		recommended: number;
		count: number;
	};
	/** The user's own verdict, shown even if their review is hidden. */
	userVerdict: string | null;
	/** The user's own review text, so the form can open pre-filled for an edit. */
	userReview: string | null;
	/**
	 * Newest first from the server. The client's two sorts — Helpful by default and
	 * Newest as the alternative — are presentations of this one payload rather than two
	 * different answers.
	 */
	reviews: Review[];
}

export interface MediaUploadResponse {
	method: "presigned" | "direct";
	uploadUrl: string;
	/** Headers the client must echo on the PUT — carries `x-amz-acl`. Empty in local mode. */
	headers: Record<string, string>;
	key: string;
}

export interface DirectUploadResponse {
	key: string;
	url: string;
}

// ─── Payment Types ───

export interface StripeAccountStatus {
	hasAccount: boolean;
	stripeAccountId?: string;
	chargesEnabled: boolean | null;
	payoutsEnabled: boolean | null;
	onboardingComplete: boolean | null;
	/**
	 * Whether Stripe has received the account's submission at all — read live in the base
	 * shape too, because "pending" (submitted, not yet enabled) is otherwise
	 * indistinguishable from "incomplete" (rows exist, nothing Stripe-side yet), which is
	 * exactly the confusion the pending state renders.
	 */
	detailsSubmitted: boolean | null;
	/**
	 * Present only in the detail shape (`GET /stripe/onboard?detail=1`, the Payments tab):
	 * what Stripe itself still needs from this account, so "incomplete" can say what.
	 */
	requirements?: {
		currentlyDue: string[];
		pastDue: string[];
		pendingVerification: string[];
		disabledReason: string | null;
	};
	/** `settings.payouts.schedule` — null until Stripe has it. */
	schedule?: { interval: string; delayDays?: number | null } | null;
	/** The default external (bank) account, by name and last four. */
	externalAccount?: { bankName: string | null; last4: string | null } | null;
	/** The connected account's own balance, in minor units; null when unreadable. */
	balance?: {
		available: { amount: number; currency: string }[];
		pending: { amount: number; currency: string }[];
	} | null;
}

export interface CheckoutResponse {
	amount: string; // listed price — what the creator receives (pass-through)
	processingFee: string;
	creatorEarnings: string;
	/**
	 * Null since real tax calculation landed: the rate is resolved by Stripe Tax from the
	 * buyer's billing address at the Checkout Session, so there is no figure to quote —
	 * the buy surfaces say "calculated at checkout" and the session carries the number.
	 */
	buyerTotal: string | null;
	/** Null for the same reason as `buyerTotal` — the tax lives in the session. */
	salesTax: string | null;
	/**
	 * The Checkout Session's client secret — the browser mounts Checkout (elements mode)
	 * from it and confirms there. Null only on error.
	 */
	clientSecret: string | null;
}

export interface Purchase {
	id: number;
	buyerId: number;
	/**
	 * The Work this purchase permanently unlocks. Null for a support top-up, which unlocks
	 * nothing — and ALSO null once the Work is genuinely gone, since the FK is
	 * `ON DELETE SET NULL` (`0016`). It therefore cannot tell those two apart; `type` can.
	 */
	workId: number | null;
	/** What kind of charge this was. `seeds` bought no Work and belongs in no Library. */
	type: "digital" | "physical" | "service" | "seeds";
	amount: string;
	processingFee: string;
	creatorEarnings: string;
	stripePaymentIntentId: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * What was bought. `title`/`type` are the snapshot taken at the sale and survive the
	 * Work's removal; `slug`/`publicId`/`visibility`/`coverImage` come from the live row
	 * and go null with it. **A link may only be built when `publicId` is present** — that
	 * is the field that says a page still exists. All of them are null for a support top-up.
	 */
	work?: {
		title: string | null;
		slug: string | null;
		publicId: number | null;
		visibility: "private" | "released" | "withdrawn" | null;
		/** When the creator pulled it. The rescue window is counted from here. */
		withdrawnAt: string | null;
		coverImage: string | null;
		type: string | null;
	};
	creator?: Creator;
}

export interface OwnershipResponse {
	owns: boolean;
}

// ─── Subscription Types ───

/** The Anthers Badge vocabulary (per-post access rows include "free"). */
export type SubscriptionTier = "free" | "root" | "sprout" | "petal" | "blossom";

/** A user's Badge (= the monthly amount they give Anthers), held point-in-time. */
export type Badge = "free" | "root" | "sprout" | "petal" | "blossom";

/** A Badge rung (GET /subscriptions/anthers-badges) — its monthly amount + decomposition. */
export interface BadgeView {
	id: Badge;
	name: string;
	price: number;
	timePool: string;
	supportsAnthers: string;
	subsidized: boolean;
}

/**
 * The user's billing-machinery row (`billing_accounts`): what Stripe needs to charge and
 * reconcile. Nothing here is an amount the user gives — under the Badge model those
 * dollars are `user_badges` holdings, and `/subscriptions/me` reports the held Badge
 * beside this row.
 */
export interface Account {
	id?: number;
	userId?: number;
	isSelfHosting: boolean;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
	isActive: boolean | null;
	currentPeriodStart: string | null;
	currentPeriodEnd: string | null;
	canceledAt: string | null;
	createdAt?: string;
	updatedAt?: string;
}

/**
 * The buyer's **saved billing address** — opt-in, managed in the account settings, and
 * stored on the buyer's Stripe Customer record rather than on Anthers' servers (2026-10-11
 * decision). This is the shape `GET /api/accounts/me/billing-address` answers with and
 * `PUT` takes; checkout prefills its billing form from it and never writes back.
 */
export interface SavedBillingAddress {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
}

/** Response of GET /subscriptions/me — the billing row plus the Badge currently held. */
export interface AccountResponse {
	account: Account;
	anthersSupport: number;
	badge: Badge;
	badgeView: BadgeView;
}

export interface AttentionSummary {
	hoursUsed: number;
	eventCount: number;
	cycleStart: string;
}

export interface PoolDistribution {
	id: number;
	/** Null once that account is deleted — the payment record outlives both parties. */
	subscriberId: number | null;
	/** Null once that account is deleted; the row survives, the identity link does not. */
	creatorId: number | null;
	billingCycle: string;
	poolAmount: string;
	badgeAmount: string;
	attentionSeconds: number | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
}

export interface CreatorEarnings {
	poolTotal: string;
	badgeTotal: string;
	total: string;
	subscriberCount: number;
	cycle: string;
	/** False while the month is the nightly estimate; true once settlement has credited it. */
	settled: boolean;
	/**
	 * Settled money not yet transferred into the connected account — behind its 14-day
	 * hold or the account's readiness, and still owed. Lifetime, not per-cycle: a hold is
	 * counted from when each credit settled, not the month it was earned in.
	 */
	heldTotal: string;
	/** Money already transferred into the connected account (the transfer rows' total). */
	transferredTotal: string;
	/**
	 * What was recovered from this creator's earnings for sales that came back — a refund
	 * or chargeback after the money had reached them. Never a bill: recovery only ever
	 * came from earnings that were still held.
	 */
	nettedTotal: string;
	/** The not-yet-recovered remainder of returned money, still open against future earnings. */
	nettingOpenTotal: string;
}

/**
 * The account's storage reading — the shaped answer `GET /api/accounts/me/storage` serves,
 * mirrored from the API's own interface rather than re-declared so a field they carry
 * differently is caught at typecheck rather than at render.
 */
export interface StorageReading {
	/** The ruled allowance at this account's held Badge, in GiB. */
	allowanceGiB: number;
	/** Bytes held this cycle, across every purpose — the figure the allowance binds. */
	bytesUsed: number;
	/** The allowance-binding figure in GiB, one decimal. */
	giBUsed: number;
	/** Bytes remaining under the allowance, 0 when over. */
	bytesFree: number;
	/** Whether this account can buy overflow at cost — Root or above. */
	topUpEligible: boolean;
	/** The at-cost overflow estimate in dollars, "0.00" when within the allowance or ineligible. */
	overflowCost: string;
	/** Per-purpose lines; every known kind present, so a reader never defaults a key. */
	purposes: Record<string, number>;
	/** When this cycle's figure was sampled — null before the meter's first sweep saw the account. */
	sampledAt: string | null;
	/** The cycle the reading belongs to. */
	cycle: string;
}

/**
 * One Badge this user holds, this cycle — a discrete pick of a creator's rung.
 *
 * The holding names the Badge; its dollars are the Badge's threshold by construction,
 * which is why there is no amount field. `art*` are ids into `@anthers/shared/badge-art`
 * (null means the default); `hasArt` says whether the creator's own art should be drawn.
 */
export interface BadgeHolding {
	id: number;
	threshold: string;
	label: string;
	description: string | null;
	artShape: string | null;
	artColor: string | null;
	artEmblem: string | null;
	hasArt: boolean;
	billingCycle: string;
	createdAt: string;
	creator: {
		handle: string;
		displayName: string | null;
	};
}

/** Response of GET /subscriptions/my-badges — the Badges the user holds this cycle. */
export interface BadgeHoldingsResponse {
	badges: BadgeHolding[];
}

/** Response of GET /subscriptions/access/:postId (post-scoped access check). */
export interface ContentAccessResponse {
	access: boolean;
	reason: string;
	requiresPurchase: boolean;
	price: string | null;
	isEntitled: boolean;
	isFree: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
}

/**
 * One rung of a creator's Badge ladder (GET /subscriptions/badges?creator=…). There is no
 * `gateType`: every rung a creator defines is their own Badge, so the enum the
 * cross-issuer case used to live in has nothing left to distinguish.
 */
export interface CreatorBadge {
	id: number;
	creatorId: number;
	threshold: string;
	label: string;
	description: string | null;
	/**
	 * Whether this rung has the creator's own art.
	 *
	 * ⚠️ **A boolean, never the storage key.** The object is private and served through an
	 * access-checked route; handing a client the key would invite somebody to build a URL
	 * out of it and quietly move badge art onto a path nothing checks.
	 */
	hasArt: boolean;
	/** Whether the art is a composed Noun Project emblem (drives the artist credit). */
	hasComposedArt?: boolean;
	/**
	 * Who drew the emblem or art this rung wears, when a credit is recorded for it — the
	 * "flip the Badge over" line on the detail view. Present on the public ladder read;
	 * null when the rung wears only its fallback or uncredited own art.
	 */
	artistCredit?: {
		artistName: string;
		artistPermalink: string | null;
		attribution: string;
		licenseDescription: string;
	} | null;
	/** Ids into `@anthers/shared/badge-art`; null means the default. */
	artShape: string | null;
	artColor: string | null;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

/** Response of GET /subscriptions/badges — a creator's ladder. */
export interface CreatorBadgeListResponse {
	badges: CreatorBadge[];
}

export interface CreatorStatus {
	badge: Badge;
	badgeAmount: string;
	badges: CreatorBadge[];
	unlockedBadges: number[];
}

// ─── Notifications ──────────────────────────────────────────────────────────────

/**
 * One thing the app told a person — a row of the notifications feed.
 *
 * Shaped on `routes/accounts.ts`' `GET /me/notifications` response (the row's own shape,
 * dates as ISO strings). The `kind` is the stable machine value the server records; the
 * client never branches copy on it today — the title carries the sentence — but the icon
 * and the "read the whole sentence where it happened" render branch on `kind`, so it
 * travels.
 */
export interface NotificationItem {
	id: number;
	/** `essential` | `activity` */
	category: string;
	/** The stable machine value — `comment_reply`, `post_comment`, `work_review`, … */
	kind: string;
	title: string;
	body: string;
	/** App-relative path the item points at; empty string when there is nowhere to go. */
	linkPath: string;
	/** When the email actually went (the send succeeded), or null when it did not. */
	emailSentAt: string | null;
	/** When the person read it in the app, or null while unread. */
	readAt: string | null;
	createdAt: string;
}

/**
 * A delivery group's mode, as the client renders it: app feed only, email only, or both.
 * The names are the API's (`services/notifications.ts`), and an unrecognized value renders
 * as "both" — the default everything unwritten answers, so a future fourth mode degrades
 * to the noisier display rather than silently hiding mail the person is receiving.
 */
export type NotificationDeliveryMode = "app" | "email" | "both";

// ─── Analytics / Integration Types ───

export interface AnalyticsOverview {
	period: number;
	events: {
		total: number;
		views: number;
		plays: number;
		watches: number;
		reads: number;
		listens: number;
	};
	totalDurationHours: number;
	uniqueUsers: number;
	contentCounts: {
		projects: number;
		posts: number;
	};
}

/**
 * A row of the creator's content analytics.
 *
 * 🚨 **`work`, not `post`.** Attention is recorded against a Work — a post announces and is
 * never consumed — so every non-project row here is a Work, and the `post` label this said
 * until 2026-09-11 was a leftover from before the split that the Studio believed and built a
 * broken URL out of.
 */
export interface ContentAnalyticsItem {
	type: "work" | "project";
	/** The row id. Present for ordering and keying; never the thing a link is built from. */
	id: number | null;
	/** A Work's durable public address — what its URL is built from. Absent on a project. */
	publicId?: number | null;
	title: string | null;
	slug?: string;
	eventCount: number;
	totalDuration: number;
}

export interface TimeseriesEntry {
	date: string;
	views: number;
	plays: number;
	watches: number;
	reads: number;
	listens: number;
}

// ─── Traffic Types ───

/**
 * The creator's traffic, from the first-party pipeline (`/api/integrations/analytics/
 * traffic`). Reads beside attention analytics but is never merged with them: these
 * figures count visits, attention counts seconds, and putting one inside the other's
 * card is how "3,400 pageviews vs 40 hours" support questions are born.
 */
export interface CreatorTraffic {
	profileViews: number;
	topWorks: Array<{ workId: number | null; path: string; views: number }>;
	topProjects: Array<{ path: string; views: number }>;
}

export interface CreatorTrafficCards {
	shown: number;
	clicked: number;
	bySubject: Array<{ subjectKind: string; subjectId: number; shown: number; clicked: number }>;
}

export interface CreatorTrafficResponse {
	traffic: CreatorTraffic;
	cards: CreatorTrafficCards;
	/** The creator's page visits per day — the same day-shape the site-wide series uses. */
	series: Array<{ day: string; views: number; sessions: number | null }>;
	/** Visits to the creator's pages, split by referrer source. */
	sources: Array<{ source: string; views: number }>;
	period: number;
}

// ─── Hosting-subsidy Types ───

export interface CrfSubsidy {
	id: number;
	creatorId: number;
	billingCycle: string;
	estimatedHostingCost: string;
	creatorEarnings: string;
	subsidyAmount: string;
	storageBytes: number | null;
	projectCount: number | null;
	postCount: number | null;
	createdAt: string;
}
