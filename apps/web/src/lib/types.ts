// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Frontend type definitions matching the Hono API response shapes.
 *
 * All property names are camelCase, matching the Drizzle schema and Hono route
 * responses. This models the unified Post: everything a creator publishes is a
 * Post, with delivery (stream/download) and access (free/paid/gated) as
 * orthogonal switches; Projects are collections that group posts.
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
}

export interface Creator {
	username: string;
	displayName: string | null;
	avatar?: string | null;
}

// ─── Access & pricing ───

/** Resolved access for a post + viewer (see api services/access.ts). */
export interface AccessResult {
	canAccess: boolean;
	reason:
		| "owner"
		| "free"
		| "purchased"
		| "entitled"
		| "gated"
		| "payment_required"
		| "login_required";
	isFree: boolean;
	requiresPurchase: boolean;
	price: string | null;
	basePrice: string | null;
	pricingMode: string;
	minPrice: string | null;
	suggestedPrice: string | null;
	entitlementKind: string | null;
	entitlementDiscountPct: number | null;
	isEntitled: boolean;
}

// ─── Content Types ───

/** Gallery / screenshot image attached to a post. */
export interface GalleryImage {
	id: number;
	postId: number;
	image: string;
	caption: string | null;
	sortOrder: number | null;
	createdAt: string;
}

/** Downloadable file (build, track, PDF, installer, …) attached to a post. */
export interface Asset {
	id: number;
	postId: number;
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
	postId: number;
	mediaType: string;
	status: string;
	progress: number | null;
	errorMessage: string | null;
	hlsManifestUrl: string | null;
	outputFileUrl: string | null;
	waveformData: number[] | null;
	createdAt: string;
	updatedAt: string;
}

/** Content type discriminator. */
export type ContentType =
	| "text"
	| "image"
	| "audio"
	| "video"
	| "game"
	| "software"
	| "physical"
	| "service";

/** Timeline visibility. */
export type PostListing = "timeline" | "unlisted" | "shop";

/** The universal content unit — full detail shape (GET /posts/:slug). */
export interface Post {
	id: number;
	creatorId: number;
	slug: string;
	title: string | null;
	body: string | null;
	bodyHtml: string | null;
	contentType: string;

	// Delivery
	streamEnabled: boolean;
	downloadEnabled: boolean;

	// Stream payload / media
	videoFile: string | null;
	audioFile: string | null;
	coverImage: string | null;
	thumbnail: string | null;
	embedUrl: string | null;
	durationSeconds: number | null;

	// Access & pricing
	basePrice: string | null;
	pricingMode: string;
	minPrice: string | null;
	suggestedPrice: string | null;
	entitlementKind: string | null;
	entitlementTier: string | null;
	entitlementBoostThreshold: string | null;
	entitlementDiscountPct: number | null;
	purchasableWithoutEntitlement: boolean;

	// Presentation
	isPinned: boolean;
	listing: string;

	// Metadata
	tags: string[] | null;
	websiteUrl: string | null;
	sourceUrl: string | null;
	estimatedReadMinutes: number | null;
	isPublished: boolean | null;
	viewCount: number;
	downloadCount: number;
	atprotoUri: string | null;
	createdAt: string;
	updatedAt: string;

	// Joined on detail
	creator?: Creator;
	ratingAverage?: number | null;
	ratingCount?: number;
	galleryImages?: GalleryImage[];
	assets?: Asset[];
	transcodingJobs?: TranscodingJob[];
	access?: AccessResult;
}

/** Lighter serialization returned by the timeline endpoint (GET /posts). */
export interface PostListItem {
	id: number;
	slug: string;
	creatorId: number;
	title: string | null;
	contentType: string;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	coverImage: string | null;
	thumbnail: string | null;
	durationSeconds: number | null;
	listing: string;
	isPinned: boolean;
	tags: string[] | null;
	isPublished: boolean | null;
	viewCount: number;
	downloadCount: number;
	estimatedReadMinutes: number | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	access?: AccessResult;
	latestTranscodingStatus?: { status: string; progress: number } | null;
}

/** A post as it appears inside a collection (GET /projects/:slug). */
export interface CollectionPost {
	id: number;
	slug: string;
	title: string | null;
	contentType: string;
	coverImage: string | null;
	thumbnail: string | null;
	streamEnabled: boolean;
	downloadEnabled: boolean;
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

export interface RatingAggregate {
	average: number | null;
	count: number;
	userRating: number | null;
}

export interface MediaUploadResponse {
	method: "presigned" | "direct";
	uploadUrl: string;
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
	crfFee: string; // Legacy field name; represents Foundation Fee on direct purchases
	creatorEarnings: string;
	buyerTotal: string; // price + fees — what the buyer is charged
	clientSecret: string;
	message: string;
}

export interface Purchase {
	id: number;
	buyerId: number;
	postId: number;
	amount: string;
	processingFee: string;
	crfFee: string; // Legacy field name; represents Foundation Fee on direct purchases
	creatorEarnings: string;
	stripePaymentIntentId: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	post?: {
		title: string | null;
		slug: string;
		coverImage: string | null;
		contentType: string;
	};
	creator?: Creator;
}

export interface OwnershipResponse {
	owns: boolean;
}

// ─── Subscription Types ───

export type SubscriptionTier = "free" | "root" | "sprout" | "petal" | "bloom";

export interface SubscriptionTierOption {
	id: string;
	name: string;
	price: number;
	features: string[];
}

export interface Subscription {
	id?: number;
	userId?: number;
	tier: string;
	fundingLevel?: number;
	stripeCustomerId?: string | null;
	stripeSubscriptionId?: string | null;
	isActive: boolean | null;
	currentPeriodStart: string | null;
	currentPeriodEnd: string | null;
	canceledAt: string | null;
	createdAt?: string;
	updatedAt?: string;
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
	boostAmount: string;
	attentionSeconds: number | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
}

export interface CreatorEarnings {
	poolTotal: string;
	boostTotal: string;
	total: string;
	subscriberCount: number;
	cycle: string;
}

export interface BoostAllocation {
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

export interface BoostListResponse {
	boosts: BoostAllocation[];
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
	entitlementKind: string | null;
	entitlementDiscountPct: number | null;
}

export interface CreatorGate {
	id: number;
	creatorId: number;
	gateType: "boost" | "anthers_tier";
	threshold: string;
	label: string;
	description: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreatorStatus {
	anthersTier: string;
	fundingLevel: number;
	boostAmount: string;
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
		contentType: string;
		coverImage: string | null;
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

// ─── Foundation Types ───

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
