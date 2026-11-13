// SPDX-License-Identifier: Apache-2.0
/**
 * The Badges somebody will hold in a month that has not started yet.
 *
 * The `user_badges` rows are the in-force record of a cycle, written when a subscription
 * activates and when the 1st arrives. They cannot answer a question about *next* month,
 * which is exactly the question the account page's cycle selector asks: a Badge continues
 * by default, and a change made mid-month has already moved the subscription's line to the
 * amount that will renew. So the projection reads the **subscription's items**, which are
 * the standing commitment, rather than the current cycle's holdings — a decrease or a
 * removal waits for the 1st in the charge but moves the item immediately, and projecting
 * from the holding would show a Badge the account has already dropped.
 *
 * ⭐ **The amount is the next charge, not the rung's list price.** A line started part-way
 * into the month is charged in full that day, and the days before it began come off the
 * next renewal (`reductionFor`, held in `billing_reductions` against the cycle it
 * discounts). The projected figure is therefore the threshold less any unapplied
 * reduction for this cycle — the number the account will actually see on the invoice.
 *
 * ⚠️ **A Stripe-less environment falls back to this cycle's holdings.** A dev session or a
 * database with payments unconfigured has no subscription to read, so the standing Badges
 * are the ones held now, at their list price less any reduction already recorded against
 * the cycle. That is the honest answer available there, and it keeps the preview from
 * rendering nothing.
 */
import { db } from "@anthers/db/client";
import { badges, billingReductions, stripeCustomers, userBadges, users } from "@anthers/db/schema";
import { currentCycleKey, nextCycleKey } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { paymentsConfigured, retrieveSubscription } from "../lib/processor.js";
import { anthersUserId } from "./anthers-badges.js";
import { itemsFromSub } from "./billing.js";

/** A Badge as a projected cycle shows it — the holding shape plus what it will charge. */
export interface ProjectedBadgeHolding {
	id: number;
	threshold: string;
	label: string;
	description: string | null;
	artShape: string | null;
	artColor: string | null;
	artEdgeColor: string | null;
	hasArt: boolean;
	hasComposedArt: boolean;
	updatedAt: Date;
	billingCycle: string;
	createdAt: Date;
	/** Whether this line is the Anthers account's own Badge rather than a creator's. */
	isAnthers: boolean;
	creator: { handle: string; displayName: string | null };
	/**
	 * The dollars this Badge will add to the next renewal, after the day-exact reduction
	 * for a line that began part-way into this month. Always two decimal places.
	 */
	projectedCharge: string;
}

/**
 * One destination's standing charge for a cycle, before it is resolved to a Badge row.
 *
 * The rolling five-month row on the Badges tab needs only the money and the creator it
 * belongs to, not the emblem; {@link projectedBadgeHoldings} resolves the same lines to the
 * rung each one names. Both read this, so the two surfaces cannot disagree about what a
 * future month will charge.
 */
export interface ProjectedBadgeChargeLine {
	creatorId: number;
	handle: string;
	displayName: string | null;
	/** The line's monthly amount before any reduction. */
	standing: string;
	/** The day-exact reduction folded into `charge`, two decimal places. */
	reduction: string;
	/** What the renewal is expected to charge, never below zero. */
	charge: string;
}

/** The badge columns both read paths share. */
const badgeColumns = {
	id: badges.id,
	threshold: badges.threshold,
	label: badges.label,
	description: badges.description,
	artShape: badges.artShape,
	artColor: badges.artColor,
	artEdgeColor: badges.artEdgeColor,
	artKey: badges.artKey,
	artFingerprint: badges.artFingerprint,
	updatedAt: badges.updatedAt,
	creatorId: badges.creatorId,
};

type BadgeRow = {
	id: number;
	threshold: string;
	label: string;
	description: string | null;
	artShape: string | null;
	artColor: string | null;
	artEdgeColor: string | null;
	artKey: string | null;
	artFingerprint: string | null;
	updatedAt: Date;
	creatorId: number;
};

type CreatorRow = { id: number; atprotoHandle: string; displayName: string | null };

/** One destination's standing amount, with the creator named for whatever renders it. */
interface StandingLine {
	creatorId: number;
	handle: string;
	displayName: string | null;
	standing: Decimal;
}

