// SPDX-License-Identifier: Apache-2.0
/**
 * Settlement — a month's money, credited once, after the month ends, from what was paid for it.
 *
 * 🚨 **Nothing is credited to a creator from an invoice that has not been paid** (Parker,
 * 2026-09-14). `distribute-pool` estimates each month as it goes; this job is where the money
 * actually lands. It runs on the 2nd — the 1st is every renewal's day, and keeping the two apart
 * makes both easier to reason about — and each run settles every month that has ended and still
 * has something unsettled in it.
 *
 * For each supporter with an unsettled month:
 *
 * 1. **Their month, from its paid invoices.** What they gave Anthers funds the Time Pool, split by
 *    that month's Public Access time; what they directed at creators is credited net of each
 *    charge's card fee; their Stickers are paid out of the pool. A supporter with no paid invoice
 *    for the month is credited the free Time Pool, which is Anthers' own money spent on their
 *    behalf, and no Stickers, since the free pool carries no allowance.
 * 2. **The difference, into `creator_credits`.** What the month now entitles each creator to, less
 *    what earlier runs credited. An invoice paid late in Stripe's retries is settled by a later run
 *    against the month it paid for, and adds only its own share — with its own hold, counted from
 *    the run that credited it.
 * 3. **The remainder, into the charitable ledger.** What the supporter gave Anthers, less the Time
 *    Pool and Anthers' side of card processing, plus any of the pool that reached nobody.
 * 4. **The month's distribution rows, made final**, so every page reading them shows what was
 *    credited rather than what was estimated.
 *
 * ⚠️ **Card processing is split by the model and absorbed by the remainder.** A creator bears the
 * share of the fee `paymentsSplit` says they do, which is the figure every take-home display shows
 * them before they set an amount. Whatever Stripe actually charged beyond that — the fee on the
 * sales tax, a rate that moved — is Anthers' to absorb, because the remainder is the shock
 * absorber and creator pay is not.
 *
 * ⭐ **Idempotent by construction rather than by marker.** A run writes only differences, so a
 * second run over a settled month finds nothing to add, and a run interrupted halfway resumes by
 * recomputing what is still owed.
 */

import { db } from "@anthers/db";
import {
	accountCycles,
	creatorCredits,
	crfLedger,
	invoiceLines,
	invoices,
	monthSettlements,
	poolDistributions,
	users,
} from "@anthers/db/schema";
import {
	currentCycleKey,
	cycleEnd,
	cycleStart,
	previousCycleKey,
} from "@anthers/shared/billing-cycle";
import { supportAmount } from "@anthers/shared/constants";
import { cardFee, paymentsSplit } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, inArray, isNotNull, isNull, like, lt, notInArray, or, sql } from "drizzle-orm";
import { computeMonth, type MonthCharge } from "./distribute-pool.js";

export interface SettleCycleData {
	/**
	 * The moment the run counts as. Defaults to now; a test passes one so that "the month has
	 * ended" is a date rather than a wait. A job payload arrives as JSON, so a string is accepted.
	 */
	now?: Date | string;
	/**
	 * Settle one supporter only — an operator re-running an account whose settlement failed, and
	 * a test that must not settle whatever else the database holds. A scoped run never marks a
	 * month settled, because it has not looked at everybody in it.
	 */
	userId?: number;
}

const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** What a credit is for. */
export type CreditKind = "support" | "time_pool" | "sticker";

/** Whose money a credit is: a supporter's, passed on, or Anthers' own. */
export type CreditFunding = "supporter" | "anthers";

/**
 * Every month that has ended and still has something unsettled in it: a paid invoice not yet
 * credited, or an estimate not yet made final. The month just ended is always included, so that
 * it is marked settled even when nothing in it earned anything.
 */
