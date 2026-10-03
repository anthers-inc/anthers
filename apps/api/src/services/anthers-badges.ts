// SPDX-License-Identifier: Apache-2.0
/**
 * Anthers' own Badge ladder, as rows in `badges`.
 *
 * ⭐ **The ladder is seeded data, not a code constant** (Parker, 2026-10-02): Free,
 * Root/Sprout/Petal/Blossom are ordinary Badges Anthers defines for itself, exactly the
 * way a creator defines their own set, so they live in the one table every ladder lives
 * in. `ANTHERS_BADGES`/`FREE_BADGE` in `@anthers/shared/constants` remain the source of
 * the ladder's names and thresholds while the seeded-rows migration is its own task —
 * this module is the bridge that makes the rows real in every dev session so no code has
 * to special-case "the org's ladder" on the way in.
 *
 * ⭐ **The ladder is identified by ownership, and the owner is the Free rung's holder**
 * (the identity decision, 2026-10-03 — see `orgOwnerUserId` below): dev's ladder is seeded
 * owned by the dev account, and production's seeding targets the `@anthers.org` account —
 * a follow-up that touches the seed, not the readers.
 *
 * Idempotent on (creator, threshold): re-running updates the labels rather than
 * duplicating rungs, so a session seed is safe to run repeatedly.
 */

import { db } from "@anthers/db/client";
import { badges, userBadges } from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { ANTHERS_BADGES, FREE_BADGE, supportAmount } from "@anthers/shared/constants";
import { and, eq, sql } from "drizzle-orm";

/** The ladder this module seeds: Free at $0, then each paid Badge, in threshold order. */
const ANTHERS_LADDER = [FREE_BADGE, ...ANTHERS_BADGES] as const;

/**
 * Ensure the Anthers ladder exists as `badges` rows owned by `ownerUserId`.
 *
 * Returns the rows as they now stand. Thresholds are two-decimal strings so the lookup
 * matches the `numeric` column exactly; the label is the Badge's own name, capitalized
 * the way `badgeLabel` displays it, so a row read straight from the table is already
 * presentable.
 */
export async function ensureAnthersBadges(ownerUserId: number) {
	const rows: (typeof badges.$inferSelect)[] = [];
	for (let i = 0; i < ANTHERS_LADDER.length; i++) {
		const rung = ANTHERS_LADDER[i];
		const threshold = rung.threshold.toFixed(2);
		const label = rung.name.charAt(0).toUpperCase() + rung.name.slice(1);
		// Upsert keyed on (creator, threshold) rather than a label: the label is copy the
		// org may reword, while the threshold is the rung's identity in every money
		// comparison — re-seeding after a reword updates the row rather than adding a
		// second rung at the same price.
		const [row] = await db
			.insert(badges)
			.values({
				creatorId: ownerUserId,
				threshold,
				label,
				description:
					rung.threshold === 0
						? "The rung every account holds by default."
						: "Anthers' own set — what this rung carries is each due its own discussion.",
				sortOrder: i,
			})
			.onConflictDoUpdate({
				target: [badges.creatorId, badges.threshold],
				set: { label, sortOrder: i, updatedAt: new Date() },
			})
			.returning();
		rows.push(row);
	}
	return rows;
}

/**
 * Whether this database has no org ladder at all — the check a seeder uses to decide
 * whether it owns the first seeding. `ensureAnthersBadges` is idempotent, so a caller
 * could always call it; the check exists so the *dev-account* seed and the *gauntlet* seed
 * do not fight over which account owns the rows in a database where only one has run —
 * whichever runs first wins, and a session that runs both keeps the first owner.
 */
export async function orgLadderMissing(): Promise<boolean> {
	const [row] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(eq(badges.threshold, "0.00"))
		.limit(1);
	return row === undefined;
}

/**
 * The org identity's user id — the owner of the seeded Free-at-$0 rung.
 *
 * ⭐ **The ladder is identified by ownership, not by a type column** (Parker's identity
 * decision, 2026-10-03): an account IS an identity, the org is an ordinary `users` row, and
 * its Badge rows are whoever owns the rung only Anthers' own set carries — a creator's
 * ladder has nothing to sell at Free, so a `$0` Badge is unambiguous in practice. Every
 * org-ladder read routes through here, so production naming the real owner is one
 * implementation away and no call site moves; `ensureAnthersBadges` seeds dev's ladder
 * owned by the dev account, which makes this answer resolve in every dev session, and
 * production seeding targets the real `@anthers.org` account (the recorded follow-up).
 *
 * 🚨 **Fails loudly when there is no org ladder at all** — seeding has not run. An
 * unseeded database answering "no badge held" would silently downgrade everybody to
 * Free, which is the failure shape this lookup exists to prevent rather than a state the
 * application tolerates.
 */
export async function orgOwnerUserId(): Promise<number> {
	const [row] = await db
		.select({ id: badges.creatorId })
		.from(badges)
		.where(eq(badges.threshold, "0.00"))
		.orderBy(badges.id)
		.limit(1);
	if (!row) {
		throw new Error(
			"No org ladder in this database — the Anthers Badge seed has not run (db:seed).",
		);
	}
	return row.id;
}

/**
 * Monthly dollars the Anthers Badge `userId` holds **in cycle `billingCycle`** — what they
 * gave Anthers that cycle, on the org's ladder.
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
	// Keep the org lookup ahead of the join so a missing ladder is the loud error above
	// rather than a silent zero inside the query.
	const org = await orgOwnerUserId();
	// The org-ladder read — the same shape every creator-side holding read takes: MAX per
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
				eq(badges.creatorId, org),
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
