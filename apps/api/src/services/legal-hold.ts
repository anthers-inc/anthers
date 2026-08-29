// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Legal holds — the one place a hold is placed, lifted, or asked about.
 *
 * A hold suspends **automated destruction** of what it names. It exists because
 * § 4.4 of the Document Retention and Destruction Policy requires every scheduled
 * deletion Anthers operates to have an off switch a human can reach, in as many
 * words: *"a retention rule that cannot be switched off is a defect to be fixed,
 * not a defense."* Until this module there was no switch at all.
 *
 * 🚨 **This is general on purpose, and the first caller being CSAM is incidental.**
 * A completed CyberTipline report is itself a one-year preservation request under
 * 18 U.S.C. § 2258A(h) — but a subpoena, an audit and a live suit all need the same
 * mechanism, and a CSAM-only flag would have to be generalized later while two
 * roadmap milestones argued about whether the work was done. What is specific to
 * the statutory case is only the clock, and that is an argument to `placeHold`.
 *
 * **Nothing here deletes.** Lifting a hold stamps `liftedAt` and leaves the row, so
 * the record of what was preserved and why survives the preservation — the same rule
 * `moderation_actions` follows, and for the same reason: the question *"why did this
 * survive the sweep?"* has to have an answer years later.
 *
 * ⚠️ **A hold is not a permission check.** It stops sweeps, not people. A user under
 * hold can still be served, still sign in, and still be moderated; what cannot happen
 * is a cron job destroying the thing while an obligation to keep it is live.
 */
import { db } from "@anthers/db/client";
import { abuseReports, legalHolds, moderationReports, users, works } from "@anthers/db/schema";
import { PRESERVATION_HOLD_YEARS } from "@anthers/shared/constants";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";

/**
 * What a hold can name. Deliberately small — add a kind when a sweep needs it.
 *
 * `report` is a `moderation_reports` row and `abuse_report` is an `abuse_reports` row.
 * They are separate because the tables are: ids collide across them, so one value
 * covering both would hold the wrong row half the time.
 */
export type HoldSubjectType = "user" | "work" | "report" | "abuse_report";

/**
 * The date a § 2258A(h) preservation hold placed now would expire.
 *
 * Exported so the caller states the statute rather than the arithmetic, and so the
 * one-year figure lives beside `RECORD_REDACTION_YEARS` instead of in a handler.
 */
export function preservationExpiry(now: Date = new Date()): Date {
	const out = new Date(now);
	out.setUTCFullYear(out.getUTCFullYear() + PRESERVATION_HOLD_YEARS);
	return out;
}

export interface PlaceHoldInput {
	subjectType: HoldSubjectType;
	subjectId: number;
	/** Never blank — a hold nobody can explain is indistinguishable from a bug. */
	reason: string;
	/** Null for a hold placed by a job rather than a person. */
	placedBy?: number | null;
	/** Null means indefinite, which is what a live suit gets. */
	expiresAt?: Date | null;
	note?: string;
}

/** Place a hold. Returns its id. Placing a second hold on the same subject is fine — both must lift. */
export async function placeHold(input: PlaceHoldInput): Promise<{ holdId: number }> {
	const reason = input.reason.trim();
	if (!reason) throw new Error("A legal hold must carry a reason.");
	const [row] = await db
		.insert(legalHolds)
		.values({
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			reason,
			placedBy: input.placedBy ?? null,
			expiresAt: input.expiresAt ?? null,
			note: input.note ?? "",
		})
		.returning({ id: legalHolds.id });
	return { holdId: row.id };
}

/**
 * Lift a hold by stamping it, never by removing it.
 *
 * Returns false for a hold that does not exist or was already lifted, so a double
 * lift is a no-op rather than a second, later `liftedAt` that rewrites when the
 * preservation actually ended.
 */
export async function liftHold(holdId: number): Promise<boolean> {
	const rows = await db
		.update(legalHolds)
		.set({ liftedAt: new Date() })
		.where(and(eq(legalHolds.id, holdId), isNull(legalHolds.liftedAt)))
		.returning({ id: legalHolds.id });
	return rows.length > 0;
}

/** A hold is active when nobody has lifted it and its own clock has not run out. */
function activeAt(now: Date) {
	return and(
		isNull(legalHolds.liftedAt),
		or(isNull(legalHolds.expiresAt), gt(legalHolds.expiresAt, now)),
	);
}

/** Is this subject under an active hold right now? The question every sweep asks. */
export async function isUnderHold(
	subjectType: HoldSubjectType,
	subjectId: number,
	now: Date = new Date(),
): Promise<boolean> {
	const [row] = await db
		.select({ id: legalHolds.id })
		.from(legalHolds)
		.where(
			and(
				eq(legalHolds.subjectType, subjectType),
				eq(legalHolds.subjectId, subjectId),
				activeAt(now),
			),
		)
		.limit(1);
	return Boolean(row);
}

/**
 * Which of these subjects are held — one query for a sweep that processes many.
 *
 * A per-row `isUnderHold` inside a sweep is a query per row, and the sweeps this
 * serves run over every expired session on the platform.
 */
