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
	creator: { handle: string; displayName: string | null };
	/**
	 * The dollars this Badge will add to the next renewal, after the day-exact reduction
	 * for a line that began part-way into this month. Always two decimal places.
	 */
	projectedCharge: string;
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

function holding(
	badge: BadgeRow,
	creator: CreatorRow | undefined,
	cycle: string,
	projectedCharge: Decimal,
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
		creator: {
			handle: creator?.atprotoHandle ?? "",
			displayName: creator?.displayName ?? null,
		},
		projectedCharge: projectedCharge.toFixed(2),
	};
}

/**
 * What this account will hold in `cycle`, or an empty list when there is nothing to
 * project. Only the month immediately after the current one is projected; a cycle further
 * out has no commitment to read (a subscription can change many times before it arrives),
 * and a past cycle is the holdings table's question rather than this module's.
 */
export async function projectedBadgeHoldings(
	userId: number,
	cycle: string,
): Promise<ProjectedBadgeHolding[]> {
	if (cycle !== nextCycleKey(currentCycleKey())) return [];

	const [acct] = await db
		.select({
			stripeSubscriptionId: stripeCustomers.stripeSubscriptionId,
			canceledAt: stripeCustomers.canceledAt,
		})
		.from(stripeCustomers)
		.where(eq(stripeCustomers.userId, userId))
		.limit(1);

	// A cancellation ends every line at the period's end, so the next month holds nothing —
	// neither the creator Badges nor the Anthers line continue without a subscription.
	if (acct?.canceledAt) return [];

	const anthersId = await anthersUserId();

	const reductionRows = await db
		.select({ destination: billingReductions.destination, amount: billingReductions.amount })
		.from(billingReductions)
		.where(
			and(
				eq(billingReductions.userId, userId),
				eq(billingReductions.billingCycle, cycle),
				isNull(billingReductions.appliedAt),
			),
		);

	/** What each destination has already been discounted on this cycle's renewal. */
	const reductionByDestination = new Map<string, Decimal>();
	for (const row of reductionRows) {
		reductionByDestination.set(
			row.destination,
			(reductionByDestination.get(row.destination) ?? new Decimal(0)).plus(row.amount),
		);
	}
	const chargeFor = (destination: string, standing: Decimal): Decimal =>
		Decimal.max(0, standing.minus(reductionByDestination.get(destination) ?? 0));

	/** The creator names this cycle's rows need, fetched only for the ids in play. */
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
	if (sub && continuing.has(sub.status)) {
		const lines = itemsFromSub(sub, anthersId).filter((item) => item.amount > 0);
		const creatorById = await creatorsFor(lines.map((line) => line.creatorId));
		const rows: ProjectedBadgeHolding[] = [];
		for (const line of lines) {
			const standing = new Decimal(line.amount);
			const charge = chargeFor(String(line.creatorId), standing);
			const [badge] = await db
				.select(badgeColumns)
				.from(badges)
				.where(
					and(eq(badges.creatorId, line.creatorId), lte(badges.threshold, standing.toFixed(2))),
				)
				.orderBy(sql`${badges.threshold} DESC`)
				.limit(1);
			if (badge) {
				rows.push(holding(badge, creatorById.get(line.creatorId), cycle, charge));
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
				creator: {
					handle: creatorById.get(line.creatorId)?.atprotoHandle ?? "",
					displayName: creatorById.get(line.creatorId)?.displayName ?? "A former creator",
				},
				projectedCharge: charge.toFixed(2),
			});
		}
		return rows;
	}

	// ── No subscription to read: the current holdings are the standing Badges ──
	const rows = await db
		.select(badgeColumns)
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(and(eq(userBadges.userId, userId), eq(userBadges.billingCycle, currentCycleKey())));

	const creatorById = await creatorsFor(rows.map((badge) => badge.creatorId));
	return rows.map((badge) =>
		holding(
			badge,
			creatorById.get(badge.creatorId),
			cycle,
			chargeFor(String(badge.creatorId), new Decimal(badge.threshold)),
		),
	);
}
