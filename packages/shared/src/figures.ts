// SPDX-License-Identifier: Apache-2.0
//
// The published money tables, as plain numbers.
//
// These are plain numbers on purpose: the app must not import fees.ts, which would pull
// decimal.js into the SPA bundle. They are maintained by hand beside the dials in
// constants.ts and the formulas in fees.ts, and a change to the model lands in this file
// in the same commit rather than being regenerated. Periodic drift passes reconcile the
// two; nothing fails the build when they disagree.
//
// ⚠️ **One section is the exception, and it says so where it lives**: `MONEY_FLOWS`'s
// Anthers-subscription lines are computed from the ladder's own helpers, because the page
// that reads them draws a five-line column a reader is expected to add up. The rest of the
// file keeps the contract above.

import {
	ANTHERS_BADGES,
	badgeLabel,
	cardFeeDisplay,
	PUBLIC_ACCESS_PRICE,
	stickerBudgetFor,
	storageReserveFor,
	supportLineFor,
	timePoolByTimeFor,
	timePoolFor,
} from "./constants.js";

/**
 * Per-Badge decomposition of the monthly charge. Exact, not illustrative — it stopped
 * depending on a reference streamer's watch-hours when the bandwidth term went.
 */
export const BADGE_TABLE = [
	{
		badge: "Root",
		monthly: 3,
		charge: "3.00",
		timePool: "1.50",
		timePoolByTime: "1.00",
		stickers: "0.50",
		storage: "0.81",
		payments: "0.39",
		remainder: "1.11",
		support: "0.30",
	},
	{
		badge: "Sprout",
		monthly: 6,
		charge: "6.00",
		timePool: "3.00",
		timePoolByTime: "2.00",
		stickers: "1.00",
		storage: "1.61",
		payments: "0.47",
		remainder: "2.53",
		support: "0.92",
	},
	{
		badge: "Petal",
		monthly: 9,
		charge: "9.00",
		timePool: "4.50",
		timePoolByTime: "3.00",
		stickers: "1.50",
		storage: "2.42",
		payments: "0.56",
		remainder: "3.94",
		support: "1.52",
	},
	{
		badge: "Blossom",
		monthly: 12,
		charge: "12.00",
		timePool: "6.00",
		timePoolByTime: "4.00",
		stickers: "2.00",
		storage: "3.22",
		payments: "0.65",
		remainder: "5.35",
		support: "2.13",
	},
] as const;

/**
 * Direct-sale take-homes. `sizeGiB` is context for the row, NOT an input to the money:
 * delivery is free, so two rows at the same price agree whatever their size.
 */
export const SALE_TABLE = [
	{
		label: "game-10-1gib",
		price: "10.00",
		sizeGiB: 1,
		creatorReceives: "9.41",
		cardFee: "0.59",
	},
	{
		label: "game-10-2gib",
		price: "10.00",
		sizeGiB: 2,
		creatorReceives: "9.41",
		cardFee: "0.59",
	},
	{
		label: "game-20-10gib",
		price: "20.00",
		sizeGiB: 10,
		creatorReceives: "19.12",
		cardFee: "0.88",
	},
	{
		label: "album-10-1gib",
		price: "10.00",
		sizeGiB: 1,
		creatorReceives: "9.41",
		cardFee: "0.59",
	},
	{
		label: "merch-25-physical",
		price: "25.00",
		sizeGiB: 0,
		creatorReceives: "23.97",
		cardFee: "1.03",
	},
] as const;

/** The sample monthly receipt: a Sprout who also directs $6 to creators. */
export const SAMPLE_RECEIPT = {
	anthersDollars: 6,
	creatorDollars: 6,
	directedGross: "6.00",
	directedNet: "5.67",
	timePool: "3.00",
	timePoolByTime: "2.00",
	stickers: "1.00",
	storage: "1.61",
	payments: "0.65",
	paymentsAnthers: "0.32",
	paymentsCreator: "0.33",
	remainder: "2.68",
	support: "1.07",
	supportSubtotal: "12.00",
	salesTax: "0.78",
	totalBilled: "12.78",
	toCreators: "8.67",
} as const;