async function monthsToSettle(current: string, userId?: number): Promise<string[]> {
	const [fromInvoices, fromEstimates] = await Promise.all([
		db
			.selectDistinct({ cycle: invoices.billingCycle })
			.from(invoices)
			.where(
				and(
					eq(invoices.status, "paid"),
					isNull(invoices.settledAt),
					lt(invoices.billingCycle, current),
					userId == null ? undefined : eq(invoices.userId, userId),
				),
			),
		db
			.selectDistinct({ cycle: poolDistributions.billingCycle })
			.from(poolDistributions)
			.where(
				and(
					isNull(poolDistributions.settledAt),
					lt(poolDistributions.billingCycle, current),
					userId == null ? undefined : eq(poolDistributions.subscriberId, userId),
				),
			),
	]);
	const months = new Set([
		previousCycleKey(current),
		...fromInvoices.map((r) => r.cycle),
		...fromEstimates.map((r) => r.cycle),
	]);
	return [...months].sort();
}

/** The supporters with something unsettled in this month. */
async function supportersIn(month: string, only?: number): Promise<number[]> {
	const [paid, estimated] = await Promise.all([
		db
			.selectDistinct({ userId: invoices.userId })
			.from(invoices)
			.where(
				and(
					eq(invoices.billingCycle, month),
					eq(invoices.status, "paid"),
					isNull(invoices.settledAt),
					isNotNull(invoices.userId),
				),
			),
		db
			.selectDistinct({ userId: poolDistributions.subscriberId })
			.from(poolDistributions)
			.where(
				and(
					eq(poolDistributions.billingCycle, month),
					isNull(poolDistributions.settledAt),
					isNotNull(poolDistributions.subscriberId),
				),
			),
	]);
	const ids = new Set<number>();
	for (const row of [...paid, ...estimated]) if (row.userId != null) ids.add(row.userId);
	if (only != null) return ids.has(only) ? [only] : [];
	return [...ids].sort((a, b) => a - b);
}

/** A paid invoice for the month, as the charges `computeMonth` splits. */
interface PaidCharge extends MonthCharge {
	invoiceId: number;
	/** What Stripe actually took, or zero where it could not be read. */
	processingFee: Decimal;
}

async function paidChargesFor(userId: number, month: string): Promise<PaidCharge[]> {
	const rows = await db
		.select({
			invoiceId: invoices.id,
			processingFee: invoices.processingFee,
			creatorId: invoiceLines.creatorId,
			amount: invoiceLines.amount,
		})
		.from(invoices)
		.leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
		.where(
			and(
				eq(invoices.userId, userId),
				eq(invoices.billingCycle, month),
				eq(invoices.status, "paid"),
			),
		)
		.orderBy(invoices.id);

	const byInvoice = new Map<number, PaidCharge>();
	for (const row of rows) {
		let charge = byInvoice.get(row.invoiceId);
		if (!charge) {
			charge = {
				invoiceId: row.invoiceId,
				processingFee: new Decimal(row.processingFee),
				anthers: new Decimal(0),
				directed: new Map(),
			};
			byInvoice.set(row.invoiceId, charge);
		}
		if (row.amount == null) continue;
		const amount = new Decimal(row.amount);
		if (row.creatorId == null) charge.anthers = charge.anthers.plus(amount);
		else
			charge.directed.set(
				row.creatorId,
				(charge.directed.get(row.creatorId) ?? new Decimal(0)).plus(amount),
			);
	}
	return [...byInvoice.values()];
}

/**
 * Anthers' side of the card fees on these charges: what Stripe took, less what creators bear.
 *
 * Where Stripe's own figure could not be read the model's is used instead, so a missing fee does
 * not quietly inflate the remainder, and the gap is said out loud.
 */
function anthersFeeShare(charges: PaidCharge[]): Decimal {
	let total = new Decimal(0);
	for (const charge of charges) {
		const anthers = supportAmount(Decimal.max(0, charge.anthers).toNumber());
		const directed = [...charge.directed.values()].reduce(
			(sum, d) => sum.plus(Decimal.max(0, d)),
			new Decimal(0),
		);
		const model = paymentsSplit(anthers, directed.toNumber());
		let actual = charge.processingFee;
		if (actual.lte(0) && model.total.gt(0)) {
			console.warn(
				`settle: invoice ${charge.invoiceId} has no recorded processing fee; using the model's $${cardFee(new Decimal(anthers).plus(directed)).toFixed(2)}`,
			);
			actual = model.total;
		}
		total = total.plus(actual.minus(model.creator));
	}
	return total;
}

