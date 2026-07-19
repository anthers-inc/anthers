// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access & entitlement resolution — the one place that answers
 * "may this user consume this post, and if not, what does it cost?"
 *
 * Access is expressed by two per-post tables (see `packages/db/src/schema/content.ts`):
 *   - `anthersAccess`: one row per Anthers Badge tier (free/root/sprout/petal/blossom)
 *   - `seedAccess`:    the $0 "everyone" baseline plus the creator's Seed-ladder rungs
 *
 * Each row is `{ allow, price }`. A viewer *qualifies* for a row when they meet its
 * Badge / Seed threshold. Access is the **OR** across BOTH tables: among the rows the
 * viewer qualifies for AND that are allowed, the cheapest price wins. price 0 = free;
 * a positive price = a one-time purchase that unlocks the post's enabled delivery
 * (stream and/or download — one price unlocks both). No qualifying allowed row is a
 * hard gate. Posts ship "free but fully locked" (every row allow=false).
 *
 * V4: the Anthers Gate is evaluated point-in-time — the viewer must *currently hold*
 * the required badge (`accounts.badge`), no trailing-spend window. Resolution reads
 * three viewer facts — held badge, per-creator Seeds this cycle, and prior purchases —
 * which `buildAccessContext` loads once so a batch (the timeline) resolves without an N+1.
 */

import { db } from "@anthers/db/client";
import type { AnthersAccessRow, SeedAccessRow } from "@anthers/db/schema";
import { accounts, purchases, seedAllocations } from "@anthers/db/schema";
import { type Badge, badgeRank, rankForSeeds } from "@anthers/shared/constants";
import { and, eq, inArray } from "drizzle-orm";

/** Anthers Badge tiers, low → high. */
export const TIER_ORDER = ["free", "root", "sprout", "petal", "blossom"] as const;

/** The post fields access resolution depends on (structurally satisfied by a full post row). */
export interface AccessiblePost {
	id: number;
	creatorId: number;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	anthersAccess: AnthersAccessRow[] | null;
	seedAccess: SeedAccessRow[] | null;
}

/** Viewer facts needed to resolve access, loaded once and reused across a batch of posts. */
export interface AccessContext {
	userId: number | null;
	/** The viewer's *currently held* Badge plan (point-in-time). */
	badge: Badge;
	/** creatorId → dollars of Seeds the viewer has given to that creator this cycle */
	seedByCreator: Map<number, number>;
	/** post ids the viewer has a completed purchase for */
	purchasedPostIds: Set<number>;
}

export type AccessReason =
	| "owner"
	| "free"
	| "purchased"
	| "entitled"
	| "payment_required"
	| "gated"
	| "login_required";

export interface AccessResult {
	/** May the viewer consume the content now? */
	canAccess: boolean;
	reason: AccessReason;
	/** Accessible to everyone at no cost. */
	isFree: boolean;
	/** A (one-time) purchase is the path to access. */
	requiresPurchase: boolean;
	/** Minimum price to unlock via purchase (money string), or null when free/gated. */
	price: string | null;
	/** Viewer qualifies via an allowed Badge/Seed row (a gate), even if a price still applies. */
	isEntitled: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
}

/** First day of the current month, `YYYY-MM-DD` — the billing-cycle key used across the app. */
export function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/** A user's currently held rank (point-in-time), derived from their Anthers-Seed count. */
export async function heldBadge(userId: number): Promise<Badge> {
	const [row] = await db
		.select({ anthersSeeds: accounts.anthersSeeds })
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);
	return rankForSeeds(Number(row?.anthersSeeds ?? 0));
}

function money(n: number): string {
	return (Math.round(n * 100) / 100).toFixed(2);
}

/** An allowed row the viewer qualifies for: its numeric price and whether it's a baseline (everyone) row. */
interface Offer {
	price: number;
	baseline: boolean;
}

/** Anthers-table offers the viewer qualifies for — the viewer must *currently hold* the row's tier. */
function anthersOffers(rows: AnthersAccessRow[], viewerBadge: Badge): Offer[] {
	const offers: Offer[] = [];
	const viewerRank = badgeRank(viewerBadge);
	for (const row of rows) {
		if (!row.allow) continue;
		const needRank = badgeRank(row.tier as Badge);
		// free tier (rank 0) qualifies for everyone; higher tiers need the held badge.
		if (viewerRank < needRank) continue;
		offers.push({ price: Number(row.price ?? "0"), baseline: needRank <= 0 });
	}
	return offers;
}

/** Seed-table offers the viewer qualifies for (Seeds given to this creator ≥ the rung threshold). */
function seedOffers(rows: SeedAccessRow[], viewerSeeds: number): Offer[] {
	const offers: Offer[] = [];
	for (const row of rows) {
		if (!row.allow) continue;
		if (viewerSeeds < row.threshold) continue;
		offers.push({ price: Number(row.price ?? "0"), baseline: row.threshold <= 0 });
	}
	return offers;
}

