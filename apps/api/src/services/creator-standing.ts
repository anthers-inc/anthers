// SPDX-License-Identifier: Apache-2.0
/**
 * Who is a creator, in one place.
 *
 * 🚨 **`creatorMode` is not this question** (Parker, 2026-10-24). Creator mode is a
 * self-serve switch behind a verified email, so it says what interface the person is owed —
 * the Studio and the settings that finish the job — and nothing about standing. A person
 * who has turned it on and stopped is somebody who has indicated they want to be a creator.
 *
 * ⭐ **A creator has the switch on and has completed payout setup.** That is the answer this
 * module gives, and it is the one every gate that claims somebody is a creator must ask:
 * creator discovery, creator search, whether an account may receive directed money, and the
 * Discord roles. It is deliberate that this is expressed without the Work count and without
 * the ATProto publishing grant:
 *
 * - **Not a released Work.** A creator who has published posts and released no Work is a
 *   creator. The predicate this replaced (`@anthers/shared/verified-creator`, retired
 *   2026-10-24) required at least one released Work, which is a claim about having made
 *   something rather than about being a creator, and it gated the Discord creators channels
 *   on it.
 * - **Not the publishing grant.** A grant is a scope in the person's own repository, and it
 *   can lapse for reasons entirely outside Anthers — their server revoking it, a retired
 *   catalog set, an outage during a re-grant. Treating that as a loss of standing would
 *   remove a working creator from discovery and stop their Stickers until they visited a
 *   banner, and neither of those has anything to do with whether they can write a record
 *   today. `publishRefusal` asks the grant at the moment publishing needs it.
 *
 * ⚠️ **The two forms below answer one predicate and must never disagree**, which is the same
 * arrangement `account-visibility.ts` uses for suspension: {@link isCreatorWhere} composes
 * into a listing's `where` or `select`, and {@link isCreator} answers for one already-loaded
 * row. A test asserts the pair over the boundaries that make the difference real, because a
 * listing that includes an account the single-row answer excludes is the kind of drift
 * nothing else would notice.
 */
import { db } from "@anthers/db/client";
import { stripeAccounts, users } from "@anthers/db/schema";
import { eq, type SQL, sql } from "drizzle-orm";
import { canBePaid } from "./payouts.js";

/**
 * A SQL predicate answering "is `userColumn` a creator", for listings and computed columns.
 *
 * Written as one self-contained EXISTS so it composes into `and()` beside `notBlockedBy` and
 * `notSuspendedAccount` without changing the shape of the query around it, and so it applies
 * before any LIMIT — filtering a page after the fact silently returns short pages.
 */
export function isCreatorWhere(userColumn: SQL | unknown): SQL {
	return sql`(
		${userColumn} IN (SELECT c.id FROM ${users} c WHERE c.creator_mode = true)
		AND ${userColumn} IN (
			SELECT sa.user_id FROM ${stripeAccounts} sa
			WHERE sa.onboarding_complete = true AND sa.payouts_enabled = true
		)
	)`;
}

/**
 * Whether one account is a creator — for a check that already has its id rather than a
 * listing to filter. Mirrors {@link isCreatorWhere} so the two never disagree; the payout
 * half is `canBePaid`, which is the one place payable-ness is defined.
 */
export async function isCreator(userId: number): Promise<boolean> {
	if (userId == null) return false;
	const [row] = await db
		.select({ creatorMode: users.creatorMode })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (row?.creatorMode !== true) return false;
	return canBePaid(userId);
}
