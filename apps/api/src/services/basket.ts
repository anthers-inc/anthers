// SPDX-License-Identifier: Apache-2.0
/**
 * The basket — the only writer of `basket_items`.
 *
 * Single-writer for the same reason `services/library.ts` is: several doors reach this
 * table (the buyer pressing Add, the sign-in merge, the checkout's clear-at-completion)
 * and they must leave it in the same state. The one-creator rule lives HERE rather than
 * at each call site, so the merge at sign-in and the button on a Work page cannot
 * disagree about what a second creator's Work means.
 *
 * 🚨 **Nothing here prices anything and nothing here grants access.** The table holds
 * ids; every quote, checkout and listing re-resolves them through `resolveBasket` /
 * `resolvePurchase` in `routes/payments.ts`, which is where the refusals live (unbuyable,
 * already-owned, mixed creators, the item cap). This module trusts the ids for nothing —
 * it only decides which ids are in the basket and whose they belong to.
 *
 * The one-creator rule: **replace, not reject** (Parker's client-side ruling, kept
 * honest server-side). A buyer reaching for a second creator's Work has said their most
 * recent intent, and discovering the conflict at the payment step is the worst possible
 * moment — so `addItem` swaps the basket to the new creator's Work and says what it did,
 * and the surface tells the buyer. Same reasoning the client comment carried before the
 * storage moved server-side.
 */

import { basketItems, db, users, works } from "@anthers/db";
import { MAX_BASKET_ITEMS } from "@anthers/shared/constants";
import { and, asc, eq } from "drizzle-orm";

/** The creator id a work row carries, resolved to its handle — null when the account is gone. */
async function handleOf(creatorId: number): Promise<string | null> {
	const [row] = await db
		.select({ handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, creatorId))
		.limit(1);
	return row?.handle ?? null;
}

/** Everything `list` answers with — what a badge counts and what the basket page reads. */
export interface BasketRow {
	workId: number;
	/** The Work's current title, if it still exists. */
	title: string | null;
	slug: string | null;
	thumbnail: string | null;
	/** The owning creator's handle, resolved live — the basket page links through it. */
	creatorHandle: string | null;
	addedAt: Date;
}

/**
 * The buyer's basket, oldest first — the order they built it in, which is the order the
 * old client-side array held and the order the receipt reads in.
 *
 * Deliberately an INNER join: a Work row deleted out from under the basket removes the
 * basket row by cascade in the same statement, so an inner join's missing row names a
 * cascade race that the next read heals. The badge counting a ghost is the defect; this
 * cannot.
 */
export async function listBasket(userId: number): Promise<BasketRow[]> {
	const rows = await db
		.select({
			workId: works.id,
			title: works.title,
			slug: works.slug,
			thumbnail: works.thumbnail,
			creatorHandle: users.atprotoHandle,
			addedAt: basketItems.addedAt,
		})
		.from(basketItems)
		.innerJoin(works, eq(basketItems.workId, works.id))
		.innerJoin(users, eq(works.creatorId, users.id))
		.where(eq(basketItems.userId, userId))
		.orderBy(asc(basketItems.addedAt), asc(basketItems.id));
	return rows;
}

/** Why an add did not land. */
export type BasketAddRefusal = "not_found" | "at_capacity";

/**
 * Add one Work to the buyer's basket — or REPLACE the basket when the Work belongs to a
 * different creator.
 *
 * The Work must exist here and now (a 404 button is how a deleted Work should feel), but
 * nothing else about it is checked: whether it is buyable, by this buyer, at a price the
 * processor accepts — all of that is the quote's and checkout's business, and duplicating
 * it here would be a second resolver that drifts. A basket may hold an item that cannot
 * currently be bought; listing it is honest, and the refusal arrives where the money is.
 *
 * The cap (`MAX_BASKET_ITEMS`) is enforced through a plain count rather than the insert's
 * guard so a same-Work re-add stays a no-op even on a full basket.
 */
export async function addBasketItem(
	userId: number,
	workId: number,
): Promise<
	{ ok: true; replacedCreatorHandle: string | null } | { ok: false; reason: BasketAddRefusal }
> {
	const [work] = await db
		.select({ id: works.id, creatorId: works.creatorId })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return { ok: false, reason: "not_found" };

	const current = await listBasket(userId);

	// Already in — adding twice is a no-op, because the button is the kind people press
	// again when they are not sure it worked.
	if (current.some((row) => row.workId === workId))
		return { ok: true, replacedCreatorHandle: null };

	// 🚨 The item cap, from the same constant `resolveBasket` enforces — the add is where a
	// buyer learns the basket is full rather than at checkout, the same moment-rule the
	// creator clause below keeps.
	if (current.length >= MAX_BASKET_ITEMS) return { ok: false, reason: "at_capacity" };

	// 🚨 One creator per basket. A Work by a DIFFERENT creator replaces the whole basket —
	// the buyer's latest intent — and the caller is told whose work was dropped, so the
	// surface can say so. Comparison is by creator ACCOUNT, resolved live rather than
	// trusted from the caller: the stored rows carry handles, but the arriving Work's
	// creator is what decides. A creatorless Work can never be charged, so it is refused
	// here too (an empty basket may still take one — removing it later costs the same
	// single click it always did, and the checkout's refusal already names why).
	if (current.length > 0 && work.creatorId != null) {
		const first = current[0];
		if (first.creatorHandle != null) {
			const incoming = await handleOf(work.creatorId);
			if (incoming == null) return { ok: false, reason: "not_found" };
			if (incoming !== first.creatorHandle) {
				await db.delete(basketItems).where(eq(basketItems.userId, userId));
				await db.insert(basketItems).values({ userId, workId });
				return { ok: true, replacedCreatorHandle: first.creatorHandle };
			}
		}
	} else if (current.length > 0) {
		return { ok: false, reason: "not_found" };
	}

	await db.insert(basketItems).values({ userId, workId });
	return { ok: true, replacedCreatorHandle: null };
}

/** Remove one Work from the buyer's basket. Idempotent — absence is already the goal. */
export async function removeBasketItem(userId: number, workId: number): Promise<void> {
	await db
		.delete(basketItems)
		.where(and(eq(basketItems.userId, userId), eq(basketItems.workId, workId)));
}

/** Empty the buyer's basket — the checkout's clean-up once the charge is built. */
export async function clearBasket(userId: number): Promise<void> {
	await db.delete(basketItems).where(eq(basketItems.userId, userId));
}
