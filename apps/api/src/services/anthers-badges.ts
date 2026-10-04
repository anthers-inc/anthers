// SPDX-License-Identifier: Apache-2.0
/**
 * Anthers' own Badge ladder, as rows in `badges`.
 *
 * ⭐ **The ladder is seeded data, not a code constant** (Parker, 2026-10-02): Root, Sprout,
 * Petal and Blossom are ordinary Badges Anthers defines for itself, exactly the way a
 * creator defines their own set, so they live in the one table every ladder lives in.
 * `ANTHERS_BADGES` in `@anthers/shared/constants` remains the source of the ladder's
 * names and thresholds while the seeded-rows migration is its own task — this module is
 * the bridge that makes the rows real in every dev session so no code has to special-case
 * "the Anthers ladder" on the way in.
 *
 * ⭐ **Free is not a rung** (Parker, 2026-10-03, reversing the Free-row artifact): Free is
 * the absence of a Badge — the Badges are overrides on a default, and the default needs no
 * row, exactly as a creator's ungated content requires no "Free" Badge. This module once
 * seeded a Free-at-$0 rung; it now seeds the four real rungs and deletes a stale $0 row
 * its owner holds, so a database seeded before the reversal converges on the new shape.
 *
 * ⭐ **The ladder is identified by ownership, and the owner is identified by its handle**
 * (Parker, 2026-10-04, completing the identity decision): the Anthers creator account is an
 * ordinary `users` row whose public address is `@anthers.org` — see `anthersUserId` below.
 *
 * Idempotent on (creator, threshold): re-running updates the labels rather than
 * duplicating rungs, so a session seed is safe to run repeatedly.
 */

import { db } from "@anthers/db/client";
import { badges, userBadges, users } from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { ANTHERS_BADGES, PLATFORM_HANDLE, supportAmount } from "@anthers/shared/constants";
import { and, eq, sql } from "drizzle-orm";

/** The ladder this module seeds: each paid Badge, in threshold order. */
const ANTHERS_LADDER = [...ANTHERS_BADGES] as const;

/**
 * Ensure the Anthers ladder exists as `badges` rows owned by `ownerUserId`.
 *
 * Returns the rows as they now stand. Thresholds are two-decimal strings so the lookup
 * matches the `numeric` column exactly; the label is the Badge's own name, capitalized
 * the way `badgeLabel` displays it, so a row read straight from the table is already
 * presentable.
 *
 * ⚠️ **Also deletes a $0 row owned by `ownerUserId`, if one exists** — the retired Free
 * rung (see the module header). The reversal left behind a row in every database seeded
 * before it; leaving it would resurrect the marker-row ambiguity this module no longer
 * reads. `user_badges` rows pointing at the deleted rung go with it (CASCADE), which is
 * correct: a holding at $0 is nothing, and the absence that means Free is the state the
 * deletion returns the database to.
 */
export async function ensureAnthersBadges(ownerUserId: number) {
	const rows: (typeof badges.$inferSelect)[] = [];
	for (let i = 0; i < ANTHERS_LADDER.length; i++) {
		const rung = ANTHERS_LADDER[i];
		const threshold = rung.threshold.toFixed(2);
		const label = rung.name.charAt(0).toUpperCase() + rung.name.slice(1);
		// Upsert keyed on (creator, threshold) rather than a label: the label is copy the
		// account may reword, while the threshold is the rung's identity in every money
		// comparison — re-seeding after a reword updates the row rather than adding a
		// second rung at the same price.
		const [row] = await db
			.insert(badges)
			.values({
				creatorId: ownerUserId,
				threshold,
				label,
				description: "Anthers' own set — what this rung carries is each due its own discussion.",
				sortOrder: i,
			})
			.onConflictDoUpdate({
				target: [badges.creatorId, badges.threshold],
				set: { label, sortOrder: i, updatedAt: new Date() },
			})
			.returning();
		rows.push(row);
	}
	await db
		.delete(badges)
		.where(and(eq(badges.creatorId, ownerUserId), eq(badges.threshold, "0.00")));
	return rows;
}

