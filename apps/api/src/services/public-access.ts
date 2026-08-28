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
import {
	NO_PUBLIC_ACCESS_ALLOWANCE,
	type PublicAccessBudget,
	publicAccessBudget,
	type ShareLinkBudget,
	shareLinkBudget,
} from "@anthers/shared/public-access";
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
 * 🚨 **A signed-out caller has no allowance, and this returned the full one until
 * 2026-08-28.** The old answer was `publicAccessBudget(0, 0)` — ten hours, nothing spent —
 * justified in a comment as the shop window. Anonymous viewing was never approved
 * (21.01 §9.1): consuming a Work requires an account, because that is how terms are
 * accepted, how 13+ is asserted, and above all how attention is attributed, since the Time
 * Pool cannot pay a creator for time it cannot attribute to anybody. So the generous answer
 * was not merely wrong about policy, it was the thing that let anonymous Public Access
 * streaming run unmetered while the creator earned nothing for it.
 */
export async function loadPublicAccessBudget(
	userId: number | null,
	now: Date = new Date(),
): Promise<PublicAccessBudget> {
	if (userId == null) return NO_PUBLIC_ACCESS_ALLOWANCE;

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

/**
 * Seconds watched through this sharer's **share links** in the current calendar month.
 *
 * 🚨 **Counts every `via_share_link` row, `public_access` or not, and that is not an
 * oversight.** The two flags bound different things. `public_access` says whether the seconds
 * buy a creator anything out of the Time Pool; this budget bounds *relay volume* — how much
 * viewing one account may fund for strangers — and a creator sharing their own Work still
 * consumes the relay even though it earns nothing. Filtering here would leave the one case
 * that most obviously wants bounding unbounded.
 */
export async function shareLinkSecondsThisMonth(
	sharerId: number,
	now: Date = new Date(),
): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, sharerId),
				eq(attentionEvents.viaShareLink, true),
				gte(attentionEvents.createdAt, monthStart(now)),
				lt(attentionEvents.createdAt, monthEnd(now)),
			),
		);
	return Number(row?.total ?? 0);
}

/**
 * How much more viewing this sharer's links may fund this month.
 *
 * No account lookup, because there is nothing about the account that changes the answer:
 * the share-link budget is a flat constant for everybody, paying or not. Giving Anthers the
 * Public Access price removes the limit on *your* viewing and buys no relay for strangers —
 * see `SHARED_PUBLIC_ACCESS_SECONDS` for why deriving this from the sharer's own allowance
 * would hand an unlimited account an unlimited relay, which is the anonymous streaming that
 * requiring an account for delivery exists to close.
 */
export async function loadShareLinkBudget(
	sharerId: number,
	now: Date = new Date(),
): Promise<ShareLinkBudget> {
	return shareLinkBudget(await shareLinkSecondsThisMonth(sharerId, now));
}
