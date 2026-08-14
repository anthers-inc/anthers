// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Library — the only writer of `library_items`.
 *
 * Single-writer for the same reason `services/moderation.ts` and `services/refunds.ts`
 * are: two doors reach this table (a person pressing Save, and a purchase completing) and
 * they must leave it in the same state. A purchase that saved a Work slightly differently
 * from a person saving one is a difference nobody would notice until it mattered.
 *
 * 🚨 **Nothing here grants access.** `resolveAccess` does not read this table and must
 * never learn to: a shelf entry is curation, and if saving unlocked anything then "Save"
 * would be a free unlock button. Entitlement lives in `purchases`. The full reasoning is
 * on the table itself in `packages/db/src/schema/content.ts`.
 */

import { db, libraryItems, purchases, works } from "@anthers/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";

/** Why a save was refused, when it was. */
export type SaveRefusal = "not_found" | "not_released";

/**
 * Whether this user's shelf entry for a Work is **permanent** — i.e. they bought it.
 *
 * Derived from `purchases` on every call rather than stamped on the row, which is the
 * whole reason there is no `source` column. A refund flips the purchase out of
 * `completed`, and the shelf entry becomes removable in the same instant, with no sweep
 * to run and no second copy of the fact to drift.
 */
export async function isPermanent(userId: number, workId: number): Promise<boolean> {
	const [row] = await db
		.select({ id: purchases.id })
		.from(purchases)
		.where(
			and(
				eq(purchases.buyerId, userId),
				eq(purchases.workId, workId),
				eq(purchases.status, "completed"),
			),
		)
		.limit(1);
	return !!row;
}

/** Every Work id on this user's shelf that a completed purchase makes permanent. */
export async function permanentWorkIds(userId: number): Promise<Set<number>> {
	const rows = await db
		.selectDistinct({ workId: purchases.workId })
		.from(purchases)
		.where(
			and(
				eq(purchases.buyerId, userId),
				eq(purchases.status, "completed"),
				isNotNull(purchases.workId),
			),
		);
	return new Set(rows.map((r) => r.workId as number));
}

/**
 * Save a Work to a user's Library.
 *
 * Idempotent — saving twice is a no-op rather than an error, because the button is the
 * kind people press again when they are not sure it worked.
 *
 * A **released** Work may be saved whether or not the user can currently open it. That is
 * deliberate: a shelf holding a gated Work is a coherent thing (it shows locked, with the
 * route to unlock), and refusing would make Save mean "prove you own this" rather than
 * "keep this". A `private` Work is refused, because it is nobody else's business yet.
 */
export async function saveWork(
	userId: number,
	workId: number,
): Promise<{ ok: true; id: number } | { ok: false; reason: SaveRefusal }> {
	const [work] = await db
		.select({ id: works.id, visibility: works.visibility, creatorId: works.creatorId })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return { ok: false, reason: "not_found" };
	// A creator may keep their own unreleased Work; nobody else can see it to save it.
	if (work.visibility === "private" && work.creatorId !== userId) {
		return { ok: false, reason: "not_released" };
	}

	const [row] = await db
		.insert(libraryItems)
		.values({ userId, workId, sortOrder: await nextSortOrder(userId) })
		.onConflictDoNothing()
		.returning({ id: libraryItems.id });
	if (row) return { ok: true, id: row.id };

	// Already there. Return the existing row rather than an error — and un-hide it, since
	// pressing Save on something you had tidied away plainly means "put it back".
	const [existing] = await db
		.update(libraryItems)
		.set({ hidden: false })
		.where(and(eq(libraryItems.userId, userId), eq(libraryItems.workId, workId)))
		.returning({ id: libraryItems.id });
	return existing ? { ok: true, id: existing.id } : { ok: false, reason: "not_found" };
}

/** Save a Project — an album, a series — as one thing rather than as its members. */
export async function saveProject(
	userId: number,
	projectId: number,
): Promise<{ ok: true; id: number } | { ok: false; reason: SaveRefusal }> {
	const [row] = await db
		.insert(libraryItems)
		.values({ userId, projectId, sortOrder: await nextSortOrder(userId) })
		.onConflictDoNothing()
		.returning({ id: libraryItems.id });
	if (row) return { ok: true, id: row.id };

	const [existing] = await db
		.update(libraryItems)
		.set({ hidden: false })
		.where(and(eq(libraryItems.userId, userId), eq(libraryItems.projectId, projectId)))
		.returning({ id: libraryItems.id });
	return existing ? { ok: true, id: existing.id } : { ok: false, reason: "not_found" };
}

/**
 * Called when a purchase completes: what you bought is on your shelf, permanently.
 *
 * 🚨 The insert is what makes the Library show a purchase at all — but it is **not** what
 * makes the purchase permanent. Permanence is the `purchases` row, read back by
 * `isPermanent`, so a shelf entry that somehow failed to be written here does not cost the
 * buyer their entitlement, and one written by mistake does not grant one.
 */
export async function saveOnPurchase(purchase: {
	buyerId: number | null;
	workId: number | null;
	type: string;
}): Promise<void> {
	// A Seed buy bought no Work; a deleted buyer has no shelf. Both are ordinary.
	if (purchase.type === "seeds" || purchase.buyerId == null || purchase.workId == null) return;
	await db
		.insert(libraryItems)
		.values({ userId: purchase.buyerId, workId: purchase.workId })
		.onConflictDoNothing();
}

/**
 * Remove a shelf entry.
 *
 * Refuses a purchased Work — Parker's call, and the reasoning is about recovery rather
 * than about ownership: somebody who tidies a purchase off their shelf and cannot work out
 * how to get it back has effectively lost the thing they paid for. Hiding is the control
 * they actually want, it is reversible from a toggle in the same view, and it cannot lose
 * anything.
 */
export async function removeItem(
	userId: number,
	itemId: number,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "purchased" }> {
	const [item] = await db
		.select()
		.from(libraryItems)
		.where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
		.limit(1);
	if (!item) return { ok: false, reason: "not_found" };

	if (item.workId != null && (await isPermanent(userId, item.workId))) {
		return { ok: false, reason: "purchased" };
	}

	await db.delete(libraryItems).where(eq(libraryItems.id, itemId));
	return { ok: true };
}

/** Tidy an entry off the shelf, or bring it back. Never loses anything. */
export async function setHidden(userId: number, itemId: number, hidden: boolean): Promise<boolean> {
	const [row] = await db
		.update(libraryItems)
		.set({ hidden })
		.where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
		.returning({ id: libraryItems.id });
	return !!row;
}

/** Next position on the shelf — newest last, matching the order things were saved. */
async function nextSortOrder(userId: number): Promise<number> {
	const [row] = await db
		.select({ next: sql<number>`coalesce(max(${libraryItems.sortOrder}), 0) + 1` })
		.from(libraryItems)
		.where(eq(libraryItems.userId, userId));
	return row?.next ?? 0;
}