/**
 * Whether this database has no Anthers ladder at all — the check a seeder uses to decide
 * whether it owns the first seeding. `ensureAnthersBadges` is idempotent, so a caller
 * could always call it; the check exists so the *dev-account* seed and the *gauntlet* seed
 * do not fight over which account owns the rows in a database where only one has run —
 * whichever runs first wins, and a session that runs both keeps the first owner.
 *
 * ⭐ **Ownership is how the ladder is recognized** — "does this account hold rungs" —
 * rather than "is there a $0 row anywhere", which is the retired marker-row test.
 *
 * 🚨 **No account also means no ladder**, so the stand-in's absence answers "missing"
 * rather than throwing: the gauntlet's seeding order calls this before creating the
 * stand-in, and the first seeding in a fresh session is exactly the case it exists to
 * catch.
 */
export async function anthersLadderMissing(): Promise<boolean> {
	let anthersId: number;
	try {
		anthersId = await anthersUserId();
	} catch {
		return true;
	}
	const [row] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(eq(badges.creatorId, anthersId))
		.limit(1);
	return row === undefined;
}

/**
 * The Anthers creator account's user id — the account at `@anthers.org`, found by its
 * handle.
 *
 * ⭐ **Identified by handle, first-label match** (Parker, 2026-10-04, completing the
 * identity decision): an account IS an identity and the handle is its public address.
 * The name part — "anthers" — is reserved on the issuing path (`handleNameProblem`), so
 * nobody can claim it by signing up; the production account brought its Bluesky identity,
 * and the dev/test seeds create a stand-in under the same name on the session's own
 * network suffix (`anthers.<suffix>`). Matching the first label therefore answers the
 * question in production and in every session, and the answer is unambiguous because the
 * name is reserved. This replaced the marker-row lookup ("whoever owns the $0 rung"),
 * which a database without a Free row — the correct shape since the 2026-10-03 reversal —
 * could not answer at all.
 *
 * 🚨 **Fails loudly when the account does not exist** — seeding has not run. An unseeded
 * database answering "no badge held" would silently downgrade everybody to Free, which is
 * the failure shape this lookup exists to prevent rather than a state the application
 * tolerates.
 */
export async function anthersUserId(): Promise<number> {
	const name = PLATFORM_HANDLE.split(".")[0];
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(
			sql`${users.atprotoHandle} = LOWER(${PLATFORM_HANDLE}) OR ${users.atprotoHandle} LIKE ${`${name}.%`}`,
		)
		.orderBy(users.id)
		.limit(1);
	if (!row) {
		throw new Error(
			"No Anthers creator account in this database — the Anthers Badge seed has not run (db:seed).",
		);
	}
	return row.id;
}

/**
 * Monthly dollars the Anthers Badge `userId` holds **in cycle `billingCycle`** — what they
 * gave Anthers that cycle, on the Anthers ladder.
 *
 * ⚠️ **This decides access to no Work, and must never be made to.** What money given to
 * Anthers governs is the account-level Public Access limit and the size of the user's
 * Time Pool — neither of which is a property of a Work. Kept because both of those read
 * it, and because it is the Badge.
 */
export async function heldAnthersBadgeAmountInCycle(
	userId: number,
	billingCycle: string,
): Promise<number> {
	// Keep the account lookup ahead of the join so a missing ladder is the loud error above
	// rather than a silent zero inside the query.
	const anthers = await anthersUserId();
	// The Anthers-ladder read — the same shape every creator-side holding read takes: MAX per
	// issuer in the query itself, so two holdings from one issuer in one cycle (which the
	// unique index permits, being keyed on the badge) can never double-count. The
	// higher threshold wins, which is the conservative reading and can only under-grant.
	const [holding] = await db
		.select({ held: sql<string>`MAX(${badges.threshold})` })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(
			and(
				eq(userBadges.userId, userId),
				eq(badges.creatorId, anthers),
				eq(userBadges.billingCycle, billingCycle),
			),
		)
		.groupBy(badges.creatorId)
		.limit(1);
	// ⚠️ **NOT floored**, and flooring it would be a silent money bug rather than a
	// rounding nicety: $2.50 would become $2 and stop clearing its own $2.50 gate.
	return supportAmount(holding?.held ?? "0.00");
}

/**
 * Monthly dollars the Anthers Badge `userId` holds this cycle — the point-in-time read.
 */
export function heldAnthersBadgeAmount(userId: number): Promise<number> {
	return heldAnthersBadgeAmountInCycle(userId, currentCycleKey());
}
