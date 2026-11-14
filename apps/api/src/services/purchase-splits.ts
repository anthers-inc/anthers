// SPDX-License-Identifier: Apache-2.0
/**
 * The frozen split of one Work sale across its owners.
 *
 * A purchase is one charge and one entitlement, so its row stays the buyer's receipt. A
 * Collab Work's creator earnings belong to several people, and this module writes the
 * one row per owner at the moment the sale completes. Every later reader — the transfer,
 * the retry job, a refund, a dispute — reads these rows rather than recomputing a split
 * from today's ownership, which is what keeps an ownership change from rewriting an old
 * sale.
 *
 * A solo Work writes no rows: the purchase row's own `creatorEarnings` and transfer are
 * the whole story, and that path is deliberately left untouched.
 */
import { db } from "@anthers/db/client";
import { purchaseSplits } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { eq, inArray } from "drizzle-orm";
import { splitDollarsEvenly } from "./badge-splits.js";
import { workOwnerIds } from "./work-owners.js";

type Purchase = {
	id: number;
	workId: number | null;
	creatorId: number | null;
	creatorEarnings: string;
	stripeTransferId: string | null;
};

export type PurchaseSplit = typeof purchaseSplits.$inferSelect;

/**
 * The splits for one purchase, writing them on first call.
 *
 * Idempotent: the existing rows are returned unchanged, so a redelivered completion or a
 * retry after a partial failure cannot re-split the money. The insert and the read are
 * separate because the unique `(purchaseId, creatorId)` is the freeze; a concurrent caller
 * loses the race and reads the winner's rows.
 */
export async function ensurePurchaseSplits(purchase: Purchase): Promise<PurchaseSplit[]> {
	const existing = await db
		.select()
		.from(purchaseSplits)
		.where(eq(purchaseSplits.purchaseId, purchase.id));
	if (existing.length > 0) return existing;
	if (purchase.workId == null || purchase.creatorId == null) return [];

	const owners = await workOwnerIds(purchase.workId);
	// One owner is the solo case; the purchase row is the whole record.
	if (owners.length <= 1) return [];

	const shares = splitDollarsEvenly(new Decimal(purchase.creatorEarnings), owners.length);
	await db
		.insert(purchaseSplits)
		.values(
			owners.map((creatorId, index) => ({
				purchaseId: purchase.id,
				creatorId,
				amount: (shares[index] / 100).toFixed(2),
			})),
		)
		.onConflictDoNothing();
	return db.select().from(purchaseSplits).where(eq(purchaseSplits.purchaseId, purchase.id));
}

/** One creator's money on one purchase, whichever record carries it. */
export interface PurchaseShare {
	creatorId: number;
	/** This creator's slice of the purchase's `creatorEarnings`. */
	amount: Decimal;
	/** The Stripe transfer that carried the slice, or null before it moves. */
	transferId: string | null;
	/** The split row's id on a co-owned Work; null when the purchase row is the record. */
	splitId: number | null;
}

/**
 * Who is owed what on one purchase, read from the record that froze it.
 *
 * A co-owned Work's shares are its `purchase_splits` rows, written at completion. A solo
 * Work has none and the purchase row itself is the share — the shape every pre-Collab
 * sale has. Refunds, disputes, netting and the retry job all read this one function, so
 * none of them can disagree about the split or reach back to today's ownership.
 *
 * A split row whose owner deleted their account is left out: `creator_id` is set null and
 * there is nobody left to pay or recover from. Its share simply does not move.
 */
export async function purchaseShares(purchase: Purchase): Promise<PurchaseShare[]> {
	const splits = await db
		.select()
		.from(purchaseSplits)
		.where(eq(purchaseSplits.purchaseId, purchase.id));
	if (splits.length > 0) {
		return splits.flatMap((split) =>
			split.creatorId == null
				? []
				: [
						{
							creatorId: split.creatorId,
							amount: new Decimal(split.amount),
							transferId: split.stripeTransferId,
							splitId: split.id,
						},
					],
		);
	}
	if (purchase.creatorId == null) return [];
	return [
		{
			creatorId: purchase.creatorId,
			amount: new Decimal(purchase.creatorEarnings),
			transferId: purchase.stripeTransferId,
			splitId: null,
		},
	];
}

/** Batch read, for a refund or a dispute that must settle every owner at once. */
export async function purchaseSplitsFor(
	purchaseIds: readonly number[],
): Promise<Map<number, PurchaseSplit[]>> {
	const out = new Map<number, PurchaseSplit[]>();
	if (purchaseIds.length === 0) return out;
	const rows = await db
		.select()
		.from(purchaseSplits)
		.where(inArray(purchaseSplits.purchaseId, [...purchaseIds]));
	for (const row of rows) {
		const list = out.get(row.purchaseId) ?? [];
		list.push(row);
		out.set(row.purchaseId, list);
	}
	return out;
}
