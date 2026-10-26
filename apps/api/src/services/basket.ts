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
 * **The basket holds any number of creators' items, Works and Badges alike** (Parker,
 * 2026-10-15, the multi-creator decision and the same day's Badge purchase). The
 * replace-on-clash rule this module used to enforce on Works — a second creator's Work
 * wiping the basket — was the dealbreaker the decision removed: a cart is for carrying
 * several creators' purchases, and the charge they share is settled at completion, one
 * transfer per creator (`completeSessionPurchases` in `routes/payments.ts`, whose
 * docblock carries the money reasoning and the counsel-brief pointer). A Badge joins the
 * same basket the same way; its money never transfers at all (support settles through
 * the cycle distribution), and one rung per issuer replaces the last, the pick's own
 * shape.
 */

import { badges, basketItems, db, users, works } from "@anthers/db";
import { MAX_BASKET_ITEMS } from "@anthers/shared/constants";
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";

/**
 * The basket's rows, discriminated by what the line names. A Badges line is the rung the
 * buyer picked; every other row is a Work. The badge side carries the issuer and the
 * rung's threshold — the price the line resolves to at quote/checkout is computed from
 * the buyer's holding, never read off this table (the table holds ids, not facts).
 */
export interface BasketWorkRow {
	kind: "work";
	workId: number;
	title: string | null;
	slug: string | null;
	thumbnail: string | null;
	creatorId: number;
	creatorHandle: string | null;
	/**
	 * How many of a physical good this line means to buy, and the values chosen from its
	 * listing. Both are intent the quote and checkout re-validate: the table holds what
	 * the buyer asked for, never what it costs or whether it is still there.
	 */
	quantity: number;
	options: Array<{ name: string; label: string }> | null;
	addedAt: Date;
	/** Internal ordering only — not part of the answered shape's meaning. */
	rowId: number;
}

export interface BasketBadgeRow {
	kind: "badge";
	badgeId: number;
	label: string | null;
	threshold: string;
	issuerId: number;
	issuerHandle: string | null;
	addedAt: Date;
	/** Internal ordering only — not part of the answered shape's meaning. */
	rowId: number;
}

/**
 * The buyer's basket, oldest first — the order they built it in, which is the order the
 * receipt reads in.
 *
 * Deliberately TWO inner joins built from two queries rather than one left-join maze: a
 * basket carry-anything table left-joining the users table twice (work creator and Badge
 * issuer) pays for a merged shape with alias plumbing everywhere, when each kind is a
 * plain join its own query already answers. A Work row deleted out from under the basket
 * removes the basket row by cascade in the same statement, so an inner join's missing row
 * names a cascade race that the next read heals (the same argument as before the split —
 * it covers the Badge rung identically). The badge counting a ghost is the defect; this
 * cannot.
 */
export async function listBasket(userId: number): Promise<BasketRow[]> {
	const workRows = await db
		.select({
			workId: works.id,
			title: works.title,
			slug: works.slug,
			thumbnail: works.thumbnail,
			creatorId: works.creatorId,
			creatorHandle: users.atprotoHandle,
			quantity: basketItems.quantity,
			options: basketItems.options,
			addedAt: basketItems.addedAt,
			rowId: basketItems.id,
		})
		.from(basketItems)
		.innerJoin(works, eq(basketItems.workId, works.id))
		.innerJoin(users, eq(works.creatorId, users.id))
		.where(eq(basketItems.userId, userId))
		.orderBy(asc(basketItems.addedAt), asc(basketItems.id));

	const badgeRows = await db
		.select({
			badgeId: badges.id,
			label: badges.label,
			threshold: badges.threshold,
			issuerId: badges.creatorId,
			issuerHandle: users.atprotoHandle,
			addedAt: basketItems.addedAt,
			rowId: basketItems.id,
		})
		.from(basketItems)
		.innerJoin(badges, eq(basketItems.badgeId, badges.id))
		.innerJoin(users, eq(badges.creatorId, users.id))
		.where(eq(basketItems.userId, userId))
		.orderBy(asc(basketItems.addedAt), asc(basketItems.id));

	const works$: BasketRow[] = workRows.map((r) => ({
		...r,
		kind: "work" as const,
		// The inner join guarantees a creator for every row that answers (a creatorless
		// Work's rows can't survive the join) — the column is nullable, so it is narrowed
		// here and nowhere else repeats the cast.
		creatorId: r.creatorId as number,
	}));
	const badges$: BasketRow[] = badgeRows.map((r) => ({ ...r, kind: "badge" as const }));
	return [...works$, ...badges$].sort(
		(a, b) => a.addedAt.getTime() - b.addedAt.getTime() || a.rowId - b.rowId,
	);
}

export type BasketRow = BasketWorkRow | BasketBadgeRow;

/** Why an add did not land. */
export type BasketAddRefusal = "not_found" | "at_capacity";
/** Why an Badge add specifically did not land. */
export type BasketAddBadgeRefusal = BasketAddRefusal | "own_ladder";

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
	pick?: { quantity?: number; options?: Array<{ name: string; label: string }> | null },
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
	// again when they are not sure it worked. A re-add that names a pick REPLACES the
	// one in the basket rather than being ignored: a buyer who opens the picker again
	// and chooses a different size means the new choice, exactly as pressing the button
	// twice means "yes, that one".
	if (current.some((row) => row.kind === "work" && row.workId === workId)) {
		if (pick) {
			await db
				.update(basketItems)
				.set({
					...(pick.quantity != null ? { quantity: pick.quantity } : {}),
					...(pick.options !== undefined ? { options: pick.options } : {}),
				})
				.where(and(eq(basketItems.userId, userId), eq(basketItems.workId, workId)));
		}
		return { ok: true };
	}

	// 🚨 The item cap, from the same constant `resolveBasket` enforces — the add is where a
	// buyer learns the basket is full rather than at checkout, the same moment-rule the
	// creatorless refusal above keeps.
	if (current.length >= MAX_BASKET_ITEMS) return { ok: false, reason: "at_capacity" };

	await db.insert(basketItems).values({
		userId,
		workId,
		...(pick?.quantity != null ? { quantity: pick.quantity } : {}),
		...(pick?.options !== undefined ? { options: pick.options } : {}),
	});
	return { ok: true };
}

