// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Frontend type definitions matching the Hono API response shapes.
 *
 * All property names are camelCase, matching the Drizzle schema and Hono route
 * responses. This models the unified Post: everything a creator publishes is a
 * Post whose deliverable is an ordered array of typed content elements; access
 * type (stream/download) and the two access tables are orthogonal switches.
 * Projects group a creator's Works and Posts.
 */

// ─── User Types ───

export interface User {
	id: number;
	username: string;
	email?: string; // Only in /me (private)
	displayName: string | null;
	bio: string | null;
	isCreator: boolean | null;
	avatar: string | null;
	headerImage: string | null;
	websiteUrl: string | null;
	location: string | null;
	emailVerified?: boolean | null; // Only in /me (private)
	atprotoDid: string | null;
	atprotoHandle: string | null;
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
}

export interface Creator {
	username: string;
	displayName: string | null;
	avatar?: string | null;
	/** Whether this creator can receive direct-purchase payouts (connected + payouts enabled). */
	hasStripe?: boolean;
}

// ─── Access & pricing ───

/**
 * One row of a post's access table — the SAME shape for both tables (migration `0007`).
 * `threshold` is **monthly dollars**: what the viewer gives Anthers for the Anthers table,
 * what they direct at this creator for the creator table. 0 = everyone.
 *
 * ⚠️ It said "whole Seeds" until 2026-08-19 — the same wrong claim that had the dev seeder
 * building every gate at a third of its value. The column is `numeric` and the resolver
 * compares dollars to the cent.
 */
export interface AccessRow {
	threshold: number;
	allow: boolean;
	price: string; // money string; "0" = free when allowed
}

export type SeedAccessRow = AccessRow;

/**
 * One way a denied viewer could open a post. `moreNeeded` is the marginal ask — what
 * they still have to add — and it is computed server-side on purpose: the UI naming its
 * own Badge from a threshold is what produced a button offering a Badge that could not
 * clear the gate it sat above. `badge` is the Badge sitting EXACTLY at `threshold`, or
 * null when the gate falls between Badges (legal — a gate needn't sit on one).
 */
export interface UnlockRoute {
	threshold: number;
	moreNeeded: number;
	price: string;
	badge: string | null;
}

/** How a gated post could be opened, per destination. Null = that side offers no way in. */
export interface UnlockOffer {
	anthers: UnlockRoute | null;
	creator: UnlockRoute | null;
}

/** Resolved access for a post + viewer (see api services/access.ts). */
export interface AccessResult {
	canAccess: boolean;
	reason:
		| "owner"
		| "free"
		| "purchased"
		| "entitled"
		| "payment_required"
		| "gated"
		| "login_required";
	isFree: boolean;
	requiresPurchase: boolean;
	price: string | null;
	isEntitled: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	/** Present only when `reason` is "gated" — see UnlockOffer. */
	unlock?: UnlockOffer;
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

export interface TranscodingJob {
	id: number;
	workId: number;
	mediaType: string;
	status: string;
	progress: number | null;
	etaSeconds: number | null;
	errorMessage: string | null;
	hlsManifestUrl: string | null;
	outputFileUrl: string | null;
	waveformData: number[] | null;
	createdAt: string;
	updatedAt: string;
}

/** Content type discriminator. Text is post-native, not a library type — library items
 *  are the uploadable/processable types below. */
export type ContentType =
	| "text"
	| "image"
	/** A packaged multi-page document — a comic, a graphic novel, a prose book. */
	| "ebook"
	| "audio"
	| "video"
	| "game"
	| "software"
	| "physical"
	| "service";

/**
 * Work types whose media is UPLOADED. A text Work is authored in place — its prose is the
 * deliverable — so it has no source file and never enters the upload/transcode path.
 */
export type UploadableWorkType = Exclude<ContentType, "text">;

/** How precise a creator's asserted Created date is — rendered exactly as claimed. */
export type AuthoredPrecision = "year" | "month" | "day";

/**
 * Where a Work sits relative to the public Catalog.
 *
 * `withdrawn` is not a state a creator sets — it is what deleting a *purchased* Work does
 * (migrations `0016`/`0017`), because a purchase outlives the Work it bought. It is
 * excluded from every public listing and still served to the people who own it.
 */
export type WorkVisibility = "private" | "released" | "withdrawn";

/**
 * A **Work** — one entry in a creator's Catalog, and the unit of published creative work.
 *
 * It owns its media, downloadable variants (assets) and transcodes, AND its visibility,
 * dates, delivery switches and access gates. A Work stands alone: it can be released,
 * gated, purchased and consumed with no Post ever existing. Posts merely reference it.
 *
 * Two shapes come back from the API. The creator's own Catalog returns everything,
 * including the access tables they edit. A viewer-facing response returns the same
 * identity and metadata but blanks the media payload unless `access.canAccess` — a denied
 * viewer gets no pointer at the deliverable at all.
 */
export interface Work {
	id: number;
	publicId?: number;
	slug?: string;
	creatorId?: number;
	type: ContentType;
	title: string | null;
	description?: string | null;
	thumbnail: string | null;

