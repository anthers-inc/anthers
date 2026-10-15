// SPDX-License-Identifier: Apache-2.0
//
// The media-month calculator's computation layer — everything the page states as a
// number, computed here, with no JSX and no React. The page (`MediaMonthCalculatorPage`)
// renders what this returns; the tests beside this file pin it to the wiki's own
// tables.
//
// The layer exists because the page's two flows must agree BY CONSTRUCTION with the
// generated figures and the wiki's *What It Costs, Against What You Pay Now*: the
// re-pointed month is the generated `user-cases` arithmetic (`supportBreakdownDisplay`,
// pinned to its decimal original), the purchase side is `purchaseCase`'s arithmetic
// (per item, each item settling separately), and the rival side is the generated
// `RIVAL_SPEND` rows — published rates and published nulls, never estimates.
//
// 🚨 **A null split is a finding.** `creator` / `platform` of `null` render as "not
// published"; the layer never substitutes a number for them, and the reader's totals
// carry the gap instead (the wiki page's § What Can Be Known is the authority).
//
// 🚨 **Badges are subscription purchases, never gifts** (2026-10-15, in 82.01).

import {
	ANTHERS_BADGES,
	CARD_FLAT,
	CARD_RATE,
	cardFeeDisplay,
	supportBreakdownDisplay,
	withTaxDisplay,
} from "@anthers/shared/constants";
import { RIVAL_SPEND, STOREFRONT_CROSSOVER } from "@anthers/shared/figures";

// ─── The month the reader builds ───────────────────────────────────────────────

export type LineKey = "video" | "music" | "purchases" | "direct" | "free";

export interface SpendLine {
	on: boolean;
	/** The line's monthly dollars: the published list price for subscriptions, the reader's amount elsewhere. */
	spend: number;
	/** Watching hours — video and the free line; read against the Public Access allowance. */
	hours: number;
	/** Purchases only: the typical item's price; each item settles as its own charge. */
	itemPrice: number;
	/** Purchases only: items a month. */
	items: number;
	/** Direct support only: how many pledges the month's total splits into, each its own charge. */
	recipients: number;
}

function row(key: string): (typeof RIVAL_SPEND)[number] {
	const r = RIVAL_SPEND.find((r) => r.key === key);
	if (!r) throw new Error(`RIVAL_SPEND lost its ${key} row`);
	return r;
}

const ROWS = {
	video: row("video"),
	music: row("music"),
	storefront: row("storefront"),
	direct: row("direct"),
	free: row("free"),
};

/** The reader's starting month: a whole one — Premium and Spotify as published, one typical storefront purchase, two pledges by name; the free line off, because its state is the losing case. */
export function startLines(): Record<LineKey, SpendLine> {
	return {
		video: { on: true, spend: ROWS.video.price, hours: 25, itemPrice: 30, items: 1, recipients: 1 },
		music: { on: true, spend: ROWS.music.price, hours: 0, itemPrice: 30, items: 1, recipients: 1 },
		purchases: { on: true, spend: 0, hours: 0, itemPrice: 30, items: 1, recipients: 1 },
		direct: { on: true, spend: 10, hours: 0, itemPrice: 30, items: 1, recipients: 2 },
		free: { on: false, spend: 0, hours: 25, itemPrice: 30, items: 1, recipients: 1 },
	};
}

/** Badge rungs for the Anthers-side quick-pick, from the ladder itself. */
export const RUNGS: { label: string; amount: number }[] = ANTHERS_BADGES.map((b) => ({
	label: b.name,
	amount: b.threshold,
}));

/** The card fee's floor, computed from the dials — below this monthly charge there is nothing left over. Moves with the card rate; that is the point. */
export function cardFloor(): number {
	return Math.round((CARD_FLAT / (1 - 0.5 - CARD_RATE)) * 100) / 100;
}

// ─── Rounders ──────────────────────────────────────────────────────────────────

/** Round to the cent, half-up — decimal's `toFixed`, mirrored (see withTaxDisplay). */
export const cent = (n: number): number => Math.round(n * 100 + 1e-6) / 100;

/**
 * What reaches a creator from ONE pledge on the direct-support platform, as the fee
 * schedule reads: the platform's published cut, then card processing billed to the
 * creator per charge (the rates live on RIVAL_SPEND's direct row, shared with
 * RIVAL_MEMBERSHIPS). One expression, rounded once — computing the fee separately
 * and subtracting double-rounds a pledge down a whole cent (a 5.00 pledge gives
 * 4.50 − 0.445, which must land at 4.06, not at 4.05).
 */
export function patreonPledgeReach(pledge: number): number {
	const r = ROWS.direct as (typeof RIVAL_SPEND)[number] & {
		processingRate?: number;
		processingFlat?: number;
	};
	return cent(
		pledge * (1 - (r.platformCut ?? 0)) -
			(pledge * (r.processingRate ?? 0) + (r.processingFlat ?? 0)),
	);
}

