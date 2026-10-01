// SPDX-License-Identifier: Apache-2.0
/**
 * Deadlines — the one place every obligation with a date on it is gathered into one shape.
 *
 * The 2026-09-14 decision is that anything with a deadline reaches the operator by email and is
 * acted on in the admin app. This module is the shared half of that decision: it unifies the
 * recorded deadlines in the database (data-rights requests, DMCA windows, legal-hold expiries)
 * with the transcribed Compliance Calendar (`@anthers/shared/compliance-calendar`), so that the
 * worker's reminder sweep and the admin home's deadline list render **one** answer to "what is
 * owed, and when" rather than each carrying its own.
 *
 * **One service module is the only reader of its records' deadline shape** — the same invariant the
 * other services hold for their writes. `routes/admin.ts`'s deadlines endpoint and the
 * `deadline-reminders` job both call `gatherDeadlines`; nothing else re-derives a due date or
 * decides which rows count, because two derivations of "what is a deadline" is how one of them
 * quietly drops a source.
 *
 * ⚠️ **Not every obligation is here, and the absences are named rather than silent.** Three kinds
 * of deadline join later, each because its mechanism does not exist yet:
 * - **Sales-tax filing periods** — the frequency does not exist until the Department of Revenue
 *   assigns one at licensing, and the Calendar's § Running section is explicit that it cannot be
 *   dated yet.
 * - **Out-of-state threshold triggers** — a *derived* deadline: each state is measured over its own
 *   window and starts its own registration clock once crossed, and nothing is measured until
 *   checkout records a buyer's location.
 * - **The collect-and-pay-out items** — settlement and transfer runs, failing renewals, balances
 *   nearing Stripe's two-year limit, dispute flags, and a contested dispute's evidence deadline.
 * `DEFERRED_DEADLINE_SOURCES` carries these as data, so the endpoint's response says what is
 * missing rather than omitting it quietly.
 */

import { db } from "@anthers/db/client";
import { dmcaNotices, legalHolds, rightsRequests } from "@anthers/db/schema";
import { type CalendarDeadline, calendarDeadlines } from "@anthers/shared/compliance-calendar";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

/** Where a deadline came from. The calendar is the only source with terminal items. */
export type DeadlineSource =
	| "rights-request"
	| "dmca-counter-notice"
	| "dmca-restore"
	| "legal-hold"
	| "compliance-calendar";

/** A deadline the operator owes an action on (or a decision about), in the shape every reader uses. */
export interface DeadlineItem {
	source: DeadlineSource;
	/**
	 * Stable natural key for the item, `<source>:<id>` — a calendar instance carries its date too,
	 * `<source>:<id>:<instance>`, because next year's instance is a different deadline.
	 */
	key: string;
	title: string;
	/** When it is due — a window's closing date. */
	dueAt: Date;
	/** When a window opens, or null where there is no window. */
	windowStart: Date | null;
	/**
	 * The Calendar's two-reminder rule applies to exactly the three terminal misses. Database
	 * sources are never terminal: their misses are broken promises and statutory exposure, not
	 * the dissolution, lost safe harbor and revocation the Calendar's rule is about.
	 */
	terminal: boolean;
	/** What missing it costs, in the source document's own words — plain, not softened. */
	consequence: string;
	/**
	 * The admin app path where it is handled, or null where none exists. Calendar items carry
	 * null on purpose: there is no admin screen for a filing yet, and an invented route is a
	 * reference nothing can follow.
	 */
	actUrl: string | null;
	/** The source document's own note where the row carries one. */
	note: string | null;
	/** The Calendar's uncertainty marks, preserved rather than softened. */
	unconfirmed?: boolean;
	selfImposed?: boolean;
	condition?: string;
}

/** The deadline sources that join once their mechanisms exist, named so their absence is visible. */
export const DEFERRED_DEADLINE_SOURCES: readonly { id: string; note: string }[] = [
	{
		id: "sales-tax-filing-periods",
		note: "Sales-tax filing periods. The frequency does not exist until the Department of Revenue assigns one at licensing, so there is nothing to date yet.",
	},
	{
		id: "out-of-state-thresholds",
		note: "Out-of-state sales-tax threshold triggers. A derived deadline rather than a recorded one: each state is measured over its own window and starts its own registration clock once crossed, and nothing is measured until checkout records a buyer's location.",
	},
	{
		id: "collect-and-pay-out",
		note: "Settlement and transfer runs, failing renewals, balances nearing Stripe's two-year limit, dispute flags, and a contested dispute's evidence deadline. These join once their mechanisms exist.",
	},
];