/**
 * Resolve access for a single post against an already-loaded viewer context.
 * Pure and synchronous, so the timeline can resolve a batch cheaply.
 */
export function resolveAccessSync(post: AccessiblePost, ctx: AccessContext): AccessResult {
	const base = {
		isFree: false,
		requiresPurchase: false,
		price: null as string | null,
		isEntitled: false,
		streamEnabled: post.streamEnabled,
		downloadEnabled: post.downloadEnabled,
	};

	// Creators always see their own content.
	if (ctx.userId != null && ctx.userId === post.creatorId) {
		return { ...base, canAccess: true, reason: "owner" };
	}

	// A prior purchase unlocks it permanently.
	if (ctx.purchasedPostIds.has(post.id)) {
		return { ...base, canAccess: true, reason: "purchased" };
	}

	const viewerSeeds = ctx.seedByCreator.get(post.creatorId) ?? 0;

	const offers = [
		...anthersOffers(post.anthersAccess ?? [], ctx.badge),
		...seedOffers(post.seedAccess ?? [], viewerSeeds),
	];

	// No qualifying allowed row → hard gate.
	if (offers.length === 0) {
		return { ...base, canAccess: false, reason: ctx.userId != null ? "gated" : "login_required" };
	}

	// Qualifies via a non-baseline (Badge/Seed) row → "entitled" for display.
	const isEntitled = offers.some((o) => !o.baseline);

	// Free when any qualifying allowed row is priced at/below 0.
	if (offers.some((o) => o.price <= 0)) {
		const universallyFree = offers.some((o) => o.baseline && o.price <= 0);
		return {
			...base,
			canAccess: true,
			reason: universallyFree ? "free" : "entitled",
			isFree: universallyFree,
			isEntitled,
		};
	}

	// Purchasable: cheapest qualifying allowed price unlocks the enabled delivery.
	const min = Math.min(...offers.map((o) => o.price));
	return {
		...base,
		canAccess: false,
		reason: "payment_required",
		requiresPurchase: true,
		price: money(min),
		isEntitled,
	};
}

/**
 * Load the viewer facts needed to resolve access. Pass the post ids in view to
 * scope the purchase lookup; omit for "all of the viewer's purchases".
 */
export async function buildAccessContext(
	userId: number | null,
	opts: { postIds?: number[] } = {},
): Promise<AccessContext> {
	if (userId == null) {
		return {
			userId: null,
			badge: "free",
			seedByCreator: new Map(),
			purchasedPostIds: new Set(),
		};
	}

	const cycle = currentBillingCycle();
	const scoped = opts.postIds && opts.postIds.length > 0;

	const [badge, seedRows, purchaseRows] = await Promise.all([
		heldBadge(userId),
		db
			.select({ creatorId: seedAllocations.creatorId, amount: seedAllocations.amount })
			.from(seedAllocations)
			.where(and(eq(seedAllocations.userId, userId), eq(seedAllocations.billingCycle, cycle))),
		db
			.select({ postId: purchases.postId })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, userId),
					eq(purchases.status, "completed"),
					...(scoped ? [inArray(purchases.postId, opts.postIds as number[])] : []),
				),
			),
	]);

	const seedByCreator = new Map<number, number>();
	for (const s of seedRows) {
		seedByCreator.set(s.creatorId, Number(s.amount));
	}

	return {
		userId,
		badge,
		seedByCreator,
		// Wallet/Seed one-time charges have a null postId — only real post purchases unlock.
		purchasedPostIds: new Set(
			purchaseRows.map((p) => p.postId).filter((id): id is number => id !== null),
		),
	};
}

/** Would an anonymous viewer get this post for free? Used for storage-ACL decisions in jobs. */
export function isPubliclyFree(post: AccessiblePost): boolean {
	const ctx: AccessContext = {
		userId: null,
		badge: "free",
		seedByCreator: new Map(),
		purchasedPostIds: new Set(),
	};
	return resolveAccessSync(post, ctx).isFree;
}

/** Convenience: resolve access for a single post (loads its own context). */
export async function resolveAccess(
	post: AccessiblePost,
	userId: number | null,
): Promise<AccessResult> {
	const ctx = await buildAccessContext(userId, { postIds: [post.id] });
	return resolveAccessSync(post, ctx);
}

/**
 * Default access tables for a freshly created post: every row present but locked
 * (allow=false, price "0") — "free but fully locked". The creator opts access in.
 */
export function defaultAnthersAccess(): AnthersAccessRow[] {
	return TIER_ORDER.map((tier) => ({ tier, allow: false, price: "0" }));
}

/** Default Seed table = just the $0 "everyone" baseline row, locked. Ladder rungs are added by the creator. */
export function defaultSeedAccess(): SeedAccessRow[] {
	return [{ threshold: 0, allow: false, price: "0" }];
}
