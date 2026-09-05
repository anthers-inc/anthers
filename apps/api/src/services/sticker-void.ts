// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reverting Sticker directions when Anthers takes a Work down.
 *
 * 🚨 **Who removed it decides who keeps the money** (Parker, 2026-09-04).
 *
 * - **A giver removing their own Sticker** keeps the creator paid. The money was committed
 *   at the moment of giving, and letting somebody take it back would make standing
 *   rentable — give, collect the goodwill, withdraw before the cycle closes. That is
 *   `removed_at`, and it is display only.
 * - **A creator withdrawing their own Work** also keeps them paid. They broke no rule, and
 *   a creator has to stay free to take something out of circulation without it costing
 *   them money already given. Nothing here fires on a withdrawal.
 * - **Anthers taking a Work down** reverts the direction. Paying directed money out on
 *   content Anthers removed would be funding the violation, so the money goes back to
 *   being distributed by time — which is what it would have done had nobody directed it.
 *
 * ⭐ **Reverting is a subtraction, not a transfer.** `distribute-pool` distributes by time
 * only what was *not* directed, so leaving a voided Sticker out of that sum is the entire
 * mechanism. No money is moved, created or held anywhere; it simply stops being carved out.
 *
 * 🚨 **Only ever on a cycle that has not settled.** Once the payouts are written the money
 * is somewhere else, and voiding then would be a claim about the past rather than a routing
 * instruction. A takedown does not reach backwards into cycles already paid.
 */

import { db } from "@anthers/db/client";
import { poolDistributions, stickers } from "@anthers/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/** Cycles that `distribute-pool` has already written payouts for, of those asked about. */
async function settledCycles(cycles: string[]): Promise<Set<string>> {
	if (cycles.length === 0) return new Set();
	const rows = await db
		.selectDistinct({ cycle: poolDistributions.billingCycle })
		.from(poolDistributions)
		.where(inArray(poolDistributions.billingCycle, cycles));
	return new Set(rows.map((r) => r.cycle));
}

/**
 * Revert every unsettled Sticker sitting on this subject. Returns how many, and the dollars
 * handed back to time-based distribution.
 *
 * ⚠️ **Idempotent**, because a takedown can be actioned more than once in the life of a
 * notice and re-voiding must not double-count anything a caller reports.
 */
export async function voidStickersOnSubject(
	subjectType: "work" | "post" | "comment",
	subjectId: number,
): Promise<{ voided: number; dollars: number }> {
	const live = await db
		.select({ id: stickers.id, cycle: stickers.billingCycle, amount: stickers.amount })
		.from(stickers)
		.where(
			and(
				eq(stickers.subjectType, subjectType),
				eq(stickers.subjectId, subjectId),
				isNull(stickers.voidedAt),
			),
		);
	if (live.length === 0) return { voided: 0, dollars: 0 };

	const settled = await settledCycles([...new Set(live.map((r) => r.cycle))]);
	const revertible = live.filter((r) => !settled.has(r.cycle));
	if (revertible.length === 0) return { voided: 0, dollars: 0 };

	await db
		.update(stickers)
		.set({ voidedAt: new Date() })
		.where(
			inArray(
				stickers.id,
				revertible.map((r) => r.id),
			),
		);
	const dollars = revertible.reduce((sum, r) => sum + Number(r.amount), 0);
	return { voided: revertible.length, dollars: Math.round(dollars * 100) / 100 };
}

/**
 * Put back what {@link voidStickersOnSubject} reverted, when a takedown is undone.
 *
 * ⚠️ **Only for a cycle that is still unsettled.** A counter-notice can arrive after the
 * cycle closed, and by then the money has been distributed by time and paid out — so the
 * Sticker stays voided and the record says what actually happened. Restoring the Work does
 * not rewrite a settled month.
 */
export async function restoreStickersOnSubject(
	subjectType: "work" | "post" | "comment",
	subjectId: number,
): Promise<{ restored: number }> {
	const voided = await db
		.select({ id: stickers.id, cycle: stickers.billingCycle })
		.from(stickers)
		.where(
			and(
				eq(stickers.subjectType, subjectType),
				eq(stickers.subjectId, subjectId),
				sql`${stickers.voidedAt} IS NOT NULL`,
			),
		);
	if (voided.length === 0) return { restored: 0 };

	const settled = await settledCycles([...new Set(voided.map((r) => r.cycle))]);
	const restorable = voided.filter((r) => !settled.has(r.cycle));
	if (restorable.length === 0) return { restored: 0 };

	await db
		.update(stickers)
		.set({ voidedAt: null })
		.where(
			inArray(
				stickers.id,
				restorable.map((r) => r.id),
			),
		);
	return { restored: restorable.length };
}