/**
 * Change what a Work line in the basket asks for — the basket page's own quantity stepper
 * and picker.
 *
 * Refuses a Work that is not in this buyer's basket rather than creating a line: this is
 * the edit door, and "not in your basket" is a real answer to it. What the buyer may ask
 * for is still the checkout's question, not this one's.
 */
export async function updateBasketItem(
	userId: number,
	workId: number,
	pick: { quantity?: number; options?: Array<{ name: string; label: string }> | null },
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	const current = await listBasket(userId);
	if (!current.some((row) => row.kind === "work" && row.workId === workId))
		return { ok: false, reason: "not_found" };
	await db
		.update(basketItems)
		.set({
			...(pick.quantity != null ? { quantity: pick.quantity } : {}),
			...(pick.options !== undefined ? { options: pick.options } : {}),
		})
		.where(and(eq(basketItems.userId, userId), eq(basketItems.workId, workId)));
	return { ok: true };
}

/**
 * Add one Badge to the buyer's basket.
 *
 * The same shape `addBasketItem` keeps, with the Badge shape's one extra rule: **one
 * Badge per issuer — a second rung of the same creator's ladder REPLACES the first**,
 * exactly as a holding's pick does. The basket is the pick being carried; carrying two
 * rungs of one ladder would mean nothing anywhere else.
 *
 * Like the Work add, the only facts checked here are existence and the buyer's own
 * ladder — the ratchet (a rung at or below what the buyer already holds), the chargeable
 * delta, the past-due subscription, are the quote's and checkout's refusals at the money
 * door, where the moment they change is honest.
 */
export async function addBasketBadge(
	userId: number,
	badgeId: number,
): Promise<{ ok: true } | { ok: false; reason: BasketAddBadgeRefusal }> {
	const [badge] = await db
		.select({ id: badges.id, creatorId: badges.creatorId })
		.from(badges)
		.where(eq(badges.id, badgeId))
		.limit(1);
	if (!badge) return { ok: false, reason: "not_found" };
	// 🚨 Nobody holds their own Badge — the same refusal the picker's POST answers, here
	// at the add because the ladder on the buyer's own profile never renders the buttons.
	if (badge.creatorId === userId) return { ok: false, reason: "own_ladder" };

	const current = await listBasket(userId);

	// Already in — the same no-op the Work add keeps.
	if (current.some((row) => row.kind === "badge" && row.badgeId === badgeId)) return { ok: true };

	// 🚨 The item cap, the same moment-rule as the Work add's.
	if (current.length >= MAX_BASKET_ITEMS) return { ok: false, reason: "at_capacity" };

	// The issuer's other rungs leave the basket before this one joins — the pick
	// replaces, one line per ladder.
	const issuerRungs = await db
		.select({ id: badges.id })
		.from(badges)
		.where(eq(badges.creatorId, badge.creatorId));
	if (issuerRungs.length > 0) {
		await db.delete(basketItems).where(
			and(
				eq(basketItems.userId, userId),
				inArray(
					basketItems.badgeId,
					issuerRungs.map((r) => r.id),
				),
				ne(basketItems.badgeId, badgeId),
			),
		);
	}

	await db.insert(basketItems).values({ userId, badgeId });
	return { ok: true };
}

/** Remove one Work from the buyer's basket. Idempotent — absence is already the goal. */
export async function removeBasketItem(userId: number, workId: number): Promise<void> {
	await db
		.delete(basketItems)
		.where(and(eq(basketItems.userId, userId), eq(basketItems.workId, workId)));
}

/** Remove one Badge from the buyer's basket — the Work remove with the Badge side. */
export async function removeBasketBadge(userId: number, badgeId: number): Promise<void> {
	await db
		.delete(basketItems)
		.where(and(eq(basketItems.userId, userId), eq(basketItems.badgeId, badgeId)));
}

/** Empty the buyer's basket — the buyer's own deliberate clear (the `DELETE /basket` door). */
export async function clearBasket(userId: number): Promise<void> {
	await db.delete(basketItems).where(eq(basketItems.userId, userId));
}

/**
 * Clear the lines a completed charge bought — the completion's clean-up, not the
 * checkout's.
 *
 * 🚨 **The basket is intent, and intent survives an abandoned checkout** (Parker,
 * 2026-10-19). The checkout build used to empty the basket the moment a Stripe session
 * existed, so opening the basket page — which builds that session — and then leaving
 * without paying erased what the buyer had chosen. The rows now leave only when the
 * money actually moves: this runs from `completeSessionPurchases`, keyed to the ids the
 * session's own metadata carried, so a line the buyer added after paying (in another tab,
 * before the webhook landed) is theirs to keep rather than collateral.
 *
 * Idempotent, like everything else on the completion path: a redelivered event deletes
 * rows that are already gone.
 */
export async function clearPurchasedBasketItems(
	userId: number,
	workIds: number[],
	badgeIds: number[],
): Promise<void> {
	const bought = [
		...(workIds.length > 0 ? [inArray(basketItems.workId, workIds)] : []),
		...(badgeIds.length > 0 ? [inArray(basketItems.badgeId, badgeIds)] : []),
	];
	if (bought.length === 0) return;
	await db.delete(basketItems).where(and(eq(basketItems.userId, userId), or(...bought)));
}