/** A lone $3 to one creator — the worst case, and what creator-facing copy quotes. */
export const DIRECTED_SUPPORT_WORST_CASE = {
	gross: "3.00",
	net: "2.61",
	cardFee: "0.39",
} as const;

/**
 * The paid rungs, in the ladder's own order — what the diagram's receipts table walks.
 */
const PAID_BADGES = ANTHERS_BADGES.filter((b) => b.threshold > 0);

/**
 * One Anthers subscription's split, at `monthly` dollars a month: the ladder's five lines
 * and each one's share of the charge.
 *
 * The five are the model's own functions rather than arithmetic done here, so this column
 * and `/signup`, the Badges page and The Support Model cannot disagree. `timePool` is the
 * creator half — the envelope the two creator lines are drawn from — and it is kept beside
 * them because the page also states the half as a share.
 */
function anthersSubLines(monthly: number) {
	const share = (n: number) => Math.round((n / monthly) * 1000) / 10;
	const timePool = timePoolFor(monthly);
	const timePoolByTime = timePoolByTimeFor(monthly);
	const stickers = stickerBudgetFor(monthly);
	const storage = storageReserveFor(monthly);
	const card = cardFeeDisplay(monthly);
	const support = supportLineFor(monthly);
	// What the charitable side can be at its best: the support floor plus whatever of the
	// storage reserve the month does not use.
	const remainder = Math.round((storage + support) * 100) / 100;
	return {
		monthly,
		timePool,
		timePoolByTime,
		stickers,
		storage,
		card,
		support,
		remainder,
		timePoolPct: share(timePool),
		timePoolByTimePct: share(timePoolByTime),
		stickersPct: share(stickers),
		storagePct: share(storage),
		cardPct: share(card),
		supportPct: share(support),
		remainderPct: share(remainder),
	};
}

/**
 * The money routes behind `/resources/how-money-moves` — the mechanism as it
 * works today, at representative charges: what an Anthers subscription splits
 * into, and what a creator subscription and a purchase pass through with. No
 * account mix, no phase, no forecast — the plan's projections live only in the
 * admin console.
 *
 * 🚨 **The Anthers subscription's lines are read from the ladder's own helpers rather than
 * typed here** (2026-10-25). This file exists to keep `fees.ts` and its decimal chain out of
 * the browser bundle, not to hold a second copy of the split: the diagram draws five lines
 * that a reader can add up, and `/signup`, the Badges page and this page must all be
 * describing the same five. `supportLineFor` is the definition of the last one, so the
 * column cannot drift from the model by a cent.
 */
export const MONEY_FLOWS = {
	anthersSub: { badge: "Root", ...anthersSubLines(PUBLIC_ACCESS_PRICE) },
	ladder: PAID_BADGES.map((b) => ({ badge: badgeLabel(b.name), ...anthersSubLines(b.threshold) })),
	creatorSub: {
		at: {
			monthly: 10,
			card: 0.59,
			creator: 9.41,
			cardPct: 5.9,
			creatorPct: 94.1,
		},
		worst: {
			monthly: 3,
			card: 0.39,
			creator: 2.61,
			cardPct: 13,
			creatorPct: 87,
		},
	},
	purchase: {
		at: {
			item: "An album",
			price: 10,
			card: 0.59,
			creator: 9.41,
			cardPct: 5.9,
			creatorPct: 94.1,
		},
		worst: {
			item: "A single track",
			price: 1,
			card: 0.33,
			creator: 0.67,
			cardPct: 33,
			creatorPct: 67,
		},
	},
} as const;

