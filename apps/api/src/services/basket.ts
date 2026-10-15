// SPDX-License-Identifier: Apache-2.0
/**
 * The basket — the only writer of `basket_items`.
 *
 * Single-writer for the same reason `services/library.ts` is: several doors reach this
 * table (the buyer pressing Add, the sign-in merge, the checkout's clear-at-completion)
 * and they must leave it in the same state.
 *
 * 🚨 **Nothing here prices anything and nothing here grants access.** The table holds
 * ids; every quote, checkout and listing re-resolves them through `resolveBasket` /
 * `resolvePurchase` in `routes/payments.ts`, which is where the refusals live (unbuyable,
 * already-owned, the item cap). This module trusts the ids for nothing — it only decides
 * which ids are in the basket.
 *
 * **The basket holds any number of creators' Works** (Parker, 2026-10-15, the multi-creator
 * decision). The replace-on-clash rule this module used to enforce — a second creator's
 * Work wiping the basket — was the dealbreaker the decision removed: a cart is for
 * carrying several creators' purchases, and the charge they share is settled at
 * completion, one transfer per creator (`completeSessionPurchases` in
 * `routes/payments.ts`, whose docblock carries the money reasoning and the counsel-brief
 * pointer).
 */

import { basketItems, db, users, works } from "@anthers/db";
import { MAX_BASKET_ITEMS } from "@anthers/shared/constants";
import { and, asc, eq } from "drizzle-orm";

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
 * Add one Work to the buyer's basket. Any creator's — the basket carries as many
 * creators as the buyer wants, and the checkout settles them on one charge.
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
): Promise<{ ok: true } | { ok: false; reason: BasketAddRefusal }> {
	const [work] = await db
		.select({ id: works.id, creatorId: works.creatorId })
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	// 🚨 A creatorless Work can never be charged (there is no payee), so it is refused
	// here exactly as the checkout's refusal would — the add is where a buyer learns it,
	// the same moment-rule the cap keeps below.
	if (!work || work.creatorId == null) return { ok: false, reason: "not_found" };

	const current = await listBasket(userId);

	// Already in — adding twice is a no-op, because the button is the kind people press
	// again when they are not sure it worked.
	if (current.some((row) => row.workId === workId)) return { ok: true };

	// 🚨 The item cap, from the same constant `resolveBasket` enforces — the add is where a
	// buyer learns the basket is full rather than at checkout, the same moment-rule the
	// creatorless refusal above keeps.
	if (current.length >= MAX_BASKET_ITEMS) return { ok: false, reason: "at_capacity" };

	await db.insert(basketItems).values({ userId, workId });
	return { ok: true };
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