	// Media payload — blanked (empty) by the API when the viewer lacks access.
	sourceKey: string | null;
	embedUrl: string | null;
	durationSeconds: number | null;
	/** Prose, for `type: "text"`. Gated like any other payload. */
	body?: string | null;
	bodyHtml?: string | null;
	/**
	 * The song's words, for `type: "audio"` — plain text, untimestamped, newline-separated.
	 *
	 * Gated exactly like `body`: a denied viewer gets `""`, because a gated track's words
	 * are part of what the Seed or purchase buys. The public blurb that survives a gate is
	 * `description`.
	 */
	lyrics?: string | null;
	estimatedReadMinutes?: number | null;
	/**
	 * How many pages an ebook has, or 0.
	 *
	 * ⚠️ Present even when the Work is locked — a locked book can say "48 pages", the same
	 * way a locked video reports its duration. What a denied viewer never gets is a
	 * pointer at any page; those are served one at a time from `/works/:id/pages/:n`.
	 */
	pageCount?: number;
	metadata: Record<string, unknown> | null;

	// Visibility & dates. `createdAt` is the UPLOAD date and is creator-facing only;
	// the public sees `authoredAt` (when the work was MADE) and `releasedAt`.
	visibility?: WorkVisibility;
	releasedAt?: string | null;
	/** When it left public circulation. Only ever set alongside `visibility: "withdrawn"`. */
	withdrawnAt?: string | null;
	authoredAt?: string | null;
	authoredPrecision?: AuthoredPrecision | null;

	// Delivery & access (creator-facing tables; viewers get the resolved `access`).
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	seedAccess?: SeedAccessRow[] | null;
	access?: AccessResult;
	/**
	 * Ungated, streaming, free to everyone — the commons. Derived server-side from the
	 * access table, never stored and never a creator-set flag: a Work with nothing on it
	 * IS Public Access. Says nothing about whether *this viewer* has monthly allowance
	 * left, which is an account-level meter and a separate call.
	 */
	publicAccess?: boolean;

	isPinned?: boolean;
	tags?: string[] | null;
	websiteUrl?: string | null;
	sourceUrl?: string | null;
	viewCount?: number;
	downloadCount?: number;

	assets: Asset[];
	transcoding: TranscodingJob | null;
	createdAt?: string;
	updatedAt?: string;
}

/**
 * A post's reference to a Work, as returned by post detail.
 *
 * Deliberately thin: the reference carries no access and no state of its own, so there is
 * nothing here but a position and the Work, each resolved on its own gates. A post the
 * reader can read may well link a Work they cannot open.
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
	metadata?: Record<string, unknown>;
	/**
	 * What a creator may SET. Deliberately narrower than `Work["visibility"]`:
	 * `withdrawn` is what deleting a purchased Work does, never something a creator
	 * chooses, so it has no place in an input type.
	 */
	visibility?: Exclude<WorkVisibility, "withdrawn">;
	authoredAt?: string | null;
	authoredPrecision?: AuthoredPrecision | null;
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	seedAccess?: SeedAccessRow[];
	isPinned?: boolean;
	tags?: string[];
	websiteUrl?: string;
	sourceUrl?: string;
}

