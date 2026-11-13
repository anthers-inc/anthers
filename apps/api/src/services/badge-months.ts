// SPDX-License-Identifier: Apache-2.0
/**
 * The rolling five-month charge record behind the Badges tab's month row.
 *
 * Three sources answer "what did this Badge cost in that month", and each answers a
 * different part of the window:
 *
 * - **A paid invoice line** is money already collected for a month. `invoice_lines` carries
 *   the per-destination amount after its share of any day-exact reduction, and joining the
 *   invoice gives the cycle it pays for.
 * - **A completed Badge charge** is the first transaction of a Badge bought through the cart
 *   (or an upgrade's delta), which has no invoice line of its own. Settlement credits both
 *   rails for the same month, so the row must show both or a mid-month purchase is missing
 *   from the month it was paid in.
 * - **The standing subscription** answers a month that has not arrived, less any unapplied
 *   reduction recorded against that cycle. {@link projectedBadgeChargeLines} is the same
 *   read the holding projection uses, so a future month and the card above it cannot
 *   disagree.
 *
 * ⚠️ **A month at or before the current one is called paid even when nothing was charged.**
 * "No charge" is a true statement about a free month, and the UI derives that from an empty
 * total rather than from a third state. The current month falls back to the standing
 * commitment only when no invoice or Badge charge has been recorded for it yet, which is the
 * ordinary state in a development session and a brief webhook delay in production; that
 * fallback is estimated because no money has been recorded.
 */
import { db } from "@anthers/db/client";
import {
	badgeCharges,
	badges,
	invoiceLines,
	invoices,
	userBadges,
	users,
} from "@anthers/db/schema";
import { currentCycleKey, nextCycleKey, previousCycleKey } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { anthersUserId } from "./anthers-badges.js";
import { type ProjectedBadgeChargeLine, projectedBadgeChargeLines } from "./badge-projection.js";

/** One destination's charge in one month. */
export interface BadgeMonthChargeRow {
	/** React key and the stable identity the UI filters on: `anthers` or `creator:<id>`. */
	key: string;
	/** The creator's id, or null for the Anthers line and for a creator who is gone. */
	creatorId: number | null;
	/** Whether this is the Anthers account's own line rather than a creator's. */
	isAnthers: boolean;
	handle: string;
	displayName: string | null;
	/** What this destination charges in the month, two decimal places. */
	amount: string;
	/** The prorate credit folded into `amount`, two decimal places; `0.00` on a paid month. */
	reduction: string;
}

/** One month in the rolling row. */
export interface BadgeMonthCharge {
	cycle: string;
	/**
	 * `paid` is recorded money (or a month with nothing charged); `estimated` is a projection
	 * from the standing commitment for a month that has not been invoiced yet.
	 */
	state: "paid" | "estimated";
	badges: BadgeMonthChargeRow[];
	total: string;
	/** The prorate credits folded into the row's totals, `0.00` when there are none. */
	reduction: string;
}

/** A destination's money as the month is assembled. */
interface Bucket {
	creatorId: number | null;
	isAnthers: boolean;
	amount: Decimal;
}

const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);

/** The cycles the row covers, oldest first. */
function rollingCycles(behind: number, ahead: number): string[] {
	let oldest = currentCycleKey();
	for (let i = 0; i < behind; i++) oldest = previousCycleKey(oldest);
	const cycles: string[] = [];
	let cursor = oldest;
	for (let i = 0; i < behind + 1 + ahead; i++) {
		cycles.push(cursor);
		cursor = nextCycleKey(cursor);
	}
	return cycles;
}

/** The key a destination's money is grouped under. */
function keyFor(creatorId: number | null, isAnthers: boolean): string {
	if (isAnthers) return "anthers";
	return creatorId == null ? "former" : `creator:${creatorId}`;
}

/**
 * The charge record for the five months centered on this one — two back, the current month,
 * and two forward.
 */
