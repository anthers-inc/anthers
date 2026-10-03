// SPDX-License-Identifier: Apache-2.0
/**
 * Account suspension as a read-side filter — the listing half of "the account goes dark".
 *
 * `services/moderation.ts` owns the *write* (`suspendAccount`/`unsuspendAccount`); this
 * module owns the *read*: the SQL predicate every public listing composes so that a
 * suspended account's presence stops reaching anyone, on the pattern `notBlockedBy` and
 * `maturityHiddenFrom` already set. It is a **query condition rather than a lock met on
 * arrival** — a suspended account's Works, posts and profile are absent from every
 * listing and page read, which is what makes hiding survive a route somebody forgot.
 *
 * What this deliberately does NOT withhold, because suspension is a state and not a
 * confiscation:
 *
 * - **A buyer's existing purchases.** The Library and its downloads keep working —
 *   "what you buy stays yours" is the rescue-window doctrine, and a suspension is less
 *   final than the creator deletion it is already overridden for.
 * - **The suspended account's own view of itself.** The account cannot sign in at all,
 *   so the question never arises in a listing context; what it can reach is the appeal
 *   and export path, which are operator-adjacent rather than listings.
 */

import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq, type SQL, sql } from "drizzle-orm";

/**
 * The handle of the production automated-test account — the account the live-site test
 * suite signs in as and exercises the real routes through, kept rather than spun down
 * because automated testing needs a standing account to be. It is hidden from every
 * public listing by handle rather than by a row flag, so nothing about the account
 * itself has to change to hide it; scope decided with Parker 2026-10-02 — this one
 * account, not a general mechanism.
 */
export const HIDDEN_TEST_ACCOUNT_HANDLE = "anthers-test.anthers.social";

/**
 * A SQL predicate excluding rows whose `userColumn` names the automated-test account —
 * the listing half only. Its Works, posts and profile stay reachable by direct link,
 * because direct links are the point of keeping the account: the test suite drives real
 * routes at it, and a reader who follows a link somewhere still arrives at a page that
 * answers. What it drops out of is every listing — the feed, Discover, the commons, the
 * follow and project lists — beside `notSuspendedAccount` so the account reads as absent
 * rather than as a state somebody could name.
 *
 * Matches on the handle alone: a handle no row holds matches nothing, so dev sessions
 * (where no account carries this handle) run unchanged without any configuration.
 */
export function notTestAccount(userColumn: SQL | unknown): SQL | undefined {
	return sql`NOT EXISTS (
		SELECT 1 FROM ${users} u
		WHERE u.id = ${userColumn} AND u.atproto_handle = ${HIDDEN_TEST_ACCOUNT_HANDLE}
	)`;
}

/**
 * A SQL predicate excluding rows whose `userColumn` names a suspended account.
 *
 * Written as a NOT EXISTS over `users` rather than a join so it composes into an
 * `and()` beside `notBlockedBy` and `maturityHiddenFrom` without changing the shape
 * of the query around it, and applies before any LIMIT for the same reason
 * `notBlockedBy` cites: filtering a page after the fact silently returns short pages.
 *
 * The suspension's `suspended_until` is deliberately NOT read here: an expired
 * suspension is lifted by the sweep clearing both columns, not by every reader
 * racing the clock. A reader that computed "suspended but past its end" would show
 * the account a beat before the log records the lift — and an appeal reads the log.
 */
export function notSuspendedAccount(userColumn: SQL | unknown): SQL | undefined {
	return sql`NOT EXISTS (
		SELECT 1 FROM ${users} u
		WHERE u.id = ${userColumn} AND u.suspended_at IS NOT NULL
	)`;
}

/**
 * Whether one account is suspended right now — for the checks that act on a single,
 * already-loaded row (a profile read, a Work page's creator) rather than filtering a
 * listing. Mirrors `notSuspendedAccount` so the two never disagree about the predicate.
 */
export async function isSuspendedAccount(userId: number): Promise<boolean> {
	if (userId == null) return false;
	const row = await db
		.select({ suspendedAt: users.suspendedAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row.length > 0 && row[0]!.suspendedAt != null;
}