/** The universal content unit — full detail shape (GET /posts/:slug). */
export interface Post {
	id: number;
	publicId: number;
	creatorId: number;
	slug: string;
	title: string | null;
	body: string | null;
	bodyHtml: string | null;

	// Presentation
	showOnTimeline: boolean;
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
	/** Transparent edit history (newest first), present on the detail endpoint. */
	edits?: PostEdit[];
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
	showOnTimeline: boolean;
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
}

/** A post as it appears inside a Project (GET /projects/:slug). */
export interface ProjectPost {
	id: number;
	publicId: number;
	slug: string;
	title: string | null;
	isPublished: boolean | null;
	publishedAt: string | null;
	sortOrder: number;
	creator?: Creator;
	access?: AccessResult;
	/**
	 * Ungated, streaming, free to everyone — the commons. Derived server-side from the
	 * access table, never stored and never a creator-set flag: a Work with nothing on it
	 * IS Public Access. Says nothing about whether *this viewer* has monthly allowance
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
	shortDescription: string | null;
	coverImage: string | null;
	pageConfig: Record<string, unknown> | null;
	isPublished: boolean | null;
	atprotoUri: string | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	/** Member count (list endpoint). */
	postCount?: number;
	/** Ordered member posts (detail endpoint). */
	posts?: ProjectPost[];
	/**
	 * Ordered member Works (detail endpoint) — a full `Work` each, with `access` resolved
	 * for this viewer, plus the membership's own `sortOrder`.
	 *
	 * 🚨 **The API has always sent these and nothing could read them**, because this field
	 * did not exist: `GET /projects/:slug` serializes `project.works[]` in full, and
	 * `ProjectPage` rendered posts alone. The array was undeclared rather than discarded,
	 * which is why nothing ever failed and no error pointed at it — the JSON simply
	 * arrived and TypeScript had no name for it.
	 */
	works?: ProjectWork[];
}

/**
 * A Work as it appears inside a Project. The Work entire, plus its position on the shelf.
 *
 * Membership carries nothing else, and that is the model rather than an omission: a
 * Project is a shelf, so a reference that carried gates or a price would be the Project
 * owning the Work. Access here is the Work's own, resolved for this viewer.
 */
export interface ProjectWork extends Work {
	sortOrder: number;
}

export interface Comment {
	id: number;
	userId: number;
	postId: number;
	body: string;
	atprotoUri: string | null;
	createdAt: string;
	username: string;
	avatar: string | null;
}

/** One written review: a score plus the words that justify it. */
export interface Review {
	id: number;
	userId: number;
	score: number;
	/** "" for rows written before reviews required text — render the score alone. */
	body: string;
	createdAt: string;
	username: string;
	avatar: string | null;
}

export interface RatingAggregate {
	average: number | null;
	count: number;
	/** The viewer's own score, shown even if their review is hidden. */
	userRating: number | null;
	/** The viewer's own review text, so the form can open pre-filled for an edit. */
	userReview: string | null;
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
}

export interface CheckoutResponse {
	amount: string; // listed price — what the creator receives (pass-through)
	processingFee: string;
	deliveryFee: string; // always "0.00" since 2026-08-12 — delivery is free
	crfFee: string; // Legacy field name; the retired purchase fee — always "0" since 2026-08-03
	creatorEarnings: string;
	buyerTotal: string; // price + fees — what the buyer is charged
	salesTax: string;
	clientSecret: string | null; // Stripe PaymentIntent client secret (null only on error)
}