/** What a creator receives from one storefront purchase: the reader's money less the published cut, which absorbs its own processing. */
export function storefrontItemReach(price: number): number {
	return cent(price * (ROWS.storefront.creatorShare ?? 0));
}

/** The purchase crossover (generated): below this list price the storefront wins outright. */
export function crossover(): number {
	return Number(STOREFRONT_CROSSOVER);
}

// ─── The two flows ─────────────────────────────────────────────────────────────

export interface TodayRow {
	key: LineKey;
	name: string;
	/** What the line gets the reader, as one sentence the UI renders verbatim. */
	gets: string;
	/** What the reader pays this month, tax included; null where the line pays nothing. */
	pay: number | null;
	platform: number | null;
	creator: number | null;
	/** What IS published, so the gap reads as a gap. */
	knowns: string[];
}

export interface PurchaseRow {
	price: number;
	items: number;
	/** The at-cost card fee per item. */
	card: number;
	/** What reaches the creator per item on Anthers. */
	reachAnthers: number;
	/** What reaches per item on the storefront. */
	reachRival: number;
}

export interface MediaMonth {
	today: {
		rows: TodayRow[];
		/** The whole month's pay, tax included. */
		paid: number;
		/** What reaches the people the reader chose, per published rates — an exact lower bound's parts. */
		knownByName: number;
		/** What rides lines whose split is not published — the gap, in the reader's own dollars. */
		notPublished: number;
		/** True when nothing but (at most) the free line is enabled — the month Anthers loses on money. */
		paysNothing: boolean;
	};
	anthers: {
		/** Subscription-type money available to re-point (video + music + direct). */
		subsSpend: number;
		/** The Anthers side and the directed side, as actually computed. */
		given: number;
		directed: number;
		/** False while the reader has typed the directed amount by hand. */
		directedAuto: boolean;
		breakdown: ReturnType<typeof supportBreakdownDisplay>;
		purchases: PurchaseRow[];
		purchasesPay: number;
		purchasesReach: number;
		/** The whole Anthers month, tax included. */
		paid: number | null;
		/** What reaches creators in total — exact. */
		reachCreators: number | null;
		/** Of which by name (directed + purchases) and by time (the pool). */
		byName: number | null;
		byPool: number;
		/** True when the Anthers-side charge sits below the card fee's floor. */
		floorless: boolean;
	};
}

export interface RePoint {
	/** The Anthers-side amount — the Public Access price by default. */
	anthersAmt: number;
	/** The directed amount as typed; ignored while untouched. */
	directedAmt: number;
	directedTouched: boolean;
}

