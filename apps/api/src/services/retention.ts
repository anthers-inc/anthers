// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retention — the one place that ages out the personal detail in our safety and
 * copyright records.
 *
 * **Redaction, never deletion** (Parker, 2026-08-16). The row stays; the personal
 * fields are blanked in place. That is not a compromise between two positions, it
 * is the only shape that satisfies both obligations at once:
 *
 * - **§ 512(i) conditions the safe harbor on a repeat-infringer policy that is
 *   *reasonably implemented*,** and the Terms of Service now publicly says we judge a pattern.
 *   A pattern is *how many notices, against whom, upheld or not* — the sender's
 *   home address is no part of it. Deleting the row would destroy the evidence;
 *   keeping the address would hold PII for a purpose that had expired.
 * - **"Why was this removed?" must stay answerable.** 40.06's founding constraint
 *   is that removal is a state and never a `DELETE`, precisely so an appeal years
 *   later has something to read. A retention rule that deleted these rows would
 *   reintroduce, on a timer, exactly the failure that document exists to prevent.
 *
 * **Three years**, from the last thing that happened to the record. The anchor is
 * 17 U.S.C. § 507(b): the copyright limitation period, which also bounds a
 * § 512(f) misrepresentation claim in *either* direction — the complainant's
 * against us, and the creator's against them. So the contact details survive
 * exactly as long as somebody could still sue over the notice, and no longer.
 * One number covers moderation reports too, because a retention section with a
 * different figure per table is one nobody can follow and nobody notices breaking.
 *
 * 🚨 **A live dispute suspends the clock.** A notice with `suitFiledAt` set is
 * never redacted, whatever its age — destroying a party's contact details while
 * they are in front of a federal court is the one version of this that could do
 * real harm.
 *
 * What is deliberately NOT here:
 *
 * - **`moderation_actions` is kept indefinitely and is not swept.** It is *our*
 *   record — our operator, our note, our decision — and carries no member of the
 *   public's contact details. It is the thing that answers the appeal, and it is
 *   minimal by construction. (Consequence worth stating where operators can see
 *   it: a note is permanent, so it is not the place to write down somebody's
 *   personal details.)
 * - **Sessions** already carry the only IP addresses Anthers holds, and they are
 *   deleted on expiry by `PRUNE_CREDENTIALS` — transient operational data, not
 *   durable retention. Nothing here changes that. If charge-time IP capture is
 *   ever adopted for CE3.0 it inherits this rule: a new retention purpose needs a
 *   stated period before the first row is written, not after.
 */

import { db } from "@anthers/db/client";
import { type CounterNotice, dmcaNotices, moderationReports } from "@anthers/db/schema";
import { RECORD_REDACTION_YEARS } from "@anthers/shared/constants";
import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { redactClosedAbuseReports } from "./abuse-reports.js";
import { allHeldSubjectIds } from "./legal-hold.js";

/** The cutoff: records whose last activity is older than this lose their personal detail. */
export function redactionCutoff(now = new Date()): Date {
	const cutoff = new Date(now);
	cutoff.setFullYear(cutoff.getFullYear() - RECORD_REDACTION_YEARS);
	return cutoff;
}

/**
 * Blank the complainant's contact details on DMCA notices past the clock, and the
 * subscriber's on any counter-notice attached to them.
 *
 * **Scoped to SETTLED notices.** A notice still working its way through — received,
 * screening, actioned-but-not-final, counter-noticed and awaiting its restore — is
 * live work, and blanking the address of someone we may still need to write to
 * would break the process rather than tidy it. So the sweep takes only notices
 * that reached an end: finalized, or rejected, restored or withdrawn.
 *
 * The clock runs from the **last thing that happened** rather than from receipt,
 * which is both easier to state in the policy and impossible to game by letting a
 * notice sit.
 *
 * What survives: the notice, its status and dates, the Work and its title, the
 * outcome, how many buyers were refunded, and the attestation text — everything
 * the repeat-infringer record and an appeal are made of. What goes: name, email,
 * postal address, telephone, on both sides.
 */