export interface Purchase {
	id: number;
	buyerId: number;
	/**
	 * The Work this purchase permanently unlocks. Null for a Seed buy, which unlocks
	 * nothing — and ALSO null once the Work is genuinely gone, since the FK is
	 * `ON DELETE SET NULL` (`0016`). It therefore cannot tell those two apart; `type` can.
	 */
	workId: number | null;
	/** What kind of charge this was. `seeds` bought no Work and belongs in no Library. */
	type: "digital" | "physical" | "service" | "seeds";
	amount: string;
	processingFee: string;
	crfFee: string; // Legacy field name; the retired purchase fee — always "0" since 2026-08-03
	creatorEarnings: string;
	stripePaymentIntentId: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * What was bought. `title`/`type` are the snapshot taken at the sale and survive the
	 * Work's removal; `slug`/`publicId`/`visibility`/`coverImage` come from the live row
	 * and go null with it. **A link may only be built when `publicId` is present** — that
	 * is the field that says a page still exists. All of them are null for a Seed buy.
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

/** A Badge rung (GET /subscriptions/badges) — its monthly amount + decomposition. */
export interface BadgeView {
	id: Badge;
	name: string;
	price: number;
	timePool: string;
	supportsAnthers: string;
	subsidised: boolean;
}

/**
 * A user's account: the Seeds they've given Anthers (which are their Badge) + the Seeds
 * they've directed to creators.
 *
 * `bandwidthUsedGiB` is a **dead column**. It metered stream consumption against a
 * per-Seed allowance until 2026-08-12; delivery is free, nothing writes it, and it
 * stays only because dropping it is a migration of its own.
 */
export interface Account {
	id?: number;
	userId?: number;
	/**
	 * Monthly $ given to Anthers, as a **money string** — this is the raw row.
	 *
	 * 🚨 It was `anthersSeeds: number` (a count) until 2026-08-16, and a blanket rename
	 * would have left it typed `number` against a `numeric` column that arrives as
	 * "3.00". That is the shape that produces a silently wrong comparison — `"3.00" >= 3`
	 * is true by coercion, `"10.00" >= 9` is FALSE by string ordering — so the type has to
	 * say string and callers have to parse. `AccountResponse.anthersSupport` is the parsed
	 * number beside it, which is why both exist.
	 */
	anthersSupport: string;
	creatorSupportTotal: string;
	bandwidthUsedGiB: string;
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

/** Response of GET /subscriptions/me — the account plus the Badge it currently holds. */
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
	seedAmount: string;
	attentionSeconds: number | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
}

export interface CreatorEarnings {
	poolTotal: string;
	seedTotal: string;
	total: string;
	subscriberCount: number;
	cycle: string;
}

export interface SeedAllocation {
	id: number;
	userId: number;
	creatorId: number;
	amount: string;
	billingCycle: string;
	isLocked: boolean | null;
	atprotoUri: string | null;
	createdAt: string;
	updatedAt: string;
	creator?: {
		username: string;
		displayName: string | null;
	};
}

export interface SeedListResponse {
	seeds: SeedAllocation[];
	budget: string;
	allocated: string;
	remaining: string;
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

export interface CreatorGate {
	id: number;
	creatorId: number;
	gateType: "seed";
	threshold: string;
	label: string;
	description: string | null;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface CreatorStatus {
	badge: Badge;
	seedAmount: string;
	gates: CreatorGate[];
	unlockedGates: number[];
}

export interface Bookmark {
	id: number;
	userId: number;
	projectId: number | null;
	postId: number | null;
	creatorId: number | null;
	sortOrder: number;
	createdAt: string;
	project?: {
		title: string | null;
		slug: string;
		coverImage: string | null;
	} | null;
	post?: {
		title: string | null;
		slug: string;
		publicId?: number;
		contentType: string;
		thumbnail: string | null;
	} | null;
	creator?: {
		username: string;
		displayName: string | null;
		avatar: string | null;
	} | null;
}

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
	uniqueViewers: number;
	contentCounts: {
		projects: number;
		posts: number;
	};
	crossPublishCount: number;
}

export interface ContentAnalyticsItem {
	type: "post" | "project";
	id: number | null;
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

export interface PlatformConnection {
	id: number;
	platform: string;
	platformUserId: string | null;
	platformUsername: string | null;
	isActive: boolean | null;
	createdAt: string;
}

export interface CrossPublishResult {
	id: number;
	userId: number;
	platform: string;
	postId: number | null;
	externalId: string | null;
	externalUrl: string | null;
	status: string;
	errorMessage: string | null;
	publishedAt: string | null;
	createdAt: string;
	updatedAt: string;
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