function holding(
	badge: BadgeRow,
	creator: CreatorRow | undefined,
	cycle: string,
	projectedCharge: Decimal,
	isAnthers: boolean,
): ProjectedBadgeHolding {
	return {
		id: badge.id,
		threshold: badge.threshold,
		label: badge.label,
		description: badge.description,
		artShape: badge.artShape,
		artColor: badge.artColor,
		artEdgeColor: badge.artEdgeColor,
		hasArt: Boolean(badge.artKey),
		hasComposedArt: badge.artFingerprint !== null,
		updatedAt: badge.updatedAt,
		billingCycle: cycle,
		createdAt: new Date(),
		isAnthers,
		creator: {
			handle: creator?.atprotoHandle ?? "",
			displayName: creator?.displayName ?? null,
		},
		projectedCharge: projectedCharge.toFixed(2),
	};
}

/**
 * The cycles this module will project, read from the subscription rather than invented.
 *
 * The current cycle is included because the five-month row uses the standing commitment as
 * its estimate when no invoice or Badge charge has been recorded yet. The two following
 * cycles are the row's whole future; a cycle further out has no commitment to read, because
 * a subscription can change many times before it arrives.
 */
function standingCycles(cycles: string[]): string[] {
	const current = currentCycleKey();
	return [...new Set(cycles)].filter((cycle) => cycle >= current);
}

/** The two cycles {@link projectedBadgeHoldings} answers, as opposed to the estimate fallback. */
function isHoldingCycle(cycle: string): boolean {
	const current = currentCycleKey();
	return cycle === nextCycleKey(current) || cycle === nextCycleKey(nextCycleKey(current));
}

/**
 * The standing Badge lines for one or more cycles, read once.
 *
 * A cycle key at or before the current month is a question about the standing commitment
 * rather than the paid record; callers below turn the answer into the holding shape or the
 * rolling charge row. A canceled subscription stands for nothing, and a database with no
 * subscription falls back to this cycle's holdings at their list price.
 */
async function readStandingLines(
	userId: number,
	cycles: string[],
): Promise<Map<string, ProjectedBadgeChargeLine[]>> {
	const asked = standingCycles(cycles);
	const result = new Map<string, ProjectedBadgeChargeLine[]>(asked.map((cycle) => [cycle, []]));
	if (asked.length === 0) return result;

	const [acct] = await db
		.select({
			stripeSubscriptionId: stripeCustomers.stripeSubscriptionId,
			canceledAt: stripeCustomers.canceledAt,
		})
		.from(stripeCustomers)
		.where(eq(stripeCustomers.userId, userId))
		.limit(1);

	// A cancellation ends every line at the period's end, so no future month holds anything —
	// neither the creator Badges nor the Anthers line continue without a subscription.
	if (acct?.canceledAt) return result;

	const anthersId = await anthersUserId();

	const reductionRows = await db
		.select({
			cycle: billingReductions.billingCycle,
			destination: billingReductions.destination,
			amount: billingReductions.amount,
		})
		.from(billingReductions)
		.where(
			and(
				eq(billingReductions.userId, userId),
				inArray(billingReductions.billingCycle, asked),
				isNull(billingReductions.appliedAt),
			),
		);

	/** What each destination has already been discounted on each cycle's renewal. */
	const reductionByCycle = new Map<string, Map<string, Decimal>>();
	for (const row of reductionRows) {
		let byDestination = reductionByCycle.get(row.cycle);
		if (!byDestination) {
			byDestination = new Map<string, Decimal>();
			reductionByCycle.set(row.cycle, byDestination);
		}
		byDestination.set(
			row.destination,
			(byDestination.get(row.destination) ?? new Decimal(0)).plus(row.amount),
		);
	}

	/** The creator names this read needs, fetched only for the ids in play. */
	const creatorsFor = async (ids: number[]) => {
		const unique = [...new Set(ids)];
		if (unique.length === 0) return new Map<number, CreatorRow>();
		const rows = await db
			.select({
				id: users.id,
				atprotoHandle: users.atprotoHandle,
				displayName: users.displayName,
			})
			.from(users)
			.where(inArray(users.id, unique));
		return new Map(rows.map((row) => [row.id, row]));
	};

	const sub =
		acct?.stripeSubscriptionId && paymentsConfigured()
			? await retrieveSubscription(acct.stripeSubscriptionId)
			: null;

	// ── The standing subscription is the commitment ──────────────────────────
	// An allow-list rather than a deny-list: a status this build has not been taught is
	// not a promise to charge, and the projection fails toward showing nothing.
	const continuing = new Set(["active", "trialing", "past_due", "unpaid"]);
	let standing: StandingLine[] = [];
	if (sub && continuing.has(sub.status)) {
		const lines = itemsFromSub(sub, anthersId).filter((item) => item.amount > 0);
		const creatorById = await creatorsFor(lines.map((line) => line.creatorId));
		standing = lines.map((line) => ({
			creatorId: line.creatorId,
			handle: creatorById.get(line.creatorId)?.atprotoHandle ?? "",
			displayName: creatorById.get(line.creatorId)?.displayName ?? null,
			standing: new Decimal(line.amount),
		}));
	} else {
		// ── No subscription to read: the current holdings are the standing Badges ──
		const rows = await db
			.select({ creatorId: badges.creatorId, threshold: badges.threshold })
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.where(and(eq(userBadges.userId, userId), eq(userBadges.billingCycle, currentCycleKey())));

		const creatorById = await creatorsFor(rows.map((row) => row.creatorId));
		standing = rows.map((row) => ({
			creatorId: row.creatorId,
			handle: creatorById.get(row.creatorId)?.atprotoHandle ?? "",
			displayName: creatorById.get(row.creatorId)?.displayName ?? null,
			standing: new Decimal(row.threshold),
		}));
	}

	for (const cycle of asked) {
		const reductions = reductionByCycle.get(cycle);
		result.set(
			cycle,
			standing.map((line) => {
				const reduction = Decimal.min(
					line.standing,
					reductions?.get(String(line.creatorId)) ?? new Decimal(0),
				);
				return {
					creatorId: line.creatorId,
					handle: line.handle,
					displayName: line.displayName,
					standing: line.standing.toFixed(2),
					reduction: reduction.toFixed(2),
					charge: Decimal.max(0, line.standing.minus(reduction)).toFixed(2),
				};
			}),
		);
	}

	return result;
}