export async function redactSettledDmcaNotices(now = new Date()): Promise<{ redacted: number }> {
	const cutoff = redactionCutoff(now);

	// The last thing that happened to this notice. `receivedAt` is NOT NULL, so the
	// GREATEST always resolves and a notice can never look older than its own arrival.
	//
	// ⚠️ The bound is `${cutoff.toISOString()}::timestamptz`, not a bare Date.
	// Drizzle infers a bind parameter's encoder from the COLUMN it is compared
	// against, and there is no column here — the left side is a computed
	// expression — so a raw `Date` reaches postgres-js untyped and throws
	// `ERR_INVALID_ARG_TYPE` at bind time. It fails loudly in a test and would
	// have failed *silently in a nightly cron*, which is the same shape as the
	// restore sweep that never once ran.
	const lastActivity = sql`greatest(
		${dmcaNotices.receivedAt},
		coalesce(${dmcaNotices.actionedAt}, ${dmcaNotices.receivedAt}),
		coalesce(${dmcaNotices.rejectedAt}, ${dmcaNotices.receivedAt}),
		coalesce(${dmcaNotices.counterNoticeFiledAt}, ${dmcaNotices.receivedAt}),
		coalesce(${dmcaNotices.finalizedAt}, ${dmcaNotices.receivedAt})
	) <= ${cutoff.toISOString()}::timestamptz`;

	const rows = await db
		.select({ id: dmcaNotices.id, counterNotice: dmcaNotices.counterNotice })
		.from(dmcaNotices)
		.where(
			and(
				isNull(dmcaNotices.redactedAt),
				// A live suit suspends the clock entirely.
				isNull(dmcaNotices.suitFiledAt),
				// Settled only — see the note above.
				or(
					sql`${dmcaNotices.finalizedAt} IS NOT NULL`,
					inArray(dmcaNotices.status, ["rejected", "restored", "withdrawn"]),
				),
				lastActivity,
			),
		);

	for (const row of rows) {
		// The counter-notice is jsonb, so its contact block is blanked field by field
		// rather than by dropping the object — the attestation the subscriber agreed
		// to, and when they agreed to it, are part of the record and stay.
		const counterNotice: CounterNotice | null = row.counterNotice
			? {
					...row.counterNotice,
					subscriberName: "",
					subscriberAddress: "",
					subscriberPhone: "",
				}
			: null;

		await db
			.update(dmcaNotices)
			.set({
				complainantName: "",
				complainantEmail: "",
				complainantAddress: "",
				complainantPhone: "",
				counterNotice,
				redactedAt: now,
			})
			.where(eq(dmcaNotices.id, row.id));
	}

	return { redacted: rows.length };
}

/**
 * Drop the reporter's own words and the link to who they were, on reports past
 * the clock.
 *
 * **Scoped to closed reports** — an open one is unfinished work, and a report
 * nobody has looked at in three years is a queue failure rather than a retention
 * case. What survives is the report, its reason and its outcome, which is what the
 * subject's history is made of; what goes is `details`, the one free-text field a
 * member of the public wrote, and `reporterId`.
 *
 * ⚠️ Nulling `reporterId` is safe against the unique index on
 * `(reporter_id, subject_type, subject_id)` because Postgres treats NULLs as
 * distinct — several redacted reports about one subject do not collide. Account
 * deletion already relies on the same property (`reporterId` is `set null`).
 */
export async function redactClosedModerationReports(
	now = new Date(),
): Promise<{ redacted: number }> {
	const cutoff = redactionCutoff(now);
	// Cast the bound explicitly — see the note in `redactSettledDmcaNotices` for
	// why a bare Date cannot be compared against a computed expression.
	const settled = sql`coalesce(${moderationReports.resolvedAt}, ${moderationReports.createdAt}) <= ${cutoff.toISOString()}::timestamptz`;

	// 🚨 A redaction is a destruction for legal-hold purposes, and it is easy to miss
	// that because nothing here says DELETE. Blanking `details` and nulling `reporterId`
	// removes the reporter's own words and the link to who they were — which is exactly
	// what a preservation order covers. A held report keeps both until the hold lifts,
	// and then ages out on the ordinary schedule.
	const heldReports = await allHeldSubjectIds("report", now);
	const notHeld =
		heldReports.length > 0 ? notInArray(moderationReports.id, heldReports) : undefined;

	const rows = await db
		.update(moderationReports)
		.set({ details: "", reporterId: null, redactedAt: now })
		.where(
			and(
				isNull(moderationReports.redactedAt),
				ne(moderationReports.status, "open"),
				settled,
				notHeld,
			),
		)
		.returning({ id: moderationReports.id });

	return { redacted: rows.length };
}

/**
 * Every sweep, for the scheduled job.
 *
 * The public illegal-content intake is redacted by `services/abuse-reports.ts`, which
 * owns that table, and is *called* from here so there is one nightly sweep rather than
 * two things to notice had stopped running. The cutoff is computed once and passed in, so
 * the three sweeps cannot end up disagreeing about where the line is.
 */
export async function runRetentionSweep(now = new Date()): Promise<{
	dmcaNotices: number;
	moderationReports: number;
	abuseReports: number;
}> {
	const notices = await redactSettledDmcaNotices(now);
	const reports = await redactClosedModerationReports(now);
	const publicReports = await redactClosedAbuseReports(redactionCutoff(now), now);
	return {
		dmcaNotices: notices.redacted,
		moderationReports: reports.redacted,
		abuseReports: publicReports.redacted,
	};
}