export function computeMonth(lines: Record<LineKey, SpendLine>, rePoint: RePoint): MediaMonth {
	// ── Today ──────────────────────────────────────────────────────────────────
	const rows: TodayRow[] = [];
	const video = lines.video;
	const music = lines.music;
	const purchases = lines.purchases;
	const direct = lines.direct;
	const free = lines.free;

	if (video.on && video.spend > 0) {
		const r = ROWS.video;
		rows.push({
			key: "video",
			name: r.name,
			gets: `${video.hours} hrs a month of ad-free watching`,
			pay: withTaxDisplay(video.spend),
			platform: r.platformCut,
			creator: r.creatorShare === null ? null : cent(r.creatorShare * video.spend),
			knowns: [r.known],
		});
	}
	if (music.on && music.spend > 0) {
		const r = ROWS.music;
		rows.push({
			key: "music",
			name: r.name,
			gets: "music without ads, plus the audiobook hours the plan bundles",
			pay: withTaxDisplay(music.spend),
			platform: r.platformCut,
			creator: r.creatorShare === null ? null : cent(r.creatorShare * music.spend),
			knowns: [r.known],
		});
	}
	if (purchases.on && purchases.items > 0 && purchases.itemPrice > 0) {
		const r = ROWS.storefront;
		const p = purchases.itemPrice;
		const reach = storefrontItemReach(p);
		const notes = [
			r.known,
			`Each purchase is one charge, so the storefront's share is exact per item: ${r.name.split(" ")[0] ?? "the storefront"} keeps the rest of the list price, processing absorbed.`,
		];
		if (p < crossover()) {
			notes.push(
				`At this item price the storefront wins outright: below ${Number(STOREFRONT_CROSSOVER).toFixed(2)} a percentage cut that absorbs processing costs less than the flat card fee. The tool concedes it rather than hiding it.`,
			);
		}
		rows.push({
			key: "purchases",
			name: r.name,
			gets: `${purchases.items} item${purchases.items === 1 ? "" : "s"} at ${money2(p)} — yours to keep, downloads included`,
			pay: cent(purchases.items * withTaxDisplay(p)),
			platform: cent(purchases.items * (p - reach)),
			creator: cent(purchases.items * reach),
			knowns: notes,
		});
	}
	if (direct.on && direct.spend > 0) {
		const r = ROWS.direct;
		const recipients = Math.max(1, Math.round(direct.recipients || 1));
		const pledge = cent(direct.spend / recipients);
		rows.push({
			key: "direct",
			name: r.name,
			gets:
				recipients === 1
					? `one pledge of ${money2(pledge)} — a person you chose, by name`
					: `${recipients} pledges of ${money2(pledge)} — the people you chose, by name`,
			pay: withTaxDisplay(direct.spend),
			platform: cent(direct.spend * (r.platformCut ?? 0)),
			// Each pledge is its own charge: round per pledge, then sum.
			creator: cent(patreonPledgeReach(pledge) * recipients),
			knowns: [
				`The fee's rate is for creators joining today; earlier pages sit at lower grandfathered rates. And each pledge carries its own card processing, billed to the creator — so even this figure is the schedule's arithmetic, not a dashboard's.`,
				recipients > 1
					? `${recipients} separate charges mean the flat part of the processing fee is paid ${recipients} times over — that is the billing model, and it is why a split month costs more than its headline rate suggests.`
					: "One pledge is one charge, flat part and all.",
			],
		});
	}
	if (free.on) {
		const r = ROWS.free;
		rows.push({
			key: "free",
			name: r.name,
			gets: `${free.hours} hrs of ad-supported watching, and you pay nothing`,
			pay: null,
			platform: r.platformCut,
			creator: r.creatorShare,
			knowns: [
				r.known,
				"Per-user advertising revenue is not published by anyone and could not be precise if it were, so this row will not carry a number — not because the tool is hiding one, but because there is none to publish. The direction is known; the size is not.",
			],
		});
	}

	const paid = cent(rows.reduce((a, r) => a + (r.pay ?? 0), 0));
	const knownByName = cent(rows.reduce((a, r) => a + (r.creator ?? 0), 0));
	const notPublished = cent(rows.reduce((a, r) => a + (r.creator === null ? (r.pay ?? 0) : 0), 0));
	const paysNothing = paid === 0;

	// ── Re-pointed ──────────────────────────────────────────────────────────────
	const subsSpend = cent(
		(video.on ? video.spend : 0) + (music.on ? music.spend : 0) + (direct.on ? direct.spend : 0),
	);
	// The Public Access price rides when there is a month to re-point. A reader whose
	// month is the free line pays nothing, and their comparable Anthers month is the
	// free account — nothing given, ten hours — not a badge charged onto nothing.
	const given =
		subsSpend > 0 || rePoint.directedTouched ? cent(Math.max(0, rePoint.anthersAmt)) : 0;
	const directed = cent(
		rePoint.directedTouched ? Math.max(0, rePoint.directedAmt) : Math.max(0, subsSpend - given),
	);
	const breakdown = supportBreakdownDisplay(given, directed);

	const purchaseRows: PurchaseRow[] = [];
	if (purchases.on && purchases.items > 0 && purchases.itemPrice > 0) {
		const p = purchases.itemPrice;
		const card = cardFeeDisplay(p);
		purchaseRows.push({
			price: p,
			items: purchases.items,
			card,
			reachAnthers: cent(p - card),
			reachRival: storefrontItemReach(p),
		});
	}
	const purchasesPay = cent(
		purchaseRows.reduce((a, r) => a + withTaxDisplay(r.price) * r.items, 0),
	);
	const purchasesReach = cent(purchaseRows.reduce((a, r) => a + r.reachAnthers * r.items, 0));

	const chargeExists = breakdown.charge > 0;
	const paidAnthers =
		chargeExists || purchaseRows.length
			? cent((chargeExists ? breakdown.chargedWithTax : 0) + purchasesPay)
			: null;
	const reachCreators =
		chargeExists || purchaseRows.length ? cent(breakdown.toCreators + purchasesReach) : null;
	const byName =
		chargeExists || purchaseRows.length ? cent(breakdown.directedNet + purchasesReach) : null;
	const byPool = breakdown.timePool;

	return {
		today: { rows, paid, knownByName, notPublished, paysNothing },
		anthers: {
			subsSpend,
			given,
			directed,
			directedAuto: !rePoint.directedTouched,
			breakdown,
			purchases: purchaseRows,
			purchasesPay,
			purchasesReach,
			paid: paidAnthers,
			reachCreators,
			byName,
			byPool,
			floorless: breakdown.remainder < 0,
		},
	};
}

// ─── Formatting the flows ──────────────────────────────────────────────────────

export const money2 = (n: number): string => {
	const v = Math.abs(cent(n));
	const s = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return (n < 0 ? "−$" : "$") + s;
};

export const pct = (n: number, of: number): string =>
	`${Math.round((n / Math.max(of, 1e-9)) * 1000) / 10}%`;
