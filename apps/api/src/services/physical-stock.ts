// SPDX-License-Identifier: Apache-2.0
/**
 * Physical stock — the pick a buyer made, what it costs them, and the count it takes off
 * the shelf.
 *
 * Three questions live here, and they are one question asked at three moments:
 *
 *   1. **Is this pick purchasable at all** — does every choice the listing offers have a
 *      value the creator actually offers, and is there one of each name and no more? A
 *      tampered body must buy nothing that is not on the shelf, so the check is made
 *      against the listing rather than against whatever the client sent.
 *   2. **Is there enough of it** — the count a line asks for, checked against each chosen
 *      value's stock. A blank stock means "as many as I can make", which is the ordinary
 *      case for something made to order.
 *   3. **Take it off the shelf, and put it back if the sale never happens** — the reserve
 *      and its release.
 *
 * 🚨 **Reserving at checkout is what stops two buyers winning the last one.** The decrement
 * is a locked read-modify-write inside one transaction (`SELECT … FOR UPDATE`), so the
 * second buyer's transaction sees the first one's count, and a `false` answer is a refusal
 * rather than an oversell. Checking at checkout without taking it would leave the window
 * between the charge and the webhook wide open, which is exactly the window that matters.
 *
 * ⚠️ **A reservation is not a sale, so it has to expire.** A buyer who opens the checkout
 * and walks away would otherwise hold the last one forever; `releaseAbandonedStock` puts a
 * `pending` order's count back once its session has had time to be paid, and stamps the
 * row so a second pass is a no-op.
 */
import { db } from "@anthers/db/client";
import { type PhysicalOption, purchases, workPhysicalListings } from "@anthers/db/schema";
import { MAX_GOODS_PER_ORDER } from "@anthers/shared/constants";
import { and, eq, isNull, lt } from "drizzle-orm";

/** One choice the buyer made: the listing's name, and the value under it they picked. */
export interface PhysicalPick {
	name: string;
	label: string;
}

export type PickProblem = { field: string; message: string };

export type PickValidation =
	| { ok: true; picks: PhysicalPick[]; quantity: number }
	| { ok: false; problems: PickProblem[] };

function cleaned(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Check a buyer's pick against the listing it is buying from.
 *
 * Every failure is collected, as `validateListing` collects them: the surface names what
 * is wrong with the pick rather than bouncing the buyer back for one problem at a time.
 */
export function validatePhysicalPick(
	listing: { options: PhysicalOption[] },
	input: { quantity?: unknown; options?: unknown },
): PickValidation {
	const problems: PickProblem[] = [];

	const rawQuantity = input.quantity == null ? 1 : Number(input.quantity);
	const quantity = Number.isFinite(rawQuantity) ? Math.trunc(rawQuantity) : Number.NaN;
	if (!Number.isInteger(quantity) || quantity < 1) {
		problems.push({ field: "quantity", message: "Choose how many you want." });
	} else if (quantity > MAX_GOODS_PER_ORDER) {
		problems.push({
			field: "quantity",
			message: `A single order carries at most ${MAX_GOODS_PER_ORDER} of one thing.`,
		});
	}

	const raw = Array.isArray(input.options) ? input.options : [];
	const byName = new Map<string, string>();
	for (const entry of raw) {
		const source = (entry ?? {}) as { name?: unknown; label?: unknown };
		const name = cleaned(source.name);
		const label = cleaned(source.label);
		if (!name || !label) {
			problems.push({ field: "options", message: "Every choice needs a value." });
			continue;
		}
		const key = name.toLowerCase();
		if (byName.has(key)) {
			problems.push({ field: "options", message: `“${name}” was chosen twice.` });
			continue;
		}
		byName.set(key, label);
	}

	const picks: PhysicalPick[] = [];
	for (const option of listing.options) {
		const label = byName.get(option.name.toLowerCase());
		if (label == null) {
			problems.push({ field: "options", message: `Choose a ${option.name}.` });
			continue;
		}
		const value = option.values.find((v) => v.label.toLowerCase() === label.toLowerCase());
		if (!value) {
			problems.push({ field: "options", message: `“${label}” is not a ${option.name} we sell.` });
			continue;
		}
		// The count is checked here as well as under the lock: this pass exists to tell the
		// buyer why, and the locked pass exists to decide.
		if (
			Number.isInteger(quantity) &&
			quantity >= 1 &&
			value.stock != null &&
			value.stock < quantity
		) {
			problems.push({
				field: "options",
				message:
					value.stock === 0
						? `${option.name} “${value.label}” has sold out.`
						: `Only ${value.stock} left of ${option.name} “${value.label}”.`,
			});
			continue;
		}
		picks.push({ name: option.name, label: value.label });
	}

	// A choice the listing does not offer is refused rather than ignored: a body naming
	// a value nobody sells is a tampered body, not a buyer's mistake.
	for (const name of byName.keys()) {
		if (!listing.options.some((option) => option.name.toLowerCase() === name)) {
			problems.push({ field: "options", message: `“${name}” is not a choice on this good.` });
		}
	}

	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, picks, quantity };
}