/** What a supporter's month entitles each creator to, by kind. */
type Entitlement = Map<string, { creatorId: number; kind: CreditKind; amount: Decimal }>;

const keyOf = (creatorId: number, kind: CreditKind) => `${creatorId}:${kind}`;

/**
 * Settle one supporter's month. Returns whether anything was written.
 *
 * 🚨 **One transaction per supporter-month.** The credits, the remainder, the final distribution
 * rows and the invoices' settled stamps describe one decision, and a run that died between them
 * would leave a month credited and its invoices unsettled — which the next run would credit again.
 */
async function settleSupporterMonth(userId: number, month: string, now: Date): Promise<boolean> {
	const charges = await paidChargesFor(userId, month);
	const paid = charges.length > 0;
	const anthersDollars = supportAmount(
		Decimal.max(
			0,
			charges.reduce((sum, c) => sum.plus(c.anthers), new Decimal(0)),
		).toNumber(),
	);

	const month$ = await computeMonth({
		userId,
		cycle: month,
		start: cycleStart(month),
		end: cycleEnd(month),
		anthersDollars,
		charges,
		includeStickers: paid,
	});

	// A supporter who paid nothing to Anthers — free, or giving only to creators — draws the free
	// Time Pool, which Anthers funds.
	const poolFunding: CreditFunding = anthersDollars > 0 ? "supporter" : "anthers";

	const entitled: Entitlement = new Map();
	for (const [creatorId, d] of month$.distributions) {
		for (const [kind, amount] of [
			["support", d.seedAmount],
			["time_pool", d.poolAmount],
			["sticker", d.stickerAmount],
		] as const) {
			if (!amount.isZero()) entitled.set(keyOf(creatorId, kind), { creatorId, kind, amount });
		}
	}

	// **Accrual stops at suspension** (Parker, 2026-09-22): a month that ran while the
	// creator was suspended credits them nothing — entitlement is read, which is correct,
	// because suspended creators earn nothing from the pool or from support directed at
	// them. The *distribution* rows below stay on the record (they are the supporter's
	// own history and the per-month view), so the withheld half is *the credits*: a month
	// that runs with no credits for a suspended creator leaves the owed half of its
	// arithmetic unsettled rather than cancelled, and the next run after reinstatement
	// credits it against the month it was earned in — which is exactly how a suspension
	// that lifts mid-review pays out.
	const earnable = new Map<number, boolean>();
	for (const key of entitled.keys()) {
		const creatorId = Number(key.split(":")[0]);
		if (!earnable.has(creatorId)) {
			const [row] = await db
				.select({ suspendedAt: users.suspendedAt })
				.from(users)
				.where(eq(users.id, creatorId))
				.limit(1);
			earnable.set(creatorId, row?.suspendedAt == null);
		}
	}
	for (const key of [...entitled.keys()]) {
		if (!earnable.get(Number(key.split(":")[0]))) entitled.delete(key);
	}

	// Every creator this month named, including a suspended one, so the distribution rows
	// below know who still stands on the estimate — but only an earnable creator's month
	// is ever STAMPED. Writing the zeroed final row for a suspended creator would record
	// "the month closed with them owed nothing", which nothing is in a position to decide;
	// leaving the estimate un-stamped is what lets the next run after reinstatement credit
	// the withheld month normally, the way a late invoice's money is.
	const distributedCreatorIds = new Set(month$.distributions.keys());
	const suspendedIds = [...distributedCreatorIds].filter((id) => earnable.get(id) === false);

	return db.transaction(async (tx) => {
		// 2. The difference between what the month now entitles and what was already credited.
		const already = await tx
			.select({
				creatorId: creatorCredits.creatorId,
				kind: creatorCredits.kind,
				total: sql<string>`COALESCE(SUM(${creatorCredits.amount}), 0)`,
			})
			.from(creatorCredits)
			.where(and(eq(creatorCredits.subscriberId, userId), eq(creatorCredits.billingCycle, month)))
			.groupBy(creatorCredits.creatorId, creatorCredits.kind);

		const credited = new Map<string, Decimal>();
		for (const row of already) {
			if (row.creatorId == null) continue;
			credited.set(keyOf(row.creatorId, row.kind as CreditKind), new Decimal(row.total));
		}

		const keys = new Set([...entitled.keys(), ...credited.keys()]);
		const deltas: (typeof creatorCredits.$inferInsert)[] = [];
		for (const key of keys) {
			// A suspended creator earns nothing from this month — including a negative
			// correction against money an earlier run credited them before the suspension.
			// Reversing that here would be a clawback dressed as a settlement, and the
			// balance the review may find tainted is exactly what such a reversal would
			// erase.
			if (!earnable.get(Number(key.split(":")[0]))) continue;
			const owed = entitled.get(key)?.amount ?? new Decimal(0);
			const delta = CENTS(owed.minus(credited.get(key) ?? new Decimal(0)));
			if (delta.isZero()) continue;
			const [creatorId, kind] = key.split(":") as [string, CreditKind];
			deltas.push({
				creatorId: Number(creatorId),
				subscriberId: userId,
				billingCycle: month,
				kind,
				fundedBy: kind === "time_pool" ? poolFunding : "supporter",
				amount: delta.toFixed(2),
				settledAt: now,
			});
		}
		if (deltas.length > 0) await tx.insert(creatorCredits).values(deltas);

		// 3. The remainder. Only paid money has one: the free pool is Anthers' own, and a free
		// account's unspent pool is money nobody paid, so it is never booked as income.
		let inflow = new Decimal(0);
		let undistributed = new Decimal(0);
		if (anthersDollars > 0) {
			const given = new Decimal(anthersDollars);
			const own = Decimal.max(0, given.minus(month$.timePool).minus(anthersFeeShare(charges)));
			// Stickers are paid out of the pool, so they count as distributed — leaving them out
			// would book money a supporter aimed at a named creator to Anthers' own remainder.
			undistributed = CENTS(
				Decimal.max(0, month$.timePool.minus(month$.distributedByTime).minus(month$.stickerTotal)),
			);
			inflow = CENTS(own.plus(undistributed));
		}
		const marker = `[settle u${userId} ${month}]`;
		const [booked] = await tx
			.select({ total: sql<string>`COALESCE(SUM(${crfLedger.amount}), 0)` })
			.from(crfLedger)
			.where(like(crfLedger.description, `${marker}%`));
		const inflowDelta = CENTS(inflow.minus(new Decimal(booked?.total ?? 0)));
		if (!inflowDelta.isZero()) {
			await tx.insert(crfLedger).values({
				amount: inflowDelta.toFixed(2),
				description: `${marker} remainder from $${anthersDollars.toFixed(2)} to Anthers (Time Pool $${month$.timePool.toFixed(2)}, undistributed $${undistributed.toFixed(2)})`,
			});
		}

		// 4. The month's rows, made final — for the creators who earn. A creator the estimate
		// named and the paid month does not is written to zero rather than left standing as an
		// estimate nobody will settle; a suspended one is left untouched, because the withheld
		// month is still owed and the reset would say otherwise.
		await tx
			.update(poolDistributions)
			.set({
				poolAmount: "0.00",
				seedAmount: "0.00",
				stickerAmount: "0.00",
				settledAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(poolDistributions.subscriberId, userId),
					eq(poolDistributions.billingCycle, month),
					// A suspended creator's estimate is left standing; everyone else's settles.
					suspendedIds.length > 0
						? or(
								isNull(poolDistributions.creatorId),
								notInArray(poolDistributions.creatorId, suspendedIds),
							)
						: undefined,
				),
			);
		for (const [creatorId, d] of month$.distributions) {
			// A suspended creator's rows stay on the estimate — see the note at the reset.
			if (!earnable.get(creatorId)) continue;
			// Seconds that earned nothing — gated time, a pool that reached zero — make no row, as
			// in the estimate; the reset above already zeroed any row the estimate had made.
			if (d.poolAmount.isZero() && d.seedAmount.isZero() && d.stickerAmount.isZero()) continue;
			const values = {
				poolAmount: d.poolAmount.toFixed(2),
				seedAmount: d.seedAmount.toFixed(2),
				stickerAmount: d.stickerAmount.toFixed(2),
				attentionSeconds: d.attentionSeconds,
				settledAt: now,
			};
			await tx
				.insert(poolDistributions)
				.values({ subscriberId: userId, creatorId, billingCycle: month, ...values })
				.onConflictDoUpdate({
					target: [
						poolDistributions.subscriberId,
						poolDistributions.creatorId,
						poolDistributions.billingCycle,
					],
					set: { ...values, updatedAt: now },
				});
		}

		const directedGross = charges.reduce(
			(sum, c) => [...c.directed.values()].reduce((s, d) => s.plus(d), sum),
			new Decimal(0),
		);
		const snapshot = {
			anthersSupport: new Decimal(anthersDollars).toFixed(2),
			creatorSupportTotal: directedGross.toFixed(2),
			timePool: month$.timePool.toFixed(2),
			timePoolUndistributed: undistributed.toFixed(2),
			foundation: inflow.toFixed(2),
		};
		await tx
			.insert(accountCycles)
			.values({ userId, billingCycle: month, ...snapshot })
			.onConflictDoUpdate({
				target: [accountCycles.userId, accountCycles.billingCycle],
				set: { ...snapshot, updatedAt: now },
			});

		// 🚨 Not while a suspended creator's money was withheld from it. Stamping the
		// invoice would close the supporter's month with part of what it owed recorded
		// nowhere, and a scoped re-run after reinstatement — the pause's whole resume
		// mechanism — would find the invoice settled and credit nothing. The stamp lands
		// on that later run instead, when the withheld share is credited with the rest.
		if (paid && suspendedIds.length === 0) {
			await tx
				.update(invoices)
				.set({ settledAt: now, updatedAt: now })
				.where(
					and(
						inArray(
							invoices.id,
							charges.map((c) => c.invoiceId),
						),
						isNull(invoices.settledAt),
					),
				);
		}

		return deltas.length > 0 || !inflowDelta.isZero();
	});
}

