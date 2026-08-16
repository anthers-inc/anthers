// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Public Access meter's database half — reading how much of the commons a viewer has
 * watched this month, and deciding whether they may watch more.
 *
 * The **policy** is `@anthers/shared/public-access`, which is pure and knows nothing about
 * a database; this module is the boundary that feeds it. Same split as `attention.ts` and
 * `services/access.ts`: the rules live somewhere exhaustively testable, and the I/O lives
 * where it can be seen.
 *
 * 🚨 **The meter is enforced at DELIVERY, not in `resolveAccessSync`.** Two reasons, and
 * the second is structural:
 *
 *   1. `resolveAccessSync` is pure and synchronous precisely so a Catalog page can resolve
 *      a batch of Works without an N+1. A per-Work database read would destroy that.
 *   2. **The meter is not a property of the Work.** `resolveAccess` answers "may this
 *      viewer consume this Work", which for Public Access is unconditionally yes — the
 *      Work is free to everyone, and it stays free to everyone. What runs out is the
 *      *account's* monthly allowance. Encoding it as a Work-level denial is how the
 *      commons quietly becomes stratified again, which is the thing retiring Anthers Gates
 *      was for.
 *
 * So a Work never reports itself gated by the meter. Bytes are withheld at the endpoints
 * that serve them, and the remaining budget is surfaced separately so the UI can say what
 * happened.
 */

import { db } from "@anthers/db/client";
import { accounts, attentionEvents } from "@anthers/db/schema";
import { supportAmount } from "@anthers/shared/constants";
import { type PublicAccessBudget, publicAccessBudget } from "@anthers/shared/public-access";
import { and, eq, gte, lt, sql } from "drizzle-orm";

/** First instant of the current calendar month, in server time. */
function monthStart(now: Date = new Date()): Date {
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** First instant of the next calendar month. */
function monthEnd(now: Date = new Date()): Date {
	return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

/**
 * Public Access seconds this viewer has watched in the current calendar month.
 *
 * Reads the stamped `public_access` flag rather than joining to `works` and re-deciding —
 * see the column's own note. A viewer with no attention rows sums to zero.
 */
export async function publicAccessSecondsThisMonth(
	userId: number,
	now: Date = new Date(),
): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, userId),
				eq(attentionEvents.publicAccess, true),
				gte(attentionEvents.createdAt, monthStart(now)),
				lt(attentionEvents.createdAt, monthEnd(now)),
			),
		);
	return Number(row?.total ?? 0);
}

/**
 * A viewer's standing against the meter right now.
 *
 * A logged-out viewer gets the free allowance with nothing spent — they cannot have
 * consumed anything we could attribute to them. That is deliberately generous rather than
 * a refusal: anonymous streaming of the commons is the shop window, and the honest place
 * to meter someone is once they have an account to meter.
 */
export async function loadPublicAccessBudget(
	userId: number | null,
	now: Date = new Date(),
): Promise<PublicAccessBudget> {
	if (userId == null) return publicAccessBudget(0, 0);

	const [[acct], used] = await Promise.all([
		db
			.select({ anthersSupport: accounts.anthersSupport })
			.from(accounts)
			.where(eq(accounts.userId, userId))
			.limit(1),
		publicAccessSecondsThisMonth(userId, now),
	]);

	return publicAccessBudget(supportAmount(acct?.anthersSupport), used);
}
