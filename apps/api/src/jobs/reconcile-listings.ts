// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Find Works whose public listing disagrees with the Work, and queue a sync for each.
 *
 * 🚨 **The per-event enqueues are the latency; this is the guarantee.** Every path that can
 * change a Work's publishability asks for a sync as it goes, and each of those can still be
 * lost: `queueWorkListingSync` swallows a failure to enqueue on purpose — a creator's release
 * must not fail because a queue blinked — a job can exhaust its retries against a node that was
 * down all night, and a state changed directly in SQL asks for nothing at all. Without a sweep,
 * every one of those leaves a listing advertising something that is no longer listed, and
 * nothing ever notices.
 *
 * ⚠️ **It looks for DISAGREEMENT rather than recency**, so it is cheap and self-limiting: a
 * Work whose listing is already correct is never touched, and a sweep that finds nothing does
 * one query. It enqueues rather than syncing inline, so the reconciling and the writing share
 * one code path and one set of retries.
 *
 * ⭐ **The two halves are not symmetrical and the ordering says so.** A record that should not
 * exist is a live disclosure — something withdrawn, taken down, quarantined, or rated Adult,
 * still being advertised — and it is found first. A record that is merely missing is a listing
 * nobody has, which is a smaller problem and can wait behind it.
 */
import { db } from "@anthers/db";
import { hostedAccounts, works } from "@anthers/db/schema";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { queueWorkListingSync } from "../services/work-listing.js";

/** How many Works one sweep will queue. A ceiling, so a first run cannot flood the queue. */
const SWEEP_LIMIT = 500;

export async function reconcileListings(): Promise<void> {
	// ── Records that should not exist ────────────────────────────────────
	//
	// Deliberately expressed as "has a URI and is not plainly publishable" rather than as the
	// negation of `unpublishableReason`, because that function is TypeScript and this is SQL:
	// keeping them in step is impossible, so this is the loose net and the job re-checks
	// properly. Over-selecting costs a read per Work; under-selecting leaves a disclosure up.
	const stale = await db
		.select({ id: works.id })
		.from(works)
		.where(
			and(
				isNotNull(works.atprotoUri),
				sql`(
					${works.visibility} <> 'released'
					OR ${works.takedownStatus} <> 'active'
					OR ${works.quarantineStatus} = 'quarantined'
					OR ${works.maturity} NOT IN ('general', 'mature')
					OR ${works.releasedAt} IS NULL
					OR ${works.creatorId} IS NULL
				)`,
			),
		)
		.limit(SWEEP_LIMIT);

	for (const row of stale) await queueWorkListingSync(row.id);

	// ── Records that should exist and do not ─────────────────────────────
	//
	// Joined against `hosted_accounts` so this asks only about creators Anthers can actually
	// write for. Without it every released Work by every creator without a handle would be
	// selected on every sweep, for ever, to be skipped each time.
	const remaining = SWEEP_LIMIT - stale.length;
	const missing =
		remaining <= 0
			? []
			: await db
					.select({ id: works.id })
					.from(works)
					.innerJoin(hostedAccounts, eq(hostedAccounts.userId, works.creatorId))
					.where(
						and(
							isNull(works.atprotoUri),
							eq(works.visibility, "released"),
							eq(works.takedownStatus, "active"),
							eq(works.quarantineStatus, "none"),
							isNotNull(works.releasedAt),
							sql`${works.maturity} IN ('general', 'mature')`,
						),
					)
					.limit(remaining);

	for (const row of missing) await queueWorkListingSync(row.id);

	if (stale.length > 0 || missing.length > 0) {
		console.log(
			`[reconcile-listings] queued ${stale.length} to remove or correct, ${missing.length} to publish`,
		);
	}
}