export type ReserveResult = { ok: true } | { ok: false; problems: PickProblem[] };

/**
 * Take a basket's physical picks off the shelf, or refuse the whole charge.
 *
 * 🚨 **One transaction, every line, all or nothing.** A basket that half-reserves is a
 * basket whose buyer is charged for goods nobody can send; the transaction rolls back on
 * the first refusal and the buyer reads why.
 *
 * The listing row is locked (`FOR UPDATE`) before it is read, so two buyers asking for the
 * last one serialize: the second sees the first one's decrement and is refused.
 */
export async function reserveStock(
	lines: Array<{ workId: number; picks: PhysicalPick[]; quantity: number }>,
	now: Date = new Date(),
): Promise<ReserveResult> {
	if (lines.length === 0) return { ok: true };

	// 🚨 **A refusal throws, because drizzle commits a transaction that returns.** An early
	// `return` from this callback would leave the lines it had already decremented
	// committed and the rest refused — a basket refusing a charge while quietly taking
	// stock off the shelf. The sentinel carries the problems out; nothing else catches.
	class Refused extends Error {
		constructor(readonly problems: PickProblem[]) {
			super("stock refused");
		}
	}
	try {
		await db.transaction(async (tx) => {
			for (const line of lines) {
				const [row] = await tx
					.select()
					.from(workPhysicalListings)
					.where(eq(workPhysicalListings.workId, line.workId))
					.limit(1)
					.for("update");
				if (!row) {
					throw new Refused([{ field: "options", message: "This good is no longer for sale." }]);
				}

				const options: PhysicalOption[] = (row.options ?? []).map((option) => ({
					...option,
					values: option.values.map((value) => ({ ...value })),
				}));
				const problems: PickProblem[] = [];
				for (const pick of line.picks) {
					const option = options.find((o) => o.name.toLowerCase() === pick.name.toLowerCase());
					const value = option?.values.find(
						(v) => v.label.toLowerCase() === pick.label.toLowerCase(),
					);
					if (!value) {
						problems.push({
							field: "options",
							message: `“${pick.label}” is no longer available.`,
						});
						continue;
					}
					if (value.stock != null && value.stock < line.quantity) {
						problems.push({
							field: "options",
							message:
								value.stock === 0
									? `${pick.name} “${pick.label}” has sold out.`
									: `Only ${value.stock} left of ${pick.name} “${pick.label}”.`,
						});
						continue;
					}
					if (value.stock != null) value.stock -= line.quantity;
				}
				if (problems.length > 0) throw new Refused(problems);

				await tx
					.update(workPhysicalListings)
					.set({ options, updatedAt: now })
					.where(eq(workPhysicalListings.workId, line.workId));
			}
		});
		return { ok: true };
	} catch (err) {
		if (err instanceof Refused) return { ok: false, problems: err.problems };
		throw err;
	}
}

