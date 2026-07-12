// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access & entitlement resolution — the one place that answers
 * "may this user consume this post, and if not, what does it cost?"
 *
 * Access is expressed by two per-post tables (see `packages/db/src/schema/content.ts`):
 *   - `anthersAccess`: one row per Anthers Badge tier (free/root/sprout/petal/blossom)
 *   - `boostAccess`:   the $0 "everyone" baseline plus the creator's boost-ladder rungs
 *
 * Each row is `{ allow, price }`. A viewer *qualifies* for a row when they meet its
 * Badge / boost threshold. Access is the **OR** across BOTH tables: among the rows the
 * viewer qualifies for AND that are allowed, the cheapest price wins. price 0 = free;
 * a positive price = a one-time purchase that unlocks the post's enabled delivery
 * (stream and/or download — one price unlocks both). No qualifying allowed row is a
 * hard gate. Posts ship "free but fully locked" (every row allow=false).
 *
 * Resolution reads three viewer facts — rolling Badge spend, per-creator boost this
 * cycle, and prior purchases — which `buildAccessContext` loads once so a batch (the
 * timeline) resolves without an N+1.
 */

import { db } from "@anthers/db/client";
import type { AnthersAccessRow, BoostAccessRow } from "@anthers/db/schema";
import { accountCycles, boostAllocations, purchases } from "@anthers/db/schema";
import { BADGE_THRESHOLDS } from "@anthers/shared/constants";
import { and, eq, inArray, sql } from "drizzle-orm";

/** Minimum combined Usage+Boost spend ($) each Anthers Badge tier requires. */
export const BADGE_MIN_SPEND: Record<string, number> = {
	free: 0,
	root: BADGE_THRESHOLDS.root,
	sprout: BADGE_THRESHOLDS.sprout,
	petal: BADGE_THRESHOLDS.petal,
	blossom: BADGE_THRESHOLDS.blossom,
};

/** Anthers Badge tiers, low → high. */
export const TIER_ORDER = ["free", "root", "sprout", "petal", "blossom"] as const;

/** The post fields access resolution depends on (structurally satisfied by a full post row). */
export interface AccessiblePost {
	id: number;
	creatorId: number;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	anthersAccess: AnthersAccessRow[] | null;
	boostAccess: BoostAccessRow[] | null;
}

/** Viewer facts needed to resolve access, loaded once and reused across a batch of posts. */
export interface AccessContext {
	userId: number | null;
	/** The viewer's rolling Badge spend (max combined spend across the trailing 3 cycles). */
	badgeSpend: number;
	/** creatorId → boost amount allocated to that creator this billing cycle */
	boostByCreator: Map<number, number>;
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
	/** Viewer qualifies via an allowed Badge/boost row (a gate), even if a price still applies. */
	isEntitled: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
}

/** First day of the current month, `YYYY-MM-DD` — the billing-cycle key used across the app. */
export function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/** The current cycle plus the two prior — the trailing-3-month Badge window. */
function last3Cycles(): string[] {
	const now = new Date();
	return [0, 1, 2].map((back) => {
		const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
	});
}

/** A user's rolling Badge spend: the highest combined spend across the trailing 3 cycles. */
export async function rollingBadgeSpend(userId: number): Promise<number> {
	const [row] = await db
		.select({ maxSpend: sql<string>`COALESCE(MAX(CAST(total_spend AS numeric)), 0)` })
		.from(accountCycles)
		.where(
			and(eq(accountCycles.userId, userId), inArray(accountCycles.billingCycle, last3Cycles())),
		);
	return Number(row?.maxSpend ?? 0);
}

function money(n: number): string {
	return (Math.round(n * 100) / 100).toFixed(2);
}

/** An allowed row the viewer qualifies for: its numeric price and whether it's a baseline (everyone) row. */
interface Offer {
	price: number;
	baseline: boolean;
}

/** Anthers-table offers the viewer qualifies for. Free tier always qualifies; paid tiers need Badge spend. */
function anthersOffers(rows: AnthersAccessRow[], badgeSpend: number): Offer[] {
	const offers: Offer[] = [];
	for (const row of rows) {
		if (!row.allow) continue;
		const need = BADGE_MIN_SPEND[row.tier] ?? 0;
		const qualifies = need <= 0 ? true : badgeSpend >= need;
		if (!qualifies) continue;
		offers.push({ price: Number(row.price ?? "0"), baseline: need <= 0 });
	}
	return offers;
}

/** Boost-table offers the viewer qualifies for (their boost to this creator ≥ the rung threshold). */
function boostOffers(rows: BoostAccessRow[], viewerBoost: number): Offer[] {
	const offers: Offer[] = [];
	for (const row of rows) {
		if (!row.allow) continue;
		if (viewerBoost < row.threshold) continue;
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

	const viewerBoost = ctx.boostByCreator.get(post.creatorId) ?? 0;

	const offers = [
		...anthersOffers(post.anthersAccess ?? [], ctx.badgeSpend),
		...boostOffers(post.boostAccess ?? [], viewerBoost),
	];

	// No qualifying allowed row → hard gate.
	if (offers.length === 0) {
		return { ...base, canAccess: false, reason: ctx.userId != null ? "gated" : "login_required" };
	}

	// Qualifies via a non-baseline (Badge/boost) row → "entitled" for display.
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
			badgeSpend: 0,
			boostByCreator: new Map(),
			purchasedPostIds: new Set(),
		};
	}

	const cycle = currentBillingCycle();
	const scoped = opts.postIds && opts.postIds.length > 0;

	const [badgeSpend, boostRows, purchaseRows] = await Promise.all([
		rollingBadgeSpend(userId),
		db
			.select({ creatorId: boostAllocations.creatorId, amount: boostAllocations.amount })
			.from(boostAllocations)
			.where(and(eq(boostAllocations.userId, userId), eq(boostAllocations.billingCycle, cycle))),
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

	const boostByCreator = new Map<number, number>();
	for (const b of boostRows) {
		boostByCreator.set(b.creatorId, Number(b.amount));
	}

	return {
		userId,
		badgeSpend,
		boostByCreator,
		purchasedPostIds: new Set(purchaseRows.map((p) => p.postId)),
	};
}

/** Would an anonymous viewer get this post for free? Used for storage-ACL decisions in jobs. */
export function isPubliclyFree(post: AccessiblePost): boolean {
	const ctx: AccessContext = {
		userId: null,
		badgeSpend: 0,
		boostByCreator: new Map(),
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

/** Default boost table = just the $0 "everyone" baseline row, locked. Ladder rungs are added by the creator. */
export function defaultBoostAccess(): BoostAccessRow[] {
	return [{ threshold: 0, allow: false, price: "0" }];
}
