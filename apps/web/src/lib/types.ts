// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Frontend type definitions matching the Hono API response shapes.
 *
 * These replace the legacy snake_case interfaces from lib/api.ts.
 * All property names are camelCase, matching the Drizzle schema and Hono route responses.
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
	projectCount: number;
	isFollowing: boolean;
}

// ─── Content Types ───

export interface Screenshot {
	id: number;
	projectId: number;
	image: string;
	caption: string | null;
	sortOrder: number | null;
	createdAt: string;
}

export interface Asset {
	id: number;
	projectId: number;
	file: string;
	filename: string;
	fileSize: number | null;
	mimeType: string | null;
	platform: string | null;
	version: string | null;
	isPrimary: boolean | null;
	createdAt: string;
}

export interface Creator {
	username: string;
	displayName: string | null;
	avatar?: string | null;
}

export interface Project {
	id: number;
	creatorId: number;
	title: string;
	slug: string;
	description: string | null;
	shortDescription: string | null;
	mediaType: string;
	tags: string[];
	isPublished: boolean | null;
	pricingType: string;
	price: string | null;
	minPrice: string | null;
	suggestedPrice: string | null;
	coverImage: string | null;
	embedUrl: string | null;
	websiteUrl: string | null;
	sourceUrl: string | null;
	viewCount: number | null;
	downloadCount: number | null;
	atprotoUri: string | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	ratingAverage?: number | null;
	ratingCount?: number;
	assets?: Asset[];
	screenshots?: Screenshot[];
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

export interface Post {
	id: number;
	creatorId: number;
	projectId: number | null;
	title: string | null;
	body: string | null;
	bodyHtml: string | null;
	contentType: string;
	videoFile: string | null;
	audioFile: string | null;
	thumbnail: string | null;
	durationSeconds: number | null;
	isPremium: boolean | null;
	visibility: string;
	isPublished: boolean | null;
	estimatedReadMinutes: number | null;
	atprotoUri: string | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	transcodingJobs?: TranscodingJob[];
	accessGranted?: boolean;
}

/** Lighter serialization returned by list endpoints (no body/bodyHtml/files) */
export interface PostListItem {
	id: number;
	creatorId: number;
	projectId: number | null;
	title: string | null;
	contentType: string;
	thumbnail: string | null;
	durationSeconds: number | null;
	isPremium: boolean | null;
	visibility: string;
	isPublished: boolean | null;
	estimatedReadMinutes: number | null;
	createdAt: string;
	updatedAt: string;
	creator?: Creator;
	latestTranscodingStatus?: { status: string; progress: number } | null;
}

export interface Comment {
	id: number;
	userId: number;
	projectId: number | null;
	postId: number | null;
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
	amount: string;
	processingFee: string;
	crfFee: string; // Legacy field name; represents Foundation Fee on direct purchases
	creatorEarnings: string;
	clientSecret: string;
	message: string;
}

export interface Purchase {
	id: number;
	buyerId: number;
	projectId: number;
	amount: string;
	processingFee: string;
	crfFee: string; // Legacy field name; represents Foundation Fee on direct purchases
	creatorEarnings: string;
	stripePaymentIntentId: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	project?: {
		title: string;
		slug: string;
		coverImage: string | null;
	};
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

export interface ContentAccessResponse {
	access: boolean;
	reason: string;
	lowestThreshold?: string | null;
	currentBoost?: string;
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
		title: string;
		slug: string;
		coverImage: string | null;
		mediaType: string;
	} | null;
	post?: {
		title: string;
		contentType: string;
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
	type: "project" | "post";
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
	projectId: number | null;
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
	projectId: number;
	submittedById: number;
	createdAt: string;
	project?: {
		title: string;
		slug: string;
		coverImage: string | null;
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