/** The release, inside a caller's transaction — the shape both doors use. */
async function releaseStockIn(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	lines: Array<{ workId: number; picks: PhysicalPick[]; quantity: number }>,
	now: Date,
): Promise<void> {
	for (const line of lines) {
		const [row] = await tx
			.select()
			.from(workPhysicalListings)
			.where(eq(workPhysicalListings.workId, line.workId))
			.limit(1)
			.for("update");
		if (!row) continue;
		let changed = false;
		const options: PhysicalOption[] = (row.options ?? []).map((option) => ({
			...option,
			values: option.values.map((value) => ({ ...value })),
		}));
		for (const pick of line.picks) {
			const value = options
				.find((o) => o.name.toLowerCase() === pick.name.toLowerCase())
				?.values.find((v) => v.label.toLowerCase() === pick.label.toLowerCase());
			if (!value || value.stock == null) continue;
			value.stock += line.quantity;
			changed = true;
		}
		if (changed) {
			await tx
				.update(workPhysicalListings)
				.set({ options, updatedAt: now })
				.where(eq(workPhysicalListings.workId, line.workId));
		}
	}
}

/**
 * Put reserved counts back on the shelf.
 *
 * The exact inverse of `reserveStock`, keyed by the same names and labels. A value that has
 * since been renamed or removed is skipped rather than conjured back — the creator's
 * listing is theirs, and the count belonged to a value that no longer exists.
 *
 * ⚠️ **Call this only for an order whose reservation is still live.** Nothing here checks
 * whether the stock was already returned; the caller owns that question, because only the
 * caller knows which latch protects it (see `releaseAbandonedStock`).
 */
export async function releaseStock(
	lines: Array<{ workId: number; picks: PhysicalPick[]; quantity: number }>,
	now: Date = new Date(),
): Promise<void> {
	if (lines.length === 0) return;
	await db.transaction(async (tx) => {
		await releaseStockIn(tx, lines, now);
	});
}

/** How long a pending order may hold stock before the sweep puts it back. */
export const ABANDONED_ORDER_HOURS = 24;

/**
 * Release the stock of orders that were opened and never paid.
 *
 * A Checkout Session lives about a day; an order still `pending` at that horizon is a
 * buyer who walked away. Each row is settled in its own transaction with the purchase row
 * locked and the `stock_released_at` stamp written beside the release, so the sweep is
 * idempotent and a crash cannot return the same count twice or lose a return it started.
 *
 * ⚠️ **A sale that completes after the sweep has run is a sale whose stock was already
 * returned**, which is the safe direction to be wrong in: the creator can make one more,
 * and a buyer must never be refused the thing they paid for. The window is a day, far past
 * any webhook delay, so the case is a theoretical one rather than an operational one.
 */
export async function releaseAbandonedStock(
	now: Date = new Date(),
	hours: number = ABANDONED_ORDER_HOURS,
): Promise<number> {
	const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
	const stale = await db
		.select({ id: purchases.id })
		.from(purchases)
		.where(
			and(
				eq(purchases.type, "physical"),
				eq(purchases.status, "pending"),
				isNull(purchases.stockReleasedAt),
				lt(purchases.createdAt, cutoff),
			),
		)
		.limit(200);

	let released = 0;
	for (const { id } of stale) {
		const done = await db.transaction(async (tx) => {
			const [row] = await tx
				.select()
				.from(purchases)
				.where(eq(purchases.id, id))
				.limit(1)
				.for("update");
			// Re-read under the lock: a checkout that completed between the sweep's select
			// and this transaction flipped the status, and a paid order's stock stays sold.
			if (row?.status !== "pending" || row.stockReleasedAt) return false;
			if (row.workId == null) return false;
			await releaseStockIn(
				tx,
				[{ workId: row.workId, picks: row.options ?? [], quantity: row.quantity ?? 1 }],
				now,
			);
			await tx
				.update(purchases)
				.set({ stockReleasedAt: now, updatedAt: now })
				.where(eq(purchases.id, id));
			return true;
		});
		if (done) released += 1;
	}
	return released;
}