/**
 * A date as a person reads it, in UTC so the server's zone never shifts it by a day.
 */
export function longDeadlineDate(date: Date): string {
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
}

/**
 * Every upcoming and past-due deadline, gathered from all sources.
 *
 * ⚠️ **Nothing is filtered by horizon** — a deadline is included whether it is a week or three
 * years out, because the calendar's nearest obligation is what tells the operator how quiet the
 * queue is, and a list that only shows the next 30 days would make the far ones invisible until
 * they are near. Sorting and any horizon are the caller's.
 */
export async function gatherDeadlines(now: Date): Promise<DeadlineItem[]> {
	const [requests, notices, holds, calendar] = await Promise.all([
		db
			.select({
				id: rightsRequests.id,
				kind: rightsRequests.kind,
				dueAt: rightsRequests.dueAt,
			})
			.from(rightsRequests)
			// Only `open` rows are deadline items — a resolved request is done, and showing it
			// here would put finished work in front of the operator as though it still owed
			// something.
			.where(eq(rightsRequests.status, "open")),
		db
			.select({
				id: dmcaNotices.id,
				workTitle: dmcaNotices.workTitle,
				status: dmcaNotices.status,
				counterNoticeDueBy: dmcaNotices.counterNoticeDueBy,
				restoreNoEarlierThan: dmcaNotices.restoreNoEarlierThan,
				finalizedAt: dmcaNotices.finalizedAt,
				suitFiledAt: dmcaNotices.suitFiledAt,
			})
			.from(dmcaNotices)
			// Both windows in one read; the split is below, where each notice's state decides
			// which window — if any — is open.
			.where(
				and(
					isNotNull(dmcaNotices.counterNoticeDueBy),
					eq(dmcaNotices.status, "actioned"),
					// A finalized notice has settled its money and its answer window is over —
					// `finalizeNotice` stamps `finalizedAt` without changing the status, so the
					// status filter alone would keep a settled notice here for ever. Nothing is
					// left to act on: the takedown is final, and a late counter-notice goes
					// through the DMCA screen, not a deadline.
					isNull(dmcaNotices.finalizedAt),
				),
			),
		db
			.select({
				id: legalHolds.id,
				subjectType: legalHolds.subjectType,
				subjectId: legalHolds.subjectId,
				reason: legalHolds.reason,
				expiresAt: legalHolds.expiresAt,
			})
			.from(legalHolds)
			// A lifted hold is done — `liftedAt` is what makes it inactive, and it has no decision
			// left to make. An indefinite hold (`expiresAt` null) is lifted by hand, which is a
			// decision made when it is made, never a deadline.
			.where(and(isNull(legalHolds.liftedAt), isNotNull(legalHolds.expiresAt))),
		Promise.resolve(calendarDeadlines(now)),
	]);

	const out: DeadlineItem[] = [];

	// ── Data-rights requests ───────────────────────────────────────────────────
	// The 30-day window the Privacy Policy promises. `dueAt` is stamped at creation, so it is
	// read rather than computed — the commitment is fixed at the moment it was made.
	for (const r of requests) {
		out.push({
			source: "rights-request",
			key: `rights-request:${r.id}`,
			title: `Data-rights request #${r.id} (${r.kind}) is due a response`,
			dueAt: r.dueAt,
			windowStart: null,
			terminal: false,
			consequence:
				"The Privacy Policy promises an answer within 30 days of the request. A request past its window is a promise not kept, made to whoever asked what Anthers holds about them.",
			actUrl: "/legal/rights-requests",
			note: null,
		});
	}

	// ── DMCA windows ───────────────────────────────────────────────────────────
	for (const n of notices) {
		// The counter-notice window: open from takedown until the window closes with no answer.
		// A notice that was counter-noticed has left this state (the read above selects
		// `actioned` only), so every row here has an open counter-notice window — including one
		// whose closing date has passed but that the finality sweep has not settled yet, which
		// is what a past-due flag on it is for.
		if (n.counterNoticeDueBy) {
			out.push({
				source: "dmca-counter-notice",
				key: `dmca-counter-notice:${n.id}`,
				title: `DMCA notice #${n.id}${n.workTitle ? ` (${n.workTitle})` : ""}: the counter-notice window closes`,
				dueAt: n.counterNoticeDueBy,
				windowStart: null,
				terminal: false,
				consequence:
					"When the window closes with no counter-notice, the takedown becomes final and every buyer is refunded. A counter-notice filed later still restores the Work — the window governs when the sale is settled, never whether the creator may answer.",
				actUrl: "/legal/dmca",
				note: null,
			});
		}
	}

	// The restore window is a separate read, because its lifecycle is separate: a counter-noticed
	// notice is not `actioned`, so the read above cannot see it.
	const counterNoticed = await db
		.select({
			id: dmcaNotices.id,
			workTitle: dmcaNotices.workTitle,
			restoreNoEarlierThan: dmcaNotices.restoreNoEarlierThan,
		})
		.from(dmcaNotices)
		// A suit filing is the one thing that stops a restore, and it stops the deadline too —
		// § 512(g)(2)(C) keeps the Work down for the duration of the action, so there is nothing
		// to remind about until the suit resolves and the operator restores by hand.
		.where(and(eq(dmcaNotices.status, "counter_noticed"), isNull(dmcaNotices.suitFiledAt)));

	for (const n of counterNoticed) {
		if (!n.restoreNoEarlierThan) continue;
		out.push({
			source: "dmca-restore",
			key: `dmca-restore:${n.id}`,
			title: `DMCA notice #${n.id}${n.workTitle ? ` (${n.workTitle})` : ""}: the restore window opens`,
			dueAt: n.restoreNoEarlierThan,
			windowStart: null,
			terminal: false,
			consequence:
				"§ 512(g)(2)(C): once the window opens the Work must be restored unless the complainant recorded a court action. Restoring late is the cheaper of the two ways to be late, but it is still a statutory obligation nothing else performs by hand.",
			actUrl: "/legal/dmca",
			note: null,
		});
	}

	// ── Legal-hold expiries ────────────────────────────────────────────────────
	for (const h of holds) {
		out.push({
			source: "legal-hold",
			key: `legal-hold:${h.id}`,
			title: `Legal hold #${h.id} on ${h.subjectType} ${h.subjectId} expires`,
			dueAt: h.expiresAt as Date,
			windowStart: null,
			terminal: false,
			consequence:
				"When a hold expires, automated destruction of what it names resumes. An expiry approaching means a decision: extend the hold, or let it lapse.",
			actUrl: "/legal/holds",
			note: h.reason,
		});
	}

	// ── The Compliance Calendar ─────────────────────────────────────────────────
	for (const c of calendar as CalendarDeadline[]) {
		out.push({
			source: "compliance-calendar",
			key: `compliance-calendar:${c.id}:${c.instance}`,
			title: c.title,
			dueAt: c.dueAt,
			windowStart: c.windowStart,
			terminal: c.terminal,
			consequence: c.consequence,
			// There is no admin screen for a filing yet. Null rather than an invented route: a
			// URL the server hands somebody is a route reference nothing can follow.
			actUrl: null,
			note: c.note ?? null,
			unconfirmed: c.unconfirmed,
			selfImposed: c.selfImposed,
			condition: c.condition,
		});
	}

	return out;
}

/**
 * Deadline urgency: past due first (most overdue at the top), then nearest upcoming.
 *
 * A past-due deadline is owed more urgently than any future one however far out the future one is,
 * which is why the two halves sort separately rather than one ascending sort — a plain date sort
 * would bury a missed filing under next decade's.
 */
export function sortDeadlines(items: DeadlineItem[], now: Date): DeadlineItem[] {
	return [...items].sort((a, b) => {
		const aPast = a.dueAt.getTime() <= now.getTime();
		const bPast = b.dueAt.getTime() <= now.getTime();
		if (aPast !== bPast) return aPast ? -1 : 1;
		return a.dueAt.getTime() - b.dueAt.getTime();
	});
}

/** Whether a deadline is past due at `now`. Computed here rather than stored so it cannot go stale. */
export function isPastDue(item: DeadlineItem, now: Date): boolean {
	return item.dueAt.getTime() <= now.getTime();
}