/**
 * What this account will hold in `cycle`, or an empty list when there is nothing to
 * project. Only the two months after the current one are projected; a cycle further out has
 * no commitment to read (a subscription can change many times before it arrives), and a
 * past cycle is the holdings table's question rather than this module's.
 */
export async function projectedBadgeHoldings(
	userId: number,
	cycle: string,
): Promise<ProjectedBadgeHolding[]> {
	if (!isHoldingCycle(cycle)) return [];

	const lines = (await readStandingLines(userId, [cycle])).get(cycle) ?? [];
	const anthersId = await anthersUserId();
	const rows: ProjectedBadgeHolding[] = [];
	for (const line of lines) {
		const standing = new Decimal(line.standing);
		const [badge] = await db
			.select(badgeColumns)
			.from(badges)
			.where(and(eq(badges.creatorId, line.creatorId), lte(badges.threshold, standing.toFixed(2))))
			.orderBy(sql`${badges.threshold} DESC`)
			.limit(1);
		const creator: CreatorRow = {
			id: line.creatorId,
			atprotoHandle: line.handle,
			displayName: line.displayName,
		};
		if (badge) {
			rows.push(
				holding(badge, creator, cycle, new Decimal(line.charge), line.creatorId === anthersId),
			);
			continue;
		}
		// A line whose rung has gone (the creator's account was deleted, say) still
		// charges, and dropping it would hide money from the month's total. Keep the
		// amount, name what is known, and give the card a stable synthetic id.
		rows.push({
			id: -line.creatorId,
			threshold: standing.toFixed(2),
			label: `$${standing.toFixed(2)}`,
			description: null,
			artShape: null,
			artColor: null,
			artEdgeColor: null,
			hasArt: false,
			hasComposedArt: false,
			updatedAt: new Date(),
			billingCycle: cycle,
			createdAt: new Date(),
			isAnthers: line.creatorId === anthersId,
			creator: {
				handle: line.handle,
				displayName: line.displayName ?? "A former creator",
			},
			projectedCharge: new Decimal(line.charge).toFixed(2),
		});
	}
	return rows;
}

/**
 * The standing charge for each of `cycles`, with its prorate reduction — the read behind
 * the Badges tab's rolling five-month row, and the same lines the holding projection
 * resolves into Badges.
 */
export function projectedBadgeChargeLines(
	userId: number,
	cycles: string[],
): Promise<Map<string, ProjectedBadgeChargeLine[]>> {
	return readStandingLines(userId, cycles);
}