export async function heldSubjectIds(
	subjectType: HoldSubjectType,
	subjectIds: number[],
	now: Date = new Date(),
): Promise<Set<number>> {
	if (subjectIds.length === 0) return new Set();
	const rows = await db
		.select({ subjectId: legalHolds.subjectId })
		.from(legalHolds)
		.where(
			and(
				eq(legalHolds.subjectType, subjectType),
				inArray(legalHolds.subjectId, subjectIds),
				activeAt(now),
			),
		);
	return new Set(rows.map((r) => r.subjectId));
}

/** Every subject of a kind that is currently held. For sweeps that filter rather than enumerate. */
export async function allHeldSubjectIds(
	subjectType: HoldSubjectType,
	now: Date = new Date(),
): Promise<number[]> {
	const rows = await db
		.select({ subjectId: legalHolds.subjectId })
		.from(legalHolds)
		.where(and(eq(legalHolds.subjectType, subjectType), activeAt(now)));
	return [...new Set(rows.map((r) => r.subjectId))];
}

/**
 * What a subject id actually points at, in words an operator can check.
 *
 * 🚨 **A hold on an id that names nothing preserves nothing, and looks identical to one
 * that works.** Nothing in `placeHold` can tell the difference — a subject id is an
 * integer and every integer is accepted — so the check has to happen where a human types
 * one. Returning the label rather than a boolean is deliberate: *"user 41 — cormorant"*
 * lets somebody notice they preserved the wrong account, which a green tick would not.
 *
 * Null means no such row, and the caller should refuse rather than write the hold.
 */
export async function describeSubject(
	subjectType: HoldSubjectType,
	subjectId: number,
): Promise<string | null> {
	if (!Number.isInteger(subjectId) || subjectId <= 0) return null;
	switch (subjectType) {
		case "user": {
			const [row] = await db
				.select({ username: users.username })
				.from(users)
				.where(eq(users.id, subjectId))
				.limit(1);
			return row ? `@${row.username}` : null;
		}
		case "work": {
			const [row] = await db
				.select({ title: works.title })
				.from(works)
				.where(eq(works.id, subjectId))
				.limit(1);
			return row ? (row.title ?? `Work ${subjectId}`) : null;
		}
		case "report": {
			const [row] = await db
				.select({ id: moderationReports.id })
				.from(moderationReports)
				.where(eq(moderationReports.id, subjectId))
				.limit(1);
			return row ? `Moderation report #${subjectId}` : null;
		}
		case "abuse_report": {
			const [row] = await db
				.select({ url: abuseReports.url })
				.from(abuseReports)
				.where(eq(abuseReports.id, subjectId))
				.limit(1);
			return row ? `Abuse report #${subjectId} — ${row.url}` : null;
		}
	}
}

/** A hold, as the operator console shows it. `state` is derived; the row has no such column. */
export interface HoldListing {
	id: number;
	subjectType: HoldSubjectType;
	subjectId: number;
	subjectLabel: string | null;
	reason: string;
	note: string;
	placedBy: string | null;
	placedAt: string;
	expiresAt: string | null;
	liftedAt: string | null;
	state: "active" | "lifted" | "expired";
}

/**
 * Every hold ever placed, newest first, with the lifted and expired ones included.
 *
 * 🚨 **Filtering this to active holds would destroy the thing the table is for.** A lifted
 * hold is the record that something was preserved, for how long, and on whose say-so, and
 * the question *"why did this survive the sweep?"* is asked years after the hold stops
 * applying. `liftHold` stamps rather than deletes for the same reason; a list that hid the
 * stamped rows would undo that at the only place anybody looks.
 */
export async function loadHolds(now: Date = new Date()): Promise<HoldListing[]> {
	const rows = await db
		.select({
			id: legalHolds.id,
			subjectType: legalHolds.subjectType,
			subjectId: legalHolds.subjectId,
			reason: legalHolds.reason,
			note: legalHolds.note,
			placedBy: users.username,
			placedAt: legalHolds.placedAt,
			expiresAt: legalHolds.expiresAt,
			liftedAt: legalHolds.liftedAt,
		})
		.from(legalHolds)
		.leftJoin(users, eq(users.id, legalHolds.placedBy))
		.orderBy(desc(legalHolds.placedAt));

	return Promise.all(
		rows.map(async (row) => {
			const subjectType = row.subjectType as HoldSubjectType;
			return {
				id: row.id,
				subjectType,
				subjectId: row.subjectId,
				subjectLabel: await describeSubject(subjectType, row.subjectId),
				reason: row.reason,
				note: row.note,
				placedBy: row.placedBy,
				placedAt: row.placedAt.toISOString(),
				expiresAt: row.expiresAt?.toISOString() ?? null,
				liftedAt: row.liftedAt?.toISOString() ?? null,
				state: row.liftedAt
					? "lifted"
					: row.expiresAt && row.expiresAt <= now
						? "expired"
						: "active",
			} satisfies HoldListing;
		}),
	);
}
