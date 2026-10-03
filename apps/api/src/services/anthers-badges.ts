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
 * ⚠️ **The owner is whichever local account the seed marks as the org, and today that is
 * the main dev account** — no `@anthers.org`-style account exists in a local session, and
 * whether the org identity owns badge rows as an ordinary `users` row is exactly what the
 * identity decision (*Decide what an identity is*) holds open. Until it lands, the ladder
 * is seeded owned by the dev account with this note saying so; the identity task decides
 * the real owner and the seeding follows it.
 *
 * Idempotent on (creator, threshold): re-running updates the labels rather than
 * duplicating rungs, so a session seed is safe to run repeatedly.
 */

import { db } from "@anthers/db/client";
import { badges } from "@anthers/db/schema";
import { ANTHERS_BADGES, FREE_BADGE } from "@anthers/shared/constants";

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