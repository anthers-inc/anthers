// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Frontend type definitions matching the Hono API response shapes.
 *
 * All property names are camelCase, matching the Drizzle schema and Hono route
 * responses. This models the unified Post: everything a creator publishes is a
 * Post whose deliverable is an ordered array of typed content elements; access
 * type (stream/download) and the two access tables are orthogonal switches.
 * Projects are collections that group posts.
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
 * `threshold` is whole Seeds: Anthers-Seeds held for the Anthers table, Seeds given to
 * this creator for the Seed table. 0 = everyone.
 */
export interface AccessRow {
	threshold: number;
	allow: boolean;
	price: string; // money string; "0" = free when allowed
}

export type AnthersAccessRow = AccessRow;
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

/** Whether a Work is still staging, or has been released to the public Catalog. */
export type WorkVisibility = "private" | "released";

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
	estimatedReadMinutes?: number | null;
	metadata: Record<string, unknown> | null;

	// Visibility & dates. `createdAt` is the UPLOAD date and is creator-facing only;
	// the public sees `authoredAt` (when the work was MADE) and `releasedAt`.
	visibility?: WorkVisibility;
	releasedAt?: string | null;
	authoredAt?: string | null;
	authoredPrecision?: AuthoredPrecision | null;

	// Delivery & access (creator-facing tables; viewers get the resolved `access`).
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	anthersAccess?: AnthersAccessRow[] | null;
	seedAccess?: SeedAccessRow[] | null;
	access?: AccessResult;

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
	metadata?: Record<string, unknown>;
	visibility?: WorkVisibility;
	authoredAt?: string | null;
	authoredPrecision?: AuthoredPrecision | null;
	streamEnabled?: boolean;
	downloadEnabled?: boolean;
	anthersAccess?: AnthersAccessRow[];
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

/** A post as it appears inside a collection (GET /projects/:slug). */
export interface CollectionPost {
	id: number;
	publicId: number;
	slug: string;
	title: string | null;
	isPublished: boolean | null;
	publishedAt: string | null;
	sortOrder: number;
	creator?: Creator;
	access?: AccessResult;
}

/** Project — a collection (playlist-like wrapper) that groups posts. */
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
	/** Ordered members (detail endpoint). */
	posts?: CollectionPost[];
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
	deliveryFee: string; // download bandwidth
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

/** The Anthers Badge / plan vocabulary (per-post access rows include "free"). */
export type SubscriptionTier = "free" | "root" | "sprout" | "petal" | "blossom";

/** A user's rank (= Anthers-Seed count), held point-in-time. */
export type Badge = "free" | "root" | "sprout" | "petal" | "blossom";

/** A rank rung (GET /subscriptions/badges) — Anthers-Seed count + its decomposition. */
export interface BadgeView {
	id: Badge;
	name: string;
	anthersSeeds: number;
	price: number;
	timePool: string;
	supportsAnthers: string;
	allowanceGiB: number;
	subsidised: boolean;
}

/** A user's account: the Seeds they've given Anthers (which are their Badge) + the Seeds they've
 *  directed to creators. Bandwidth is folded into the Anthers-Seeds — there is no wallet. */
export interface Account {
	id?: number;
	userId?: number;
	anthersSeeds: number;
	creatorSeedTotal: string;
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
	anthersSeeds: number;
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
	subscriberId: number;
	creatorId: number;
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
	gateType: "seed" | "anthers_badge";
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

// ─── Jam Types ───

export interface GameJam {
	id: number;
	creatorId: number;
	title: string;
	slug: string;
	description: string | null;
	theme: string | null;
	coverImage: string | null;
	startAt: string;
	endAt: string;
	votingEndAt: string;
	maxTeamSize: number | null;
	allowLateSubmissions: boolean | null;
	createdAt: string;
	updatedAt: string;
	creator?: {
		username: string;
		displayName: string | null;
	};
	entryCount?: number;
}

export interface JamEntry {
	id: number;
	jamId: number;
	postId: number;
	submittedById: number;
	createdAt: string;
	post?: {
		title: string | null;
		slug: string;
		coverImage: string | null;
		contentType: string;
	};
	submitter?: {
		username: string;
	};
	avgScore?: number;
	voteCount?: number;
}

export interface JamEntryResult extends JamEntry {
	rank: number;
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