/**
 * Settle every month that has ended and has something unsettled in it.
 *
 * Marks each month settled once its supporters are done, which is the moment a takedown stops
 * being able to void a Sticker funded by it. A later run that settles a late invoice for a marked
 * month leaves the marker as it was.
 */
export async function settleCycle(
	input: SettleCycleData | null = {},
): Promise<{ months: string[]; supporters: number }> {
	// A scheduled job arrives with no data at all.
	const data = input ?? {};
	const now = data.now ? new Date(data.now) : new Date();
	const months = await monthsToSettle(currentCycleKey(now), data.userId);

	let supporters = 0;
	for (const month of months) {
		let failed = false;
		for (const userId of await supportersIn(month, data.userId)) {
			try {
				if (await settleSupporterMonth(userId, month, now)) supporters++;
			} catch (error) {
				failed = true;
				console.error(`settle: month ${month} failed for user ${userId}:`, error);
			}
		}
		// ⚠️ **Not marked while any supporter in it failed.** The next run settles what is left,
		// and marks it then; marking now would stop a takedown voiding Stickers that no credit has
		// yet paid out.
		if (failed || data.userId != null) continue;
		const [{ count }] = await db
			.select({ count: sql<number>`COUNT(*)::int` })
			.from(invoices)
			.where(and(eq(invoices.billingCycle, month), eq(invoices.settledAt, now)));
		await db
			.insert(monthSettlements)
			.values({ billingCycle: month, settledAt: now, invoiceCount: count })
			.onConflictDoNothing({ target: monthSettlements.billingCycle });
	}

	console.log(`settle: ${months.join(", ")} — ${supporters} supporter month(s) credited`);
	return { months, supporters };
}