/**
 * The storefronts a creator actually compares us with, and their revenue share.
 *
 * Generated rather than typed into the Studio because the wiki's *How Anthers Talks About Itself* § Comparisons binds every
 * comparison to **all-in against all-in** — a rival's take-home has to be computed from
 * the same card fee ours is, and must move when that fee moves. `absorbsProcessing` is
 * Valve's model: their 30% covers the card cost, so nothing further comes off.
 *
 * ⚠️ **The rates themselves are perishable** and hand-maintained in `scenarios.ts`
 * (checked 2026-08-03). Generation guarantees the arithmetic, never the inputs.
 */
export const RIVAL_STOREFRONTS = [
	{
		name: "Steam",
		share: 0.3,
		absorbsProcessing: true,
	},
	{
		name: "itch.io",
		share: 0.1,
	},
	{
		name: "Bandcamp",
		share: 0.15,
		maxPrice: 20,
	},
] as const;

/**
 * The spend calculator's rival lines — the monthly spending lines a reader builds
 * their own media month from, with what each platform publishes about the split.
 *
 * Hand-maintained in `scenarios.ts` beside `RIVAL_STOREFRONTS` (same discipline:
 * sources and checked dates are part of the data, and a `null` split is a finding
 * the page states rather than a number it estimates). Re-exported through the
 * generated module because the browser bundle reads only this module.
 *
 * ⚠️ **The rates and prices are perishable** — generation guarantees the arithmetic,
 * never the inputs. Each row carries its own `checkedOn`; re-check before anything
 * ships.
 */
export const RIVAL_SPEND = [
	{
		key: "video",
		name: "YouTube Premium",
		price: 15.99,
		creatorShare: null,
		platformCut: null,
		known:
			'creators are paid from Premium revenue "based on how much members watch your content" — no percentage and no pool size is published',
		source: "youtube.com/premium; YouTube Help",
		checkedOn: "2026-10-15",
	},
	{
		key: "music",
		name: "Spotify Premium",
		price: 12.99,
		creatorShare: null,
		platformCut: null,
		known:
			"aggregate payouts to the industry are published; what any one artist receives depends on their label deal, which is not Spotify's to disclose",
		source: "spotify.com/us/premium",
		checkedOn: "2026-10-15",
	},
	{
		key: "storefront",
		name: "Storefront purchases",
		price: 0,
		creatorShare: 0.7,
		platformCut: 0.3,
		known: "the storefront's cut is published, and Steam's covers card processing",
		source: "Valve's published tiers; shared with RIVAL_STOREFRONTS",
		checkedOn: "2026-10-15",
		absorbsProcessing: true,
	},
	{
		key: "direct",
		name: "Patreon",
		price: 0,
		creatorShare: 0.9,
		platformCut: 0.1,
		known:
			"the 10% platform fee is the rate for creators joining today (older pages sit at 5%, 8% or 11%, grandfathered); each pledge also carries card processing billed to the creator — 2.9% plus a flat fee per charge on a US card — which Patreon publishes in its fee schedule",
		source: "Patreon Help — Creator fees overview; shared with RIVAL_MEMBERSHIPS",
		checkedOn: "2026-10-15",
		perCreatorCharge: true,
		processingRate: 0.029,
		processingFlat: 0.3,
	},
	{
		key: "free",
		name: "The free, ad-supported month",
		price: 0,
		creatorShare: null,
		platformCut: null,
		known:
			"creators receive 55% of the ad revenue long-form videos generate — and per-user advertising revenue is not published by anyone, so the per-hour figure cannot be computed",
		source: "YouTube Help",
		checkedOn: "2026-10-15",
	},
] as const;

/**
 * The purchase crossover, against the storefront cut `purchaseCase` defaults to
 * (Steam's 30%): below this list price a storefront that absorbs processing returns
 * MORE to the creator than Anthers does, and the page concedes it. Computed by
 * walking up in cents from `FLAT / (CUT − RATE)` until Anthers actually wins once
 * both sides are rounded — not roundable from a formula, because the concession
 * turns on whose rounding wins.
 */
export const STOREFRONT_CROSSOVER = "1.11" as const;