export async function badgeChargeMonths(
	userId: number,
	options?: { behind?: number; ahead?: number },
): Promise<BadgeMonthCharge[]> {
	const cycles = rollingCycles(options?.behind ?? 2, options?.ahead ?? 2);
	const current = currentCycleKey();
	const paidCycles = cycles.filter((cycle) => cycle <= current);
	const futureCycles = cycles.filter((cycle) => cycle > current);

	const anthersId = await anthersUserId();

	// ── Money already recorded on the invoice rail ───────────────────────────
	const invoiceRows =
		paidCycles.length > 0
			? await db
					.select({ id: invoices.id, cycle: invoices.billingCycle })
					.from(invoices)
					.where(
						and(
							eq(invoices.userId, userId),
							inArray(invoices.billingCycle, paidCycles),
							// A paused renewal was paid on the card and booked, even though it
							// credits nobody while the account is suspended. It still belongs in
							// the supporter's own charge record.
							inArray(invoices.status, ["paid", "paused"]),
						),
					)
			: [];

	const cycleOfInvoice = new Map(invoiceRows.map((row) => [row.id, row.cycle]));
	const lineRows =
		invoiceRows.length > 0
			? await db
					.select({
						invoiceId: invoiceLines.invoiceId,
						creatorId: invoiceLines.creatorId,
						amount: invoiceLines.amount,
					})
					.from(invoiceLines)
					.where(inArray(invoiceLines.invoiceId, [...cycleOfInvoice.keys()]))
			: [];

	/** cycle -> destination key -> money. */
	const paidByCycle = new Map<string, Map<string, Bucket>>();

	const bucketFor = (cycle: string, creatorId: number | null, isAnthers: boolean): Bucket => {
		let byKey = paidByCycle.get(cycle);
		if (!byKey) {
			byKey = new Map<string, Bucket>();
			paidByCycle.set(cycle, byKey);
		}
		const key = keyFor(creatorId, isAnthers);
		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = { creatorId: isAnthers ? null : creatorId, isAnthers, amount: new Decimal(0) };
			byKey.set(key, bucket);
		}
		return bucket;
	};

	for (const line of lineRows) {
		const cycle = cycleOfInvoice.get(line.invoiceId);
		if (!cycle) continue;
		// `invoice_lines.creator_id` is null for Anthers by construction. The same column is
		// set null when a creator is deleted, which is the schema's known bend: an orphaned
		// line reads as Anthers here exactly as it does in settlement.
		const creatorId = line.creatorId;
		const isAnthers = creatorId == null || creatorId === anthersId;
		bucketFor(cycle, creatorId, isAnthers).amount = bucketFor(
			cycle,
			creatorId,
			isAnthers,
		).amount.plus(line.amount);
	}

	// ── Money recorded on the Badge-checkout rail ────────────────────────────
	const chargeRows =
		paidCycles.length > 0
			? await db
					.select({
						id: badgeCharges.id,
						cycle: badgeCharges.billingCycle,
						creatorId: badgeCharges.creatorId,
						amount: badgeCharges.chargedAmount,
					})
					.from(badgeCharges)
					.where(
						and(
							eq(badgeCharges.buyerId, userId),
							inArray(badgeCharges.billingCycle, paidCycles),
							eq(badgeCharges.status, "completed"),
						),
					)
			: [];

	for (const charge of chargeRows) {
		const isAnthers = charge.creatorId === anthersId;
		// A charge whose creator has since deleted their account has a null id. It groups
		// under `former` rather than the Anthers line so the month's total stays right; no
		// creator tile can select it, because the creator is gone.
		bucketFor(charge.cycle, charge.creatorId, isAnthers).amount = bucketFor(
			charge.cycle,
			charge.creatorId,
			isAnthers,
		).amount.plus(charge.amount);
	}

	// ── The current month's estimate, when nothing was recorded ──────────────
	const currentRecorded = paidByCycle.get(current);
	const needsCurrentFallback = !currentRecorded || currentRecorded.size === 0;
	let currentEstimate: Map<string, Bucket> | null = null;
	if (needsCurrentFallback) {
		const holdings = await db
			.select({ creatorId: badges.creatorId, threshold: badges.threshold })
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.where(and(eq(userBadges.userId, userId), eq(userBadges.billingCycle, current)));
		if (holdings.length > 0) {
			currentEstimate = new Map<string, Bucket>();
			for (const holding of holdings) {
				const isAnthers = holding.creatorId === anthersId;
				const key = keyFor(holding.creatorId, isAnthers);
				const existing = currentEstimate.get(key);
				if (existing) existing.amount = existing.amount.plus(holding.threshold);
				else
					currentEstimate.set(key, {
						creatorId: isAnthers ? null : holding.creatorId,
						isAnthers,
						amount: new Decimal(holding.threshold),
					});
			}
		}
	}

	// ── Future months, from the standing subscription ────────────────────────
	const future: Map<string, ProjectedBadgeChargeLine[]> =
		futureCycles.length > 0 ? await projectedBadgeChargeLines(userId, futureCycles) : new Map();

	// ── Names for every creator in play ──────────────────────────────────────
	const creatorIds = new Set<number>();
	for (const byKey of paidByCycle.values()) {
		for (const bucket of byKey.values()) {
			if (bucket.creatorId != null) creatorIds.add(bucket.creatorId);
		}
	}
	for (const bucket of currentEstimate?.values() ?? []) {
		if (bucket.creatorId != null) creatorIds.add(bucket.creatorId);
	}
	for (const lines of future.values()) {
		for (const line of lines) creatorIds.add(line.creatorId);
	}
	const creatorRows =
		creatorIds.size > 0
			? await db
					.select({
						id: users.id,
						handle: users.atprotoHandle,
						displayName: users.displayName,
					})
					.from(users)
					.where(inArray(users.id, [...creatorIds]))
			: [];
	const creatorById = new Map(creatorRows.map((row) => [row.id, row]));

	const rowFor = (bucket: Bucket): BadgeMonthChargeRow => {
		const creator = bucket.creatorId != null ? creatorById.get(bucket.creatorId) : undefined;
		return {
			key: keyFor(bucket.creatorId, bucket.isAnthers),
			creatorId: bucket.isAnthers ? null : bucket.creatorId,
			isAnthers: bucket.isAnthers,
			handle: creator?.handle ?? "",
			displayName: bucket.isAnthers ? "Anthers" : (creator?.displayName ?? null),
			amount: money(bucket.amount),
			reduction: "0.00",
		};
	};

	return cycles.map((cycle) => {
		if (cycle > current) {
			const lines = future.get(cycle) ?? [];
			const badges = lines.map((line) => {
				const isAnthers = line.creatorId === anthersId;
				return {
					key: keyFor(isAnthers ? null : line.creatorId, isAnthers),
					creatorId: isAnthers ? null : line.creatorId,
					isAnthers,
					handle: line.handle,
					displayName: isAnthers ? "Anthers" : line.displayName,
					amount: line.charge,
					reduction: line.reduction,
				};
			});
			return monthRecord(cycle, "estimated", badges);
		}

		const recorded = paidByCycle.get(cycle);
		if (cycle === current && currentEstimate) {
			const badges = [...currentEstimate.values()].map((bucket) => rowFor(bucket));
			return monthRecord(cycle, "estimated", badges);
		}

		const badges = [...(recorded?.values() ?? [])].map((bucket) => rowFor(bucket));
		return monthRecord(cycle, "paid", badges);
	});
}

/** Sort the month's destinations Anthers-first, then by what they charge, then by name. */
function monthRecord(
	cycle: string,
	state: BadgeMonthCharge["state"],
	badges: BadgeMonthChargeRow[],
): BadgeMonthCharge {
	badges.sort((a, b) => {
		if (a.isAnthers !== b.isAnthers) return a.isAnthers ? -1 : 1;
		const byAmount = Number(b.amount) - Number(a.amount);
		if (byAmount !== 0) return byAmount;
		return (a.displayName ?? a.handle).localeCompare(b.displayName ?? b.handle);
	});
	const total = badges.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
	const reduction = badges.reduce((sum, row) => sum.plus(row.reduction), new Decimal(0));
	return {
		cycle,
		state,
		badges,
		total: money(total),
		reduction: money(reduction),
	};
}
